import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Identity = { hostId: string; publicKey: string; privateKey: string };
type Snapshot = ReturnType<typeof buildSnapshot>;

const relayUrl = process.env.PI_INBOX_RELAY_URL ?? "wss://inbox-relay.borges.dev";

function loadIdentity(): Identity {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const stateDir = process.env.PI_INBOX_STATE_DIR ?? path.join(agentDir, "pi-inbox");
  const identityFile = path.join(stateDir, "identity.json");
  try {
    return JSON.parse(readFileSync(identityFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity = {
    hostId: randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600 });
  return identity;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}

function buildSnapshot(ctx: ExtensionContext, generation: string, status: string) {
  const messages = ctx.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return [];
    const content = message.content as unknown;
    const toolCalls = Array.isArray(content)
      ? content.filter((block) => block?.type === "toolCall").map((block) => ({ name: block.name, arguments: block.arguments }))
      : [];
    return [{
      id: entry.id,
      role: message.role,
      text: textContent(content),
      toolCalls,
      stopReason: "stopReason" in message ? message.stopReason : undefined,
      errorMessage: "errorMessage" in message ? message.errorMessage : undefined
    }];
  });
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    generation,
    cwd: ctx.cwd,
    name: ctx.sessionManager.getSessionName() ?? path.basename(ctx.cwd),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
    thinkingLevel: ctx.thinkingLevel,
    status,
    messages
  };
}

class PiInboxRuntime {
  private identity = loadIdentity();
  private generation = randomUUID();
  private currentRunId = randomUUID();
  private currentPromptId?: string;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private connecting = false;
  private canSend = false;
  private disposed = false;
  private pairingCode?: string;
  private latestSnapshot: Snapshot;

  constructor(private pi: ExtensionAPI, private ctx: ExtensionContext) {
    this.latestSnapshot = buildSnapshot(ctx, this.generation, ctx.isIdle() ? "idle" : "running");
  }

  start() {
    this.heartbeat = setInterval(() => this.send({ type: "ping" }), 20_000);
    this.heartbeat.unref();
    void this.connect();
  }

  private httpUrl(pathname: string) {
    try {
      const url = new URL(relayUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = pathname;
      url.search = "";
      return url;
    } catch {
      return undefined;
    }
  }

  private async connect() {
    if (this.connecting || this.disposed) return;
    this.connecting = true;
    try {
      const challengeUrl = this.httpUrl("/challenge");
      if (!challengeUrl) throw new Error("Invalid relay URL");
      for (const [key, value] of Object.entries({ hostId: this.identity.hostId, publicKey: this.identity.publicKey, name: os.hostname() })) {
        challengeUrl.searchParams.set(key, value);
      }
      const response = await fetch(challengeUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Pairing challenge failed: ${response.status}`);
      const challenge = await response.json();
      const payload = `pi-inbox-agent-v1\n${this.identity.hostId}\n${challenge.nonce}`;
      const privateKey = createPrivateKey({ key: Buffer.from(this.identity.privateKey, "base64"), format: "der", type: "pkcs8" });
      const signature = sign(null, Buffer.from(payload), privateKey).toString("base64");
      const socketUrl = this.httpUrl("/ws");
      if (!socketUrl) throw new Error("Invalid relay URL");
      socketUrl.protocol = relayUrl.startsWith("wss:") ? "wss:" : "ws:";
      for (const [key, value] of Object.entries({
        hostId: this.identity.hostId,
        publicKey: this.identity.publicKey,
        nonce: challenge.nonce,
        signature
      })) socketUrl.searchParams.set(key, value);
      const socket = new WebSocket(socketUrl, { maxPayload: 4 * 1024 * 1024 });
      this.socket = socket;
      socket.on("open", () => {
        this.connecting = false;
      });
      socket.on("message", (raw) => void this.handleMessage(raw.toString()));
      socket.on("close", () => {
        this.connecting = false;
        this.canSend = false;
        if (this.socket === socket) this.socket = undefined;
        this.scheduleReconnect();
      });
      socket.on("error", () => socket.close());
    } catch {
      this.connecting = false;
      this.setStatus("offline");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 3_000);
    this.reconnectTimer.unref();
  }

  private setStatus(text?: string) {
    if (this.ctx.hasUI) this.ctx.ui.setStatus("pi-inbox", text);
  }

  private async handleMessage(raw: string) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== "string") return;
    if (message.type === "pairing_required") {
      this.canSend = false;
      if (this.pairingCode !== message.pairingCode) {
        this.pairingCode = message.pairingCode;
        if (this.ctx.hasUI) this.ctx.ui.notify(`Pair this computer in Pi Inbox: ${message.pairingCode}`, "info");
      }
      this.setStatus(`pair ${message.pairingCode}`);
      return;
    }
    if (message.type === "paired") {
      this.canSend = true;
      this.pairingCode = undefined;
      this.setStatus(undefined);
      this.snapshot(this.latestSnapshot.status);
      return;
    }
    if (message.type !== "reply") return;
    try {
      if (message.sessionId !== this.latestSnapshot.sessionId || message.generation !== this.generation) throw new Error("Session changed");
      if (typeof message.text !== "string" || message.text.length === 0) throw new Error("Empty reply");
      if (this.ctx.isIdle()) this.pi.sendUserMessage(message.text);
      else this.pi.sendUserMessage(message.text, { deliverAs: "followUp" });
      this.send({ type: "reply_result", requestId: message.requestId, sessionId: this.latestSnapshot.sessionId, generation: this.generation, ok: true });
      this.snapshot(this.ctx.isIdle() ? "idle" : "running");
    } catch (error) {
      this.send({
        type: "reply_result",
        requestId: message.requestId,
        sessionId: this.latestSnapshot.sessionId,
        generation: this.generation,
        ok: false,
        error: error instanceof Error ? error.message : "Reply failed"
      });
    }
  }

  private send(message: Record<string, unknown>) {
    if (!this.canSend || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  snapshot(status: string) {
    this.latestSnapshot = buildSnapshot(this.ctx, this.generation, status);
    this.send({ type: "session_upsert", sessionId: this.latestSnapshot.sessionId, generation: this.generation, session: this.latestSnapshot });
  }

  event(event: Record<string, unknown>) {
    this.send({ type: "session_event", sessionId: this.latestSnapshot.sessionId, generation: this.generation, event });
  }

  agentStarted() {
    this.currentRunId = randomUUID();
    this.snapshot("running");
  }

  settled(aborted: boolean) {
    this.snapshot("idle");
    this.send({ type: "agent_settled", sessionId: this.latestSnapshot.sessionId, generation: this.generation, runId: this.currentRunId, aborted });
  }

  promptStarted(kind: string, title?: string) {
    this.currentPromptId = randomUUID();
    this.snapshot("waiting");
    this.send({
      type: "ui_prompt_start",
      sessionId: this.latestSnapshot.sessionId,
      generation: this.generation,
      promptId: this.currentPromptId,
      title: title ?? `Agent needs ${kind}`
    });
  }

  promptEnded() {
    if (!this.currentPromptId) return;
    this.send({ type: "ui_prompt_end", sessionId: this.latestSnapshot.sessionId, generation: this.generation, promptId: this.currentPromptId });
    this.currentPromptId = undefined;
    this.snapshot(this.ctx.isIdle() ? "idle" : "running");
  }

  dispose() {
    this.disposed = true;
    this.canSend = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.setStatus(undefined);
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: PiInboxRuntime | undefined;
  pi.on("session_start", async (_event, ctx) => {
    runtime?.dispose();
    runtime = new PiInboxRuntime(pi, ctx);
    await runtime.start();
  });
  pi.on("session_shutdown", async () => {
    runtime?.dispose();
    runtime = undefined;
  });
  pi.on("agent_start", async () => runtime?.agentStarted());
  pi.on("agent_settled", async (event) => runtime?.settled(event.aborted));
  pi.on("message_end", async () => runtime?.snapshot("running"));
  pi.on("message_update", async (event) => {
    if (event.type === "message_update") runtime?.event({ ...event });
  });
  pi.on("tool_execution_start", async (event) => runtime?.event({ type: event.type, toolName: event.toolName, toolCallId: event.toolCallId }));
  pi.on("tool_execution_end", async (event) => runtime?.event({ type: event.type, toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError }));
  pi.on("model_select", async () => runtime?.snapshot("idle"));
  pi.on("session_info_changed", async () => runtime?.snapshot("idle"));
  pi.on("ui_prompt_start", async (event) => runtime?.promptStarted(event.kind, event.title));
  pi.on("ui_prompt_end", async () => runtime?.promptEnded());
}
