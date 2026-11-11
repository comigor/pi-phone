import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionKey } from "./protocol.js";
import { isVisibleMessage } from "./visible-messages.js";

const MAX_INBOX_ITEMS = 500;

function cleanMessages(messages) {
  return Array.isArray(messages) ? messages : [];
}

function excerpt(value, length = 500) {
  return typeof value === "string" ? value.slice(0, length) : "";
}

function presentation(session) {
  return JSON.stringify([session.online === true, session.status || "idle", session.cwd || "", session.name || "", session.model || "", session.thinkingLevel || ""]);
}

export class InboxStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, "state.json");
    this.writeVersion = 0;
    this.writtenVersion = 0;
    this.state = { version: 1, hosts: [], sessions: [], inbox: [], subscriptions: [], launchIdempotency: [] };
    this.sessionChanges = new Map();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (saved.version === 1) this.state = { ...this.state, ...saved };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.state.launchIdempotency = Array.isArray(this.state.launchIdempotency) ? this.state.launchIdempotency : [];
    for (const host of this.state.hosts) host.online = false;
    for (const session of this.state.sessions) {
      session.online = false;
      for (const message of session.messages) message.createdAt ??= session.createdAt || session.updatedAt;
    }
    this.state.subscriptions = this.state.subscriptions.filter((item) => item && typeof item.endpoint === "string");
  }

  scheduleWrite() {
    if (!this.writePending) {
      this.writePending = (async () => {
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const version = this.writeVersion;
          const temporary = `${this.stateFile}.${process.pid}.tmp`;
          await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
          await rename(temporary, this.stateFile);
          this.writtenVersion = version;
        } finally {
          this.writePending = undefined;
        }
      })();
    }
    return this.writePending;
  }

  async persist() {
    const version = ++this.writeVersion;
    while (this.writtenVersion < version) await this.scheduleWrite();
  }

  async flush() {
    while (this.writtenVersion < this.writeVersion) await this.scheduleWrite();
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

  sessionChange(key) {
    return this.sessionChanges.get(key) || { message: false, presentation: false };
  }

  recordSessionChange(key, session, previousMessages, previousPresentation, previousUpdatedAt, changedAt) {
    const message = previousMessages !== JSON.stringify(session.messages.filter(isVisibleMessage));
    const presentationChanged = previousPresentation !== presentation(session);
    this.sessionChanges.set(key, { message, presentation: presentationChanged });
    if (message || presentationChanged) session.visibleUpdatedAt = changedAt;
    else session.visibleUpdatedAt ??= previousUpdatedAt;
    return message || presentationChanged;
  }

  async upsertSession(hostId, incoming) {
    const key = sessionKey(hostId, incoming.sessionId);
    let session = this.state.sessions.find((item) => item.key === key);
    if (!session) {
      session = { key, hostId, sessionId: incoming.sessionId, generation: incoming.generation, messages: [], remoteReplies: [], virtualCursor: 0 };
      this.state.sessions.push(session);
    }
    const previousVisible = JSON.stringify(session.messages.filter(isVisibleMessage));
    const previousPresentation = presentation(session);
    const previousUpdatedAt = session.updatedAt;
    const previousMessages = new Map(session.messages.map((message) => [message.id, message]));
    const arrivedAt = new Date().toISOString();
    const nextMessages = cleanMessages(incoming.messages).map((message) => ({ ...message, createdAt: message.createdAt || previousMessages.get(message.id)?.createdAt || arrivedAt }));
    const messagesChanged = JSON.stringify(session.messages) !== JSON.stringify(nextMessages);
    Object.assign(session, {
      generation: incoming.generation,
      cwd: excerpt(incoming.cwd, 2048),
      name: excerpt(incoming.name, 200),
      model: excerpt(incoming.model, 200),
      thinkingLevel: excerpt(incoming.thinkingLevel, 40),
      status: excerpt(incoming.status, 40) || "idle",
      messages: nextMessages,
      online: true,
      updatedAt: arrivedAt
    });
    const visibleChanged = this.recordSessionChange(key, session, previousVisible, previousPresentation, previousUpdatedAt, arrivedAt);
    if (messagesChanged && session.resolvedAt && nextMessages.at(-1)?.role === "assistant") {
      session.resolvedAt = null;
      session.backFromArchive = true;
    }
    session.remoteReplies ??= [];
    session.virtualCursor = (session.virtualCursor ?? 0) + (visibleChanged || messagesChanged ? 1 : 0);
    await this.persist();
    return session;
  }

  async patchSession(hostId, incoming) {
    const key = sessionKey(hostId, incoming.sessionId);
    const session = this.getSession(key);
    if (!session) return undefined;
    const previousVisible = JSON.stringify(session.messages.filter(isVisibleMessage));
    const previousPresentation = presentation(session);
    const previousUpdatedAt = session.updatedAt;
    let messagesChanged = false;
    for (const next of cleanMessages(incoming.messages)) {
      const index = session.messages.findIndex((message) => message.id === next.id);
      next.createdAt ??= session.messages[index]?.createdAt || new Date().toISOString();
      if (index < 0) {
        session.messages.push(next);
        messagesChanged = true;
      } else if (JSON.stringify(session.messages[index]) !== JSON.stringify(next)) {
        session.messages[index] = next;
        messagesChanged = true;
      }
    }
    const changedAt = new Date().toISOString();
    Object.assign(session, {
      generation: incoming.generation,
      cwd: excerpt(incoming.cwd, 2048),
      name: excerpt(incoming.name, 200),
      model: excerpt(incoming.model, 200),
      thinkingLevel: excerpt(incoming.thinkingLevel, 40),
      status: excerpt(incoming.status, 40) || "idle",
      online: true,
      updatedAt: changedAt
    });
    const visibleChanged = this.recordSessionChange(key, session, previousVisible, previousPresentation, previousUpdatedAt, changedAt);
    if (messagesChanged && session.resolvedAt && session.messages.at(-1)?.role === "assistant") {
      session.resolvedAt = null;
      session.backFromArchive = true;
    }
    session.virtualCursor = (session.virtualCursor ?? 0) + (visibleChanged || messagesChanged ? 1 : 0);
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

  async queueRemoteReply(key, pending) {
    const session = this.getSession(key);
    if (!session) throw new Error("Unknown session");
    session.pendingReplies ??= [];
    const previous = session.pendingReplies.find((reply) => reply.requestId === pending.requestId);
    if (previous) return { session, pending: previous, replayed: true };
    const queued = { ...pending, queuedAt: new Date().toISOString() };
    session.pendingReplies.push(queued);
    session.virtualCursor = (session.virtualCursor ?? 0) + 1;
    await this.persist();
    return { session, pending: queued, replayed: false };
  }

  async completeRemoteReply(key, requestId) {
    const session = this.getSession(key);
    if (!session) return;
    session.pendingReplies = (session.pendingReplies || []).filter((reply) => reply.requestId !== requestId);
    await this.persist();
  }

  async updateVirtualSession(key, update) {
    const session = this.getSession(key);
    if (!session) throw new Error("Unknown session");
    Object.assign(session, update);
    session.virtualCursor = (session.virtualCursor ?? 0) + 1;
    await this.persist();
    return session;
  }

  getLaunchIdempotency(hostId, key) {
    return this.state.launchIdempotency.find((entry) => entry.hostId === hostId && entry.key === key);
  }

  async recordLaunchIdempotency(entry) {
    this.state.launchIdempotency = this.state.launchIdempotency.filter((item) => !(item.hostId === entry.hostId && item.key === entry.key));
    this.state.launchIdempotency.push({ ...entry, createdAt: new Date().toISOString() });
    if (this.state.launchIdempotency.length > 256) this.state.launchIdempotency.splice(0, this.state.launchIdempotency.length - 256);
    await this.persist();
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
