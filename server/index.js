import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { InboxStore } from "./store.js";
import { PushDispatcher } from "./push.js";
import { parseMessage, requireString, verifyAgentSignature } from "./protocol.js";

const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/sw.js", "sw.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/icon.svg", "icon.svg"]
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
    this.publicUrl = options.publicUrl;
    this.store = options.store;
    this.push = options.push;
    this.agents = new Map();
    this.viewers = new Set();
    this.challenges = new Map();
    this.pendingReplies = new Map();
    this.agentWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    this.viewerWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.agentHttp = createServer((request, response) => this.handleAgentHttp(request, response));
    this.viewerHttp = createServer((request, response) => this.handleViewerHttp(request, response));
    this.agentHttp.on("upgrade", (request, socket, head) => this.handleAgentUpgrade(request, socket, head));
    this.viewerHttp.on("upgrade", (request, socket, head) => this.handleViewerUpgrade(request, socket, head));
    this.agentWss.on("connection", (socket, _request, host) => this.handleAgentSocket(socket, host));
    this.viewerWss.on("connection", (socket) => this.handleViewerSocket(socket));
  }

  static async create(options) {
    const store = new InboxStore(options.dataDir);
    await store.load();
    const push = new PushDispatcher(options.dataDir, options.publicUrl, store);
    await push.load();
    return new InboxHub({ ...options, store, push });
  }

  async listen({ viewerPort, agentPort, host }) {
    await Promise.all([
      new Promise((resolve) => this.viewerHttp.listen(viewerPort, host, resolve)),
      new Promise((resolve) => this.agentHttp.listen(agentPort, host, resolve))
    ]);
  }

  addresses() {
    return { viewer: this.viewerHttp.address(), agent: this.agentHttp.address() };
  }

  async close() {
    for (const socket of [...this.agents.values(), ...this.viewers]) socket.terminate();
    await Promise.all([this.agentHttp, this.viewerHttp].map((server) => new Promise((resolve) => server.close(resolve))));
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
    const previous = this.agents.get(host.id);
    if (previous) previous.terminate();
    this.agents.set(host.id, socket);
    await this.store.setHostOnline(host.id, true);
    socketSend(socket, host.paired ? { type: "paired" } : { type: "pairing_required", pairingCode: host.pairingCode });
    this.broadcastState();
    socket.on("message", async (raw) => {
      try {
        const message = parseMessage(raw);
        if (!message) return socketSend(socket, { type: "error", error: "Invalid message" });
        if (!host.paired) return socketSend(socket, { type: "pairing_required", pairingCode: host.pairingCode });
        await this.handleAgentMessage(host, socket, message);
      } catch (error) {
        socketSend(socket, { type: "error", error: error.message });
      }
    });
    socket.on("close", async () => {
      if (this.agents.get(host.id) !== socket) return;
      this.agents.delete(host.id);
      await this.store.setHostOnline(host.id, false);
      this.broadcastState();
    });
  }

  async handleAgentMessage(host, socket, message) {
    if (message.type === "ping") return socketSend(socket, { type: "pong" });
    const sessionId = requireString(message.sessionId, "sessionId", 300);
    const generation = requireString(message.generation, "generation", 100);
    const key = `${host.id}:${sessionId}`;
    if (message.type === "session_upsert") {
      requireString(message.session?.generation, "generation", 100);
      if (message.session.generation !== generation || message.session.sessionId !== sessionId) throw new Error("Session identity mismatch");
      const session = await this.store.upsertSession(host.id, message.session);
      if (session.status === "running") {
        await this.store.resolveSessionInbox(key);
        this.broadcastState();
      }
      this.broadcast({ type: "session", session });
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
    if (message.type === "reply_result") {
      const pending = this.pendingReplies.get(message.requestId);
      if (!pending) return;
      this.pendingReplies.delete(message.requestId);
      clearTimeout(pending.timeout);
      if (message.ok) await this.store.resolveSessionInbox(key);
      socketSend(pending.viewer, { type: "reply_result", requestId: message.requestId, ok: Boolean(message.ok), error: message.error });
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

  async handleViewerReply(viewer, message) {
    const key = requireString(message.sessionKey, "sessionKey", 500);
    const requestId = requireString(message.requestId, "requestId", 100);
    if (this.pendingReplies.has(requestId)) throw new Error("Duplicate reply request");
    const text = requireString(message.text, "text", 32_000);
    const generation = requireString(message.generation, "generation", 100);
    const session = this.store.getSession(key);
    if (!session || !session.online || session.generation !== generation) throw new Error("Session is offline or changed");
    const host = this.store.getHost(session.hostId);
    const agent = this.agents.get(session.hostId);
    if (!host?.paired || !agent || agent.readyState !== WebSocket.OPEN) throw new Error("Host is offline");
    const timeout = setTimeout(() => {
      const pending = this.pendingReplies.get(requestId);
      if (!pending) return;
      this.pendingReplies.delete(requestId);
      socketSend(viewer, { type: "reply_result", requestId, ok: false, error: "Delivery result unknown" });
    }, 15_000);
    timeout.unref();
    this.pendingReplies.set(requestId, { viewer, timeout });
    socketSend(agent, { type: "reply", requestId, sessionId: session.sessionId, generation, text });
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
          socketSend(this.agents.get(hostId), { type: "paired" });
          this.broadcastState();
          return sendJson(response, 200, { ok: true, paired: host.paired });
        }
        await this.store.revokeHost(hostId);
        this.agents.get(hostId)?.close();
        this.broadcastState();
        return sendJson(response, 200, { ok: true });
      }
      const inboxMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/dismiss$/);
      if (inboxMatch && request.method === "POST") {
        await this.store.dismissInbox(decodeURIComponent(inboxMatch[1]));
        this.broadcastState();
        return sendJson(response, 200, { ok: true });
      }
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
  const hub = await InboxHub.create({
    dataDir: process.env.DATA_DIR ?? path.resolve("data"),
    publicDir: path.resolve("public"),
    publicUrl
  });
  const host = process.env.HOST ?? "127.0.0.1";
  await hub.listen({ viewerPort: Number(process.env.VIEWER_PORT ?? 8091), agentPort: Number(process.env.AGENT_PORT ?? 8092), host });
  console.log(`Pi Inbox viewer: ${publicUrl}`);
  console.log(`Pi Inbox agent relay listening on ${host}:${hub.addresses().agent.port}`);
  const shutdown = async () => {
    await hub.close();
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
