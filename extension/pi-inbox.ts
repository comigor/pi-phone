import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { HostLauncher } from "./host-launch.js";
import { checkGitRemote, cloneTarget, listFolders } from "./host-folders.js";
import { listSkills, readSkillContent } from "./host-skills.js";
import { chunkSnapshotMessages, snapshotMessages } from "./history-sync.js";
import { isSubagentSession } from "./session-scope.js";
import { bindHandoffEvents } from "./handoff-bridge.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Identity = { hostId: string; publicKey: string; privateKey: string };
type RelayAttachment = { name?: string; mimeType: string; data: string };
type Snapshot = ReturnType<typeof buildSnapshot>;

function currentRelayUrl(): string {
  return process.env.PI_INBOX_RELAY_URL ?? "wss://inbox-relay.borges.dev";
}

function stateDirectory(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return process.env.PI_INBOX_STATE_DIR ?? path.join(agentDir, "pi-inbox");
}

function loadIdentity(): Identity {
  const stateDir = stateDirectory();
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

function buildSnapshot(ctx: ExtensionContext, generation: string, status: string, latestOnly = false) {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    generation,
    cwd: ctx.cwd,
    name: ctx.sessionManager.getSessionName() ?? path.basename(ctx.cwd),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
    thinkingLevel: ctx.thinkingLevel,
    status,
    messages: snapshotMessages(ctx.sessionManager.getBranch(), latestOnly)
  };
}

class PiInboxRuntime {
  private relayUrl = currentRelayUrl();
  private handoffToken = process.env.PI_INBOX_HANDOFF_TOKEN || undefined;
  private identity = this.handoffToken ? undefined : loadIdentity();
  private generation = randomUUID();
  private currentRunId = randomUUID();
  private currentPromptId?: string;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private connecting = false;
  private canSend = false;
  private disposed = false;
  private handedOff = false;
  private pairingCode?: string;
  private latestSnapshot: Snapshot;
  private replyResults = new Map<string, { ok: boolean; error?: string }>();
  private controlRequests = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private readyWaiters = new Set<() => void>();
  private launcher = new HostLauncher({ scratchRoot: path.join(stateDirectory(), "scratch") });
  private launchTasks = new Set<Promise<void>>();

  private pi: ExtensionAPI;
  private ctx: ExtensionContext;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
    this.pi = pi;
    this.ctx = ctx;
    this.latestSnapshot = buildSnapshot(ctx, this.generation, ctx.isIdle() ? "idle" : "running");
  }

  get isHandoffLease(): boolean {
    return Boolean(this.handoffToken);
  }

  start() {
    this.heartbeat = setInterval(() => this.send({ type: "ping" }), 20_000);
    this.heartbeat.unref();
    void this.connect();
  }

  private httpUrl(pathname: string) {
    try {
      const url = new URL(this.relayUrl);
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
      const socketUrl = this.httpUrl("/ws");
      if (!socketUrl) throw new Error("Invalid relay URL");
      socketUrl.protocol = this.relayUrl.startsWith("wss:") ? "wss:" : "ws:";
      let headers: Record<string, string> | undefined;
      if (this.handoffToken) {
        headers = { authorization: `Bearer ${this.handoffToken}` };
      } else {
        if (!this.identity) throw new Error("Missing host identity");
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
        for (const [key, value] of Object.entries({
          hostId: this.identity.hostId,
          publicKey: this.identity.publicKey,
          nonce: challenge.nonce,
          signature
        })) socketUrl.searchParams.set(key, value);
      }
      const socket = new WebSocket(socketUrl, { maxPayload: 32 * 1024 * 1024, ...(headers ? { headers } : {}) });
      this.socket = socket;
      socket.on("open", () => {
        this.connecting = false;
      });
      socket.on("unexpected-response", (_request, response) => {
        if (this.handoffToken && response.statusCode === 401) this.dispose();
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

  private async waitUntilReady(timeoutMs = 10_000): Promise<void> {
    if (this.canSend && this.socket?.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.readyWaiters.delete(done);
        reject(new Error("Pi Inbox relay is not connected"));
      }, timeoutMs);
      timer.unref();
      this.readyWaiters.add(done);
    });
  }

  private async requestControl(message: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    await this.waitUntilReady(timeoutMs);
    const requestId = randomUUID();
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.controlRequests.delete(requestId);
        reject(new Error("Pi Inbox relay request timed out"));
      }, timeoutMs);
      timeout.unref();
      this.controlRequests.set(requestId, { resolve, reject, timeout });
      this.send({ ...message, requestId });
    });
  }

  async issueHandoffLease(target: string): Promise<{ relayUrl: string; token: string; leaseId: string }> {
    const snap = buildSnapshot(this.ctx, this.generation, "idle", true);
    const result = await this.requestControl({
      type: "handoff_issue",
      sessionId: snap.sessionId,
      cwd: snap.cwd,
      name: snap.name,
      model: snap.model,
      thinkingLevel: snap.thinkingLevel,
      target
    });
    if (!result.ok || typeof result.token !== "string" || typeof result.leaseId !== "string") {
      throw new Error(typeof result.error === "string" ? result.error : "Failed to issue Inbox handoff lease");
    }
    this.handedOff = true;
    return { relayUrl: this.relayUrl, token: result.token, leaseId: result.leaseId };
  }

  async fenceHandoffLease(sessionId: string, leaseId?: string): Promise<void> {
    const result = await this.requestControl({ type: "handoff_fence", sessionId, ...(leaseId ? { leaseId } : {}) });
    if (!result.ok) throw new Error(typeof result.error === "string" ? result.error : "Failed to fence Inbox handoff lease");
    if (sessionId === this.latestSnapshot.sessionId) {
      this.handedOff = false;
      this.snapshot(this.ctx.isIdle() ? "idle" : "running", true);
    }
  }

  private async handleMessage(raw: string) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== "string") return;
    if (message.type === "handoff_fenced") {
      this.dispose();
      return;
    }
    if (message.type === "handoff_issue_result" || message.type === "handoff_fence_result") {
      const pending = this.controlRequests.get(message.requestId);
      if (!pending) return;
      this.controlRequests.delete(message.requestId);
      clearTimeout(pending.timeout);
      pending.resolve(message);
      return;
    }
    if (!this.handoffToken && ["folder_list", "clone_check", "clone_target"].includes(message.type)) {
      this.handleCreation(message);
      return;
    }
    if (!this.handoffToken && ["skill_list", "skill_content"].includes(message.type)) {
      this.handleSkills(message);
      return;
    }
    if (!this.handoffToken && ["launch_start", "launch_stop", "launch_delete"].includes(message.type)) {
      this.handleLaunch(message);
      return;
    }
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
      if (!this.handoffToken) {
        this.send({ type: "host_hello", skills: 1, launch: { agents: ["pi"], home: os.homedir(), creation: 1 } });
      }
      this.pairingCode = undefined;
      this.setStatus(undefined);
      for (const notifyReady of [...this.readyWaiters]) notifyReady();
      this.snapshot(this.latestSnapshot.status, true);
      return;
    }
    if (message.type === "session_snapshot_required") {
      this.snapshot(this.latestSnapshot.status, true);
      return;
    }
    if (message.type === "stop") {
      try {
        if (message.sessionId !== this.latestSnapshot.sessionId || message.generation !== this.generation) throw new Error("Session changed");
        await this.ctx.abort();
        this.send({ type: "stop_result", requestId: message.requestId, sessionId: this.latestSnapshot.sessionId, generation: this.generation, ok: true });
        this.snapshot("idle");
      } catch (error) {
        this.send({ type: "stop_result", requestId: message.requestId, sessionId: this.latestSnapshot.sessionId, generation: this.generation, ok: false, error: error instanceof Error ? error.message : "Stop failed" });
      }
      return;
    }

    if (message.type !== "reply") return;
    const previous = this.replyResults.get(message.requestId);
    if (previous) {
      this.send({ type: "reply_result", requestId: message.requestId, sessionId: this.latestSnapshot.sessionId, generation: this.generation, ...previous });
      return;
    }
    try {
      if (message.sessionId !== this.latestSnapshot.sessionId || message.generation !== this.generation) throw new Error("Session changed");
      if (typeof message.text !== "string" || message.text.length === 0) throw new Error("Empty reply");
      const attachments: RelayAttachment[] = Array.isArray(message.attachments) ? message.attachments : [];
      const images = attachments.filter((item) => typeof item.mimeType === "string" && item.mimeType.startsWith("image/"));
      const files = attachments.filter((item) => !images.includes(item));
      let text = message.text;
      if (files.length) {
        const uploadDir = path.join(stateDirectory(), "uploads", message.requestId);
        mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
        const paths = files.map((file) => {
          const filename = String(file.name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
          const target = path.join(uploadDir, filename);
          writeFileSync(target, Buffer.from(file.data, "base64"), { mode: 0o600 });
          return target;
        });
        text += `\n\nAttached files:\n${paths.map((target) => `- ${target}`).join("\n")}`;
      }
      const content = images.length ? [
        { type: "text", text },
        ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))
      ] : text;
      if (this.ctx.isIdle()) this.pi.sendUserMessage(content);
      else this.pi.sendUserMessage(content, { deliverAs: "followUp" });
      this.completeReply(message.requestId, { ok: true });
      this.snapshot(this.ctx.isIdle() ? "idle" : "running");
    } catch (error) {
      this.completeReply(message.requestId, { ok: false, error: error instanceof Error ? error.message : "Reply failed" });
    }
  }

  private handleSkills(message: { type: string; requestId: string; name?: string }) {
    const task = (async () => {
      try {
        if (message.type === "skill_list") {
          const skills = await listSkills();
          this.send({ type: "skill_list_result", requestId: message.requestId, ok: true, skills });
        } else {
          const skill = await readSkillContent(message.name || "");
          this.send({ type: "skill_content_result", requestId: message.requestId, ok: true, skill });
        }
      } catch (error) {
        this.send({ type: `${message.type}_result`, requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : "Skill operation failed" });
      }
    })();
    this.launchTasks.add(task);
    void task.finally(() => this.launchTasks.delete(task));
  }

  private handleCreation(message: { type: string; requestId: string; path?: string; url?: string; into?: string }) {
    const task = (async () => {
      try {
        if (message.type === "folder_list") {
          const listing = await listFolders(os.homedir(), message.path || "~");
          this.send({ type: "folder_list_result", requestId: message.requestId, ok: true, listing });
        } else if (message.type === "clone_check") {
          const reach = await checkGitRemote(message.url || "");
          this.send({ type: "clone_check_result", requestId: message.requestId, ok: true, reach });
        } else {
          const target = await cloneTarget(os.homedir(), message.url || "", message.into);
          this.send({ type: "clone_target_result", requestId: message.requestId, ok: true, target });
        }
      } catch (error) {
        this.send({ type: `${message.type}_result`, requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : "Host operation failed", code: (error as { code?: string }).code });
      }
    })();
    this.launchTasks.add(task);
    void task.finally(() => this.launchTasks.delete(task));
  }

  private handleLaunch(message: { type: string; requestId: string; launchId: string; sessionId: string; cwd?: string; name?: string; arbitrary?: boolean; create?: boolean; scratch?: boolean; clone?: { url: string; branch?: string } }) {
    const task = (async () => {
      try {
        let result;
        if (message.type === "launch_start") result = await this.launcher.start(message.sessionId, message.cwd || os.homedir(), message.name || "Pi session", { arbitrary: message.arbitrary, create: message.create, scratch: message.scratch, clone: message.clone });
        else if (message.type === "launch_delete") result = await this.launcher.delete(message.sessionId, message.cwd || "", message.scratch === true);
        else await this.launcher.stop(message.sessionId);
        this.send({ type: "launch_result", requestId: message.requestId, launchId: message.launchId, sessionId: message.sessionId, ok: true, ...result });
      } catch (error) {
        this.send({ type: "launch_result", requestId: message.requestId, launchId: message.launchId, sessionId: message.sessionId, ok: false, error: error instanceof Error ? error.message : "Launch failed", code: (error as { code?: string }).code });
      }
    })();
    this.launchTasks.add(task);
    void task.finally(() => this.launchTasks.delete(task));
  }

  private completeReply(requestId: string, result: { ok: boolean; error?: string }) {
    this.replyResults.set(requestId, result);
    if (this.replyResults.size > 256) {
      const oldestReply = this.replyResults.keys().next().value;
      if (oldestReply) this.replyResults.delete(oldestReply);
    }
    this.send({ type: "reply_result", requestId, sessionId: this.latestSnapshot.sessionId, generation: this.generation, ...result });
  }

  private send(message: Record<string, unknown>) {
    if (!this.canSend || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  snapshot(status: string, full = false) {
    if (this.handedOff) return;
    this.latestSnapshot = buildSnapshot(this.ctx, this.generation, status, !full);
    if (!full) {
      this.send({ type: "session_patch", sessionId: this.latestSnapshot.sessionId, generation: this.generation, session: this.latestSnapshot });
      return;
    }
    for (const [index, messages] of chunkSnapshotMessages(this.latestSnapshot.messages).entries()) {
      this.send({
        type: index === 0 ? "session_upsert" : "session_patch",
        sessionId: this.latestSnapshot.sessionId,
        generation: this.generation,
        session: { ...this.latestSnapshot, messages }
      });
    }
  }

  event(event: Record<string, unknown>) {
    if (this.handedOff) return;
    this.send({ type: "session_event", sessionId: this.latestSnapshot.sessionId, generation: this.generation, event });
  }

  agentStarted() {
    this.currentRunId = randomUUID();
    this.snapshot("running");
  }

  settled(aborted: boolean) {
    if (this.handedOff) return;
    this.snapshot("idle");
    this.send({ type: "agent_settled", sessionId: this.latestSnapshot.sessionId, generation: this.generation, runId: this.currentRunId, aborted });
  }

  promptStarted(kind: string, title?: string) {
    if (this.handedOff) return;
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
    for (const [requestId, pending] of this.controlRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Pi Inbox runtime disposed"));
      this.controlRequests.delete(requestId);
    }
    this.readyWaiters.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.setStatus(undefined);
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: PiInboxRuntime | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_INBOX_DISABLED === "1") return;
    if (isSubagentSession(process.env, ctx.sessionManager.getSessionFile())) return;
    runtime?.dispose();
    runtime = new PiInboxRuntime(pi, ctx);
    await runtime.start();
  });
  pi.on("session_shutdown", async () => {
    runtime?.dispose();
    runtime = undefined;
  });
  bindHandoffEvents(pi.events, () => runtime);
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
