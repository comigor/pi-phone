import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionKey } from "./protocol.js";

const MAX_MESSAGES = 300;
const MAX_INBOX_ITEMS = 500;

function cleanMessages(messages) {
  return Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
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
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    return this.writeQueue;
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

  async upsertSession(hostId, incoming) {
    const key = sessionKey(hostId, incoming.sessionId);
    let session = this.state.sessions.find((item) => item.key === key);
    if (!session) {
      session = { key, hostId, sessionId: incoming.sessionId, generation: incoming.generation, messages: [] };
      this.state.sessions.push(session);
    }
    Object.assign(session, {
      generation: incoming.generation,
      cwd: excerpt(incoming.cwd, 2048),
      name: excerpt(incoming.name, 200),
      model: excerpt(incoming.model, 200),
      thinkingLevel: excerpt(incoming.thinkingLevel, 40),
      status: excerpt(incoming.status, 40) || "idle",
      messages: cleanMessages(incoming.messages),
      online: true,
      updatedAt: new Date().toISOString()
    });
    await this.persist();
    return session;
  }

  getSession(key) {
    return this.state.sessions.find((item) => item.key === key);
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
      sessions: this.state.sessions.map(({ messages, ...session }) => ({ ...session, messageCount: messages.length })),
      inbox: this.state.inbox
    };
  }
}
