import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { InboxStore } from "./store.js";
import { PushDispatcher } from "./push.js";
import { parseMessage, requireString, verifyAgentSignature } from "./protocol.js";
import { VirtualMachines } from "./virtual-machines.js";
import { PlannotatorRuntime } from "./plannotator.js";
import { DraftStore } from "./drafts.js";
import { mergeSearchAnswers } from "./search.js";
import { HostLaunchCoordinator } from "./host-launch.js";

const PUBLIC_FILES = new Map([
  ["/legacy", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/sw.js", "sw.js"],
  ["/icon.svg", "icon.svg"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 65536) throw new Error("Request too large");
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function socketSend(socket, value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function lastAssistantText(session) {
  const message = [...(session?.messages ?? [])].reverse().find((item) => item.role === "assistant" && item.text);
  return message?.text ?? "Agent is ready for input";
}

export class InboxHub {
  constructor(options) {
    this.publicDir = options.publicDir;
    this.plannotator = options.plannotator;
    this.publicUrl = options.publicUrl;
    this.store = options.store;
    this.drafts = options.drafts;
    this.push = options.push;
    this.agentHeartbeatTimeoutMs = options.agentHeartbeatTimeoutMs ?? 60_000;
    this.agentHeartbeatCheckMs = options.agentHeartbeatCheckMs ?? 10_000;
    this.agents = new Map();
    this.sessionAgents = new Map();
    this.agentClosures = new Map();
    this.viewers = new Set();
    this.pinListeners = new Set();
    this.challenges = new Map();
    this.pendingReplies = new Map();
    this.launch = new HostLaunchCoordinator({ store: this.store, agents: this.agents, sessionAgents: this.sessionAgents });
    this.agentWss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    this.viewerWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.agentHttp = createServer((request, response) => this.handleAgentHttp(request, response));
    this.viewerHttp = createServer((request, response) => this.handleViewerHttp(request, response));
    this.doorHttp = createServer((request, response) => this.virtual.route(request, response).catch((error) => sendJson(response, error.code === "session_offline" ? 503 : 400, { code: error.code || "delivery_failed", error: error.message })));
    this.agentHttp.on("upgrade", (request, socket, head) => this.handleAgentUpgrade(request, socket, head));
    this.viewerHttp.on("upgrade", (request, socket, head) => this.handleViewerUpgrade(request, socket, head));
    this.agentWss.on("connection", (socket, _request, host) => this.handleAgentSocket(socket, host));
    this.viewerWss.on("connection", (socket) => this.handleViewerSocket(socket));
  }

  static async create(options) {
    const store = new InboxStore(options.dataDir);
    const drafts = new DraftStore(options.dataDir);
    await store.load();
    await drafts.load();
    const push = new PushDispatcher(options.dataDir, options.publicUrl, store);
    await push.load();
    const hub = new InboxHub({ ...options, store, push, drafts });
    hub.virtual = new VirtualMachines({
      store,
      drafts,
      dataDir: options.dataDir,
      publicAddress: options.virtualAddress,
      linkMachine: options.linkMachine,
      deliverReply: (input) => hub.deliverReply(input),
      stopSession: (input) => hub.stopSession(input),
      startLaunch: (input) => hub.launch.start(input),
      stopLaunch: (session) => hub.launch.stop(session)
    });
    await hub.virtual.load();
    push.targetFor = (item) => hub.virtual.notificationTarget(item);
    return hub;
  }

  async listen({ viewerPort, agentPort, doorPort, host }) {
    const listeners = [
      new Promise((resolve) => this.viewerHttp.listen(viewerPort, host, resolve)),
      new Promise((resolve) => this.agentHttp.listen(agentPort, host, resolve))
    ];
    if (doorPort !== undefined) listeners.push(new Promise((resolve) => this.doorHttp.listen(doorPort, host, resolve)));
    await Promise.all(listeners);
  }

  addresses() {
    return { viewer: this.viewerHttp.address(), agent: this.agentHttp.address(), door: this.doorHttp.listening ? this.doorHttp.address() : null };
  }

  async close() {
    const serverClosures = [this.agentHttp, this.viewerHttp, this.doorHttp].filter((server) => server.listening).map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    const agents = [...this.agents.values()].flatMap((sockets) => [...sockets]);
    for (const socket of [...agents, ...this.viewers]) socket.terminate();
    await Promise.all([...this.agentClosures.values()]);
    for (const retry of this.virtual.linkRetries.values()) clearTimeout(retry);
    for (const streams of this.virtual.streams.values()) for (const stream of streams) stream.end();
    await Promise.all(serverClosures);
    await this.virtual.flushChanges();
    await Promise.all([this.store.flush(), this.virtual.writeQueue, this.drafts.writeQueue]);
  }

  broadcast(value) {
    for (const viewer of this.viewers) socketSend(viewer, value);
  }

  broadcastState() {
    this.broadcast({ type: "state", ...this.store.publicState() });
  }

  async handleAgentHttp(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/healthz") return sendJson(response, 200, { ok: true });
      if (url.pathname !== "/challenge" || request.method !== "GET") return sendJson(response, 404, { error: "Not found" });
      const hostId = requireString(url.searchParams.get("hostId"), "hostId", 100);
      const publicKey = requireString(url.searchParams.get("publicKey"), "publicKey", 4096);
      const name = requireString(url.searchParams.get("name"), "name", 120);
      const host = await this.store.challengeHost({ hostId, publicKey, name });
      const nonce = randomBytes(32).toString("base64url");
      this.challenges.set(nonce, { hostId, publicKey, expiresAt: Date.now() + 5 * 60_000 });
      return sendJson(response, 200, { nonce, paired: host.paired, pairingCode: host.pairingCode });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  async handleAgentUpgrade(request, socket, head) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/ws") throw new Error("Not found");
      const hostId = requireString(url.searchParams.get("hostId"), "hostId", 100);
      const publicKey = requireString(url.searchParams.get("publicKey"), "publicKey", 4096);
      const nonce = requireString(url.searchParams.get("nonce"), "nonce", 200);
      const signature = requireString(url.searchParams.get("signature"), "signature", 4096);
      const challenge = this.challenges.get(nonce);
      if (!challenge || challenge.hostId !== hostId || challenge.publicKey !== publicKey || challenge.expiresAt < Date.now()) throw new Error("Challenge expired");
      if (!verifyAgentSignature({ hostId, nonce, publicKey, signature })) throw new Error("Invalid signature");
      const host = this.store.getHost(hostId);
      if (!host || host.publicKey !== publicKey) throw new Error("Unknown host");
      this.challenges.delete(nonce);
      this.agentWss.handleUpgrade(request, socket, head, (websocket) => this.agentWss.emit("connection", websocket, request, host));
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  async handleAgentSocket(socket, host) {
    const sockets = this.agents.get(host.id) ?? new Set();
    sockets.add(socket);
    this.agents.set(host.id, sockets);
    let markClosed;
    this.agentClosures.set(socket, new Promise((resolve) => { markClosed = resolve; }));
    let lastSeenAt = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastSeenAt >= this.agentHeartbeatTimeoutMs) socket.terminate();
    }, this.agentHeartbeatCheckMs);
    heartbeat.unref();
    let messageQueue = Promise.resolve();
    socket.on("message", (raw) => {
      lastSeenAt = Date.now();
      messageQueue = messageQueue.then(async () => {
        try {
          const message = parseMessage(raw);
          if (!message) return socketSend(socket, { type: "error", error: "Invalid message" });
          if (!host.paired) return socketSend(socket, { type: "pairing_required", pairingCode: host.pairingCode });
          await this.handleAgentMessage(host, socket, message);
        } catch (error) {
          socketSend(socket, { type: "error", error: error.message });
        }
      });
    });
    socket.on("close", async () => {
      clearInterval(heartbeat);
      await messageQueue;
      try {
        const sockets = this.agents.get(host.id);
        if (!sockets?.delete(socket)) return;
        await this.launch.closed(host, socket);
        for (const [sessionKey, route] of this.sessionAgents) {
          if (route.socket !== socket) continue;
          this.sessionAgents.delete(sessionKey);
          await this.store.setSessionOffline(sessionKey, route.generation);
        }
        if (!sockets.size) {
          this.agents.delete(host.id);
          await this.store.setHostOnline(host.id, false);
          if (!this.agents.has(host.id)) await this.virtual.hostOffline(host.id);
        }
        this.broadcastState();
      } finally {
        this.agentClosures.delete(socket);
        markClosed();
      }
    });
    await this.store.setHostOnline(host.id, true);
    if (host.paired) await this.virtual.ensureLinked(host);
    socketSend(socket, host.paired ? { type: "paired" } : { type: "pairing_required", pairingCode: host.pairingCode });
    this.broadcastState();
  }

  async handleAgentMessage(host, socket, message) {
    if (message.type === "ping") return socketSend(socket, { type: "pong" });
    if (message.type === "host_hello") return this.launch.hello(host, message, socket);
    if (message.type === "launch_result") return this.launch.result(message);
    const sessionId = requireString(message.sessionId, "sessionId", 300);
    const generation = requireString(message.generation, "generation", 100);
    const key = `${host.id}:${sessionId}`;
    if (message.type === "session_upsert" || message.type === "session_patch") {
      requireString(message.session?.generation, "generation", 100);
      if (message.session.generation !== generation || message.session.sessionId !== sessionId) throw new Error("Session identity mismatch");
      if (message.type === "session_upsert" && !this.store.getSession(key) && !message.session.messages?.length && !this.launch.hasPending(host.id, sessionId)) return;
      const session = message.type === "session_patch" ? await this.store.patchSession(host.id, message.session) : await this.store.upsertSession(host.id, message.session);
      if (!session) return socketSend(socket, { type: "session_snapshot_required", sessionId, generation });
      await this.virtual.ensureLinked(host);
      this.sessionAgents.set(key, { socket, generation });
      await this.launch.onSessionUpsert(session);
      void this.virtual.flushReplies(session).catch((error) => console.warn(`Queued replies remain pending for ${session.name || key}: ${error.message}`));
      if (session.status === "running") {
        await this.store.resolveSessionInbox(key);
        this.broadcastState();
      }
      this.broadcast({ type: message.type === "session_patch" ? "session_patch" : "session", session });
      const change = this.store.sessionChange(key);
      if (change.message) {
        const messages = this.virtual.sourceMessagesFor(session);
        const index = messages.length - 1;
        const record = index >= 0 ? { message: this.virtual.cachedVirtualMessage(session, messages[index], index) } : {};
        await this.virtual.changed(session, record);
      } else if (change.presentation) {
        await this.virtual.changed(session, { sessions: true, agents: true }, "deliveries");
      }
      return;
    }
    const session = this.store.getSession(key);
    if (!session || session.generation !== generation) throw new Error("Stale session generation");
    if (message.type === "session_event") {
      this.broadcast({ type: "session_event", sessionKey: key, generation, event: message.event });
      return;
    }
    if (message.type === "agent_settled") {
      if (message.aborted) return;
      const runId = requireString(message.runId, "runId", 100);
      const { item, created } = await this.store.addInbox({
        hostId: host.id,
        session,
        runId,
        kind: "waiting",
        title: "Ready for input",
        body: lastAssistantText(session)
      });
      if (created) await this.push.notify(item);
      this.broadcast({ type: "inbox", item });
      this.broadcastState();
      return;
    }
    if (message.type === "ui_prompt_start") {
      const runId = `prompt:${requireString(message.promptId, "promptId", 100)}`;
      const { item, created } = await this.store.addInbox({
        hostId: host.id,
        session,
        runId,
        kind: "question",
        title: requireString(message.title, "title", 200),
        body: lastAssistantText(session)
      });
      if (created) await this.push.notify(item);
      this.broadcast({ type: "inbox", item });
      this.broadcastState();
      return;
    }
    if (message.type === "ui_prompt_end") {
      await this.store.resolvePrompt(key);
      this.broadcastState();
      return;
    }
    if (message.type === "reply_result" || message.type === "stop_result") {
      const pending = this.pendingReplies.get(message.requestId);
      if (!pending) return;
      this.pendingReplies.delete(message.requestId);
      clearTimeout(pending.timeout);
      if (message.ok) await this.store.resolveSessionInbox(key);
      pending.resolve({ ok: Boolean(message.ok), error: message.error });
      this.broadcastState();
      return;
    }
    throw new Error("Unknown agent message");
  }

  handleViewerUpgrade(request, socket, head) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/ws") return socket.destroy();
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== new URL(this.publicUrl).host) return socket.destroy();
      this.viewerWss.handleUpgrade(request, socket, head, (websocket) => this.viewerWss.emit("connection", websocket, request));
    } catch {
      socket.destroy();
    }
  }

  handleViewerSocket(socket) {
    this.viewers.add(socket);
    socketSend(socket, { type: "state", ...this.store.publicState() });
    socket.on("message", async (raw) => {
      try {
        const message = parseMessage(raw);
        if (!message) return socketSend(socket, { type: "error", error: "Invalid message" });
        if (message.type === "subscribe") {
          const session = this.store.getSession(requireString(message.sessionKey, "sessionKey", 500));
          return socketSend(socket, { type: "session", session });
        }
        if (message.type === "reply") return await this.handleViewerReply(socket, message);
        throw new Error("Unknown viewer message");
      } catch (error) {
        socketSend(socket, { type: "error", error: error.message });
      }
    });
    socket.on("close", () => this.viewers.delete(socket));
  }

  agentRoute(key, generation) {
    const session = this.store.getSession(key);
    if (!session || !session.online) throw Object.assign(new Error("Session is offline"), { code: "session_offline" });
    if (session.generation !== generation) throw Object.assign(new Error("Session changed"), { code: "session_changed" });
    const host = this.store.getHost(session.hostId);
    const route = this.sessionAgents.get(key);
    const agent = route?.generation === generation ? route.socket : undefined;
    if (!host?.paired || !agent || agent.readyState !== WebSocket.OPEN) throw Object.assign(new Error("Session is offline"), { code: "session_offline" });
    return { session, agent };
  }

  requestAgent(key, generation, requestId, message) {
    if (this.pendingReplies.has(requestId)) return Promise.reject(new Error("Duplicate request"));
    const { agent } = this.agentRoute(key, generation);
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        reject(new Error("Delivery result unknown"));
      }, 15_000);
      timeout.unref();
      this.pendingReplies.set(requestId, { resolve, reject, timeout });
    });
    socketSend(agent, message);
    return result.then((result) => {
      if (!result.ok) throw new Error(result.error || "Agent request failed");
      return result;
    });
  }

  async deliverReply({ key, generation, requestId, text, attachments = [] }) {
    requireString(text, "text", 32_000);
    await this.launch.ensureOnline(this.store.getSession(key));
    const current = this.store.getSession(key);
    const effectiveGeneration = current?.online ? current.generation : generation;
    const { session } = this.agentRoute(key, effectiveGeneration);
    return this.requestAgent(key, session.generation, requestId, {
      type: "reply",
      requestId,
      sessionId: session.sessionId,
      generation: session.generation,
      text,
      attachments: attachments.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType || attachment.mime_type || "application/octet-stream",
        data: Buffer.from(attachment.data || "", attachment.data instanceof Buffer ? undefined : "base64").toString("base64")
      }))
    });
  }

  stopSession({ key, generation, requestId }) {
    const { session } = this.agentRoute(key, generation);
    return this.requestAgent(key, generation, requestId, { type: "stop", requestId, sessionId: session.sessionId, generation });
  }

  async handleViewerReply(viewer, message) {
    const key = requireString(message.sessionKey, "sessionKey", 500);
    const requestId = requireString(message.requestId, "requestId", 100);
    const generation = requireString(message.generation, "generation", 100);
    try {
      await this.deliverReply({ key, generation, requestId, text: message.text });
      socketSend(viewer, { type: "reply_result", requestId, ok: true });
    } catch (error) {
      socketSend(viewer, { type: "reply_result", requestId, ok: false, error: error.message });
    }
  }

  async handleVirtualThreadList(request, response, url) {
    if (url.pathname !== "/api/inbox/threads" || request.method !== "GET" || !this.plannotator?.url) return false;
    const upstream = await fetch(new URL(url.pathname + url.search, this.plannotator.url), {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000)
    });
    if (!upstream.ok) {
      sendJson(response, upstream.status, await upstream.json());
      return true;
    }
    const model = await upstream.json();
    const project = url.searchParams.get("project");
    const remoteModels = this.virtual.listAll();
    const remoteSnoozed = remoteModels.flatMap(({ machine, model: remote }) =>
      (remote.snoozed || []).filter((thread) => !project || thread.project_id === project).map((thread) => ({ ...thread, machine }))
    );
    const remotePins = remoteModels.flatMap(({ machine, model: remote }) => (remote.pins || []).map((thread) => ({ ...thread, machine })));
    for (const section of model.sections || []) {
      section.threads = (section.threads || []).filter((thread) => !this.virtual.findThread(thread.thread_id));
      for (const { machine, model: remote } of remoteModels) {
        const threads = remote.sections.find((candidate) => candidate.id === section.id)?.threads || [];
        section.threads.push(...threads.filter((thread) => !project || thread.project_id === project).map((thread) => ({ ...thread, machine })));
      }
    }
    model.snoozed = [...(model.snoozed || []).filter((thread) => !this.virtual.findThread(thread.thread_id)), ...remoteSnoozed];
    const mergedPins = new Map((model.pins || []).map((thread) => [thread.thread_id, thread]));
    for (const thread of remotePins) if (!mergedPins.has(thread.thread_id)) mergedPins.set(thread.thread_id, thread);
    model.pins = [...mergedPins.values()];
    sendJson(response, 200, model);
    return true;
  }


  notifyPinListeners() {
    for (const notify of this.pinListeners) notify();
  }

  handleVirtualEventStream(request, response, url) {
    if (url.pathname !== "/api/inbox/events" || request.method !== "GET" || !this.plannotator) return false;
    this.plannotator.proxy(request, response, (stream) => {
      const listener = () => {
        if (!stream.destroyed && !stream.writableEnded) stream.write("event: pins\ndata: {}\n\n");
      };
      this.pinListeners.add(listener);
      request.once("close", () => this.pinListeners.delete(listener));
    });
    return true;
  }

  async mergedPinEntries() {
    const upstream = await fetch(new URL("/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1", this.plannotator.url), {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000)
    });
    if (!upstream.ok) throw new Error("Could not read central pins");
    const model = await upstream.json();
    const local = (model.pins || []).filter((thread) => !this.virtual.findThread(thread.thread_id)).map((thread) => ({
      thread_id: thread.thread_id,
      pinned_at: thread.pinned_at || new Date().toISOString()
    }));
    return [...local, ...this.virtual.pinEntries()];
  }

  async handleVirtualPins(request, response, url) {
    if (request.method !== "POST" || !this.plannotator?.url) return false;
    const match = url.pathname.match(/^\/api\/inbox\/threads\/([^/]+)\/pin$/);
    if (match) {
      const session = this.virtual.findThread(match[1]);
      if (!session) return false;
      const body = await readJson(request) || {};
      await this.virtual.setPin(session, body.pinned === true);
      this.notifyPinListeners();
      sendJson(response, 200, { pins: await this.mergedPinEntries() });
      return true;
    }
    if (url.pathname !== "/api/inbox/pins") return false;
    const body = await readJson(request) || {};
    const restoreSession = typeof body.restore?.thread_id === "string" ? this.virtual.findThread(body.restore.thread_id) : null;
    const order = Array.isArray(body.order) ? body.order : null;
    const hasVirtualOrder = order?.some((threadId) => this.virtual.findThread(threadId));
    if (!restoreSession && !hasVirtualOrder) return false;
    if (restoreSession) {
      await this.virtual.setPin(restoreSession, true, body.restore);
    } else {
      await this.virtual.orderPins(order);
      const localOrder = order.filter((threadId) => !this.virtual.findThread(threadId));
      if (localOrder.length) {
        const upstream = await fetch(new URL("/api/inbox/pins", this.plannotator.url), {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ ...body, order: localOrder }), signal: AbortSignal.timeout(10_000)
        });
        if (!upstream.ok) {
          sendJson(response, upstream.status, await upstream.json());
          return true;
        }
      }
    }
    this.notifyPinListeners();
    sendJson(response, 200, { pins: await this.mergedPinEntries() });
    return true;
  }

  async handleVirtualSearch(request, response, url) {
    if (url.pathname !== "/api/inbox/search" || request.method !== "GET" || !this.plannotator?.url) return false;
    const target = new URL(url.pathname + url.search, this.plannotator.url);
    target.searchParams.set("offset", "0");
    target.searchParams.set("limit", "50");
    const upstream = await fetch(target, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) {
      sendJson(response, upstream.status, await upstream.json());
      return true;
    }
    const central = await upstream.json();
    const merged = mergeSearchAnswers([central, ...this.virtual.searchAll(url)], url.searchParams);
    merged.serverSession = central.serverSession;
    sendJson(response, 200, merged);
    return true;
  }

  async handleVirtualArchived(request, response, url) {
    if (url.pathname !== "/api/inbox/threads/archived" || request.method !== "GET" || !this.plannotator?.url) return false;
    const target = new URL(url.pathname + url.search, this.plannotator.url);
    target.searchParams.set("offset", "0");
    target.searchParams.set("limit", "100");
    const upstream = await fetch(target, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) {
      sendJson(response, upstream.status, await upstream.json());
      return true;
    }
    const central = await upstream.json();
    const models = [central, ...this.virtual.archivedAll(url)];
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const projects = new Map();
    for (const model of models) {
      for (const project of model.projects || []) {
        const current = projects.get(project.id) || { ...project, archived: 0 };
        current.archived += project.archived;
        projects.set(project.id, current);
      }
    }
    const threads = models.flatMap((model) => model.threads || []).sort((left, right) => String(right.last_at).localeCompare(String(left.last_at)));
    sendJson(response, 200, {
      serverSession: central.serverSession,
      cursor: Math.max(...models.map((model) => model.cursor || 0)),
      project: url.searchParams.get("project") || null,
      projects: [...projects.values()],
      total: models.reduce((total, model) => total + (model.total || 0), 0),
      offset,
      limit,
      threads: threads.slice(offset, offset + limit)
    });
    return true;
  }

  async handleVirtualDraft(request, response, url) {
    const match = url.pathname.match(/^\/api\/inbox\/(?:m\/([^/]+)\/)?threads\/([^/]+)\/draft(\/delete)?$/);
    if (!match) return false;
    const session = this.virtual.findThread(match[2], match[1]);
    if (!session) return false;
    const threadId = match[2];
    if (request.method === "GET" && !match[3]) {
      sendJson(response, 200, { serverSession: this.plannotator?.serverSession, draft: this.drafts.get(threadId) });
      return true;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use GET or POST" });
      return true;
    }
    if (match[3]) {
      sendJson(response, 200, { ok: true, deleted: await this.drafts.delete(threadId) });
      return true;
    }
    try {
      const draft = await this.drafts.save(threadId, await readJson(request) || {});
      sendJson(response, 200, { draft });
    } catch (error) {
      sendJson(response, error.code === "draft_conflict" ? 409 : 422, { code: error.code, error: error.message, draft: error.draft });
    }
    return true;
  }

  async handleViewerHttp(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/healthz") return sendJson(response, 200, { ok: true });
      if (url.pathname === "/api/state" && request.method === "GET") return sendJson(response, 200, this.store.publicState());
      if (url.pathname === "/api/push/public-key" && request.method === "GET") return sendJson(response, 200, { publicKey: this.push.publicKey });
      if (url.pathname === "/api/push/subscription" && request.method === "POST") {
        const subscription = await readJson(request);
        requireString(subscription.endpoint, "endpoint", 4096);
        requireString(subscription.keys?.p256dh, "p256dh", 1000);
        requireString(subscription.keys?.auth, "auth", 1000);
        const id = await this.store.addSubscription(subscription);
        return sendJson(response, 201, { id });
      }
      if (url.pathname === "/api/push/subscription" && request.method === "DELETE") {
        const subscription = await readJson(request);
        await this.store.removeSubscription(requireString(subscription.endpoint, "endpoint", 4096));
        return sendJson(response, 200, { ok: true });
      }
      const hostMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/(approve|revoke)$/);
      if (hostMatch && request.method === "POST") {
        const hostId = decodeURIComponent(hostMatch[1]);
        if (hostMatch[2] === "approve") {
          const host = await this.store.approveHost(hostId);
          for (const socket of this.agents.get(hostId) ?? []) socketSend(socket, { type: "paired" });
          await this.virtual.ensureLinked(host);
          this.broadcastState();
          return sendJson(response, 200, { ok: true, paired: host.paired });
        }
        await this.store.revokeHost(hostId);
        for (const socket of this.agents.get(hostId) ?? []) socket.close();
        this.broadcastState();
        return sendJson(response, 200, { ok: true });
      }
      const inboxMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/dismiss$/);
      if (inboxMatch && request.method === "POST") {
        await this.store.dismissInbox(decodeURIComponent(inboxMatch[1]));
        this.broadcastState();
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === "/api/inbox/tidy" && request.method === "GET" && this.virtual.hasProject(url.searchParams.get("project"))) {
        return sendJson(response, 200, { serverSession: this.plannotator?.serverSession, count: 0, agents: [], run: null });
      }
      if (await this.handleVirtualEventStream(request, response, url)) return;
      if (await this.handleVirtualThreadList(request, response, url)) return;
      if (await this.handleVirtualPins(request, response, url)) return;
      if (await this.handleVirtualSearch(request, response, url)) return;
      if (await this.handleVirtualArchived(request, response, url)) return;
      if (await this.handleVirtualDraft(request, response, url)) return;
      if (this.plannotator && !PUBLIC_FILES.has(url.pathname) && !url.pathname.startsWith("/session/")) return this.plannotator.proxy(request, response);
      if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 404, { error: "Not found" });
      const filename = PUBLIC_FILES.get(url.pathname) ?? (url.pathname.startsWith("/session/") ? "index.html" : undefined);
      if (!filename) return sendJson(response, 404, { error: "Not found" });
      const body = await readFile(path.join(this.publicDir, filename));
      response.writeHead(200, { "content-type": MIME[path.extname(filename)] ?? "application/octet-stream", "cache-control": "no-cache" });
      return response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }
}

async function main() {
  const publicUrl = process.env.PUBLIC_URL ?? "http://127.0.0.1:8091";
  const dataDir = process.env.DATA_DIR ?? path.resolve("data");
  const virtualAddress = process.env.VIRTUAL_MACHINE_ADDRESS;
  const plannotator = process.env.PLANNOTATOR_DISABLED === "1" ? null : await new PlannotatorRuntime({
    binary: process.env.PLANNOTATOR_BINARY,
    dataDir: path.join(dataDir, "plannotator"),
    virtualAddress
  }).start();
  const hub = await InboxHub.create({
    dataDir,
    publicDir: path.resolve("public"),
    publicUrl,
    plannotator,
    virtualAddress,
    linkMachine: plannotator ? (code) => plannotator.link(code) : undefined
  });
  const host = process.env.HOST ?? "127.0.0.1";
  await hub.listen({ viewerPort: Number(process.env.VIEWER_PORT ?? 8091), agentPort: Number(process.env.AGENT_PORT ?? 8092), doorPort: process.env.DOOR_PORT ? Number(process.env.DOOR_PORT) : undefined, host });
  console.log(`Pi Inbox viewer: ${publicUrl}`);
  console.log(`Pi Inbox agent relay listening on ${host}:${hub.addresses().agent.port}`);
  const shutdown = async () => {
    await hub.close();
    await plannotator?.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
