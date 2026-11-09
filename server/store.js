import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionKey } from "./protocol.js";

const MAX_INBOX_ITEMS = 500;

function cleanMessages(messages) {
  return Array.isArray(messages) ? messages : [];
}

function excerpt(value, length = 500) {
  return typeof value === "string" ? value.slice(0, length) : "";
}

export class InboxStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, "state.json");
    this.writeQueue = Promise.resolve();
    this.state = { version: 1, hosts: [], sessions: [], inbox: [], subscriptions: [] };
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (saved.version === 1) this.state = { ...this.state, ...saved };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const host of this.state.hosts) host.online = false;
    for (const session of this.state.sessions) session.online = false;
    this.state.subscriptions = this.state.subscriptions.filter((item) => item && typeof item.endpoint === "string");
  }

  async persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    return this.writeQueue;
  }

  async flush() {
    await this.writeQueue;
  }

  async challengeHost({ hostId, publicKey, name }) {
    let host = this.state.hosts.find((item) => item.id === hostId);
    if (host?.paired && host.publicKey !== publicKey) throw new Error("Host identity changed; revoke and pair it again");
    if (host && !host.paired && host.publicKey !== publicKey) {
      host.publicKey = publicKey;
      host.name = excerpt(name, 120) || hostId;
      await this.persist();
    }
    if (!host) {
      host = {
        id: hostId,
        name: excerpt(name, 120) || hostId,
        publicKey,
        pairingCode: randomBytes(4).toString("hex").toUpperCase(),
        paired: false,
        online: false,
        createdAt: new Date().toISOString()
      };
      this.state.hosts.push(host);
      await this.persist();
    }
    return host;
  }

  getHost(hostId) {
    return this.state.hosts.find((item) => item.id === hostId);
  }

  async approveHost(hostId) {
    const host = this.getHost(hostId);
    if (!host) throw new Error("Unknown host");
    host.paired = true;
    host.pairedAt = new Date().toISOString();
    delete host.pairingCode;
    await this.persist();
    return host;
  }

  async revokeHost(hostId) {
    const host = this.getHost(hostId);
    if (!host) return;
    host.paired = false;
    host.online = false;
    host.pairingCode = randomBytes(4).toString("hex").toUpperCase();
    for (const session of this.state.sessions.filter((item) => item.hostId === hostId)) session.online = false;
    await this.persist();
  }

  async setHostOnline(hostId, online) {
    const host = this.getHost(hostId);
    if (!host) return;
    host.online = online;
    host.lastSeenAt = new Date().toISOString();
    if (!online) {
      for (const session of this.state.sessions.filter((item) => item.hostId === hostId)) session.online = false;
    }
    await this.persist();
  }

  async setSessionOffline(key, generation) {
    const session = this.getSession(key);
    if (!session || session.generation !== generation || !session.online) return;
    session.online = false;
    await this.persist();
  }

  async upsertSession(hostId, incoming) {
    const key = sessionKey(hostId, incoming.sessionId);
    let session = this.state.sessions.find((item) => item.key === key);
    if (!session) {
      session = { key, hostId, sessionId: incoming.sessionId, generation: incoming.generation, messages: [], remoteReplies: [], virtualCursor: 0 };
      this.state.sessions.push(session);
    }
    const nextMessages = cleanMessages(incoming.messages);
    const changed = session.status !== (incoming.status || "idle") || JSON.stringify(session.messages) !== JSON.stringify(nextMessages);
    Object.assign(session, {
      generation: incoming.generation,
      cwd: excerpt(incoming.cwd, 2048),
      name: excerpt(incoming.name, 200),
      model: excerpt(incoming.model, 200),
      thinkingLevel: excerpt(incoming.thinkingLevel, 40),
      status: excerpt(incoming.status, 40) || "idle",
      messages: nextMessages,
      online: true,
      updatedAt: new Date().toISOString()
    });
    session.remoteReplies ??= [];
    session.virtualCursor = (session.virtualCursor ?? 0) + (changed ? 1 : 0);
    await this.persist();
    return session;
  }

  async patchSession(hostId, incoming) {
    const key = sessionKey(hostId, incoming.sessionId);
    const session = this.getSession(key);
    if (!session) return undefined;
    let changed = session.status !== (incoming.status || "idle");
    for (const next of cleanMessages(incoming.messages)) {
      const index = session.messages.findIndex((message) => message.id === next.id);
      if (index < 0) {
        session.messages.push(next);
        changed = true;
      } else if (JSON.stringify(session.messages[index]) !== JSON.stringify(next)) {
        session.messages[index] = next;
        changed = true;
      }
    }
    Object.assign(session, {
      generation: incoming.generation,
      cwd: excerpt(incoming.cwd, 2048),
      name: excerpt(incoming.name, 200),
      model: excerpt(incoming.model, 200),
      thinkingLevel: excerpt(incoming.thinkingLevel, 40),
      status: excerpt(incoming.status, 40) || "idle",
      online: true,
      updatedAt: new Date().toISOString()
    });
    session.virtualCursor = (session.virtualCursor ?? 0) + (changed ? 1 : 0);
    await this.persist();
    return session;
  }

  getSession(key) {
    return this.state.sessions.find((item) => item.key === key);
  }

  async appendRemoteReply(key, { requestId, text, attachments = [] }) {
    const session = this.getSession(key);
    if (!session) throw new Error("Unknown session");
    session.remoteReplies ??= [];
    const previous = session.remoteReplies.find((message) => message.requestId === requestId);
    if (previous) return { session, message: previous, replayed: true };
    const message = { id: `relay:${requestId}`, requestId, role: "user", text, attachments, createdAt: new Date().toISOString() };
    session.remoteReplies.push(message);
    session.virtualCursor = (session.virtualCursor ?? 0) + 1;
    await this.persist();
    return { session, message, replayed: false };
  }

  async updateVirtualSession(key, update) {
    const session = this.getSession(key);
    if (!session) throw new Error("Unknown session");
    Object.assign(session, update);
    session.virtualCursor = (session.virtualCursor ?? 0) + 1;
    await this.persist();
    return session;
  }

  async addInbox({ hostId, session, runId, kind, title, body }) {
    const id = `${session.key}:${runId}`;
    const existing = this.state.inbox.find((item) => item.id === id);
    if (existing) return { item: existing, created: false };
    const item = {
      id,
      hostId,
      sessionKey: session.key,
      generation: session.generation,
      kind,
      title: excerpt(title, 200) || "Agent is waiting",
      body: excerpt(body, 4000),
      project: session.name || path.basename(session.cwd) || session.sessionId,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    this.state.inbox.unshift(item);
    this.state.inbox = this.state.inbox.slice(0, MAX_INBOX_ITEMS);
    await this.persist();
    return { item, created: true };
  }

  async resolveSessionInbox(key) {
    const resolvedAt = new Date().toISOString();
    for (const item of this.state.inbox.filter((entry) => entry.sessionKey === key && entry.status === "pending")) {
      item.status = "answered";
      item.resolvedAt = resolvedAt;
    }
    await this.persist();
  }

  async resolvePrompt(key) {
    for (const item of this.state.inbox.filter((entry) => entry.sessionKey === key && entry.kind === "question" && entry.status === "pending")) {
      item.status = "answered";
      item.resolvedAt = new Date().toISOString();
    }
    await this.persist();
  }

  async dismissInbox(id) {
    const item = this.state.inbox.find((entry) => entry.id === id);
    if (!item) throw new Error("Unknown inbox item");
    item.status = "dismissed";
    item.resolvedAt = new Date().toISOString();
    await this.persist();
  }

  async addSubscription(subscription) {
    const id = randomUUID();
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.endpoint !== subscription.endpoint);
    this.state.subscriptions.push({ id, endpoint: subscription.endpoint, keys: subscription.keys, createdAt: new Date().toISOString() });
    await this.persist();
    return id;
  }

  async removeSubscription(endpoint) {
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.endpoint !== endpoint);
    await this.persist();
  }

  publicState() {
    return {
      hosts: this.state.hosts.map((host) => ({ ...host, publicKey: undefined })),
      sessions: this.state.sessions.map(({ messages, remoteReplies, ...session }) => ({ ...session, messageCount: messages.length + (remoteReplies?.length ?? 0) })),
      inbox: this.state.inbox
    };
  }
}
