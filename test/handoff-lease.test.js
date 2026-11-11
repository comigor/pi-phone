import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { InboxHub } from "../server/index.js";
import { agentSignaturePayload } from "../server/protocol.js";
import { bindHandoffEvents } from "../extension/handoff-bridge.ts";

const piBoltExecutable = process.env.PI_INBOX_TEST_PI_BOLT;

function messageQueue(socket) {
  const messages = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.find((item) => item.predicate(message));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  return (predicate = () => true, timeoutMs = 5000) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timeout = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
}

async function openSocket(url, options = {}) {
  const socket = new WebSocket(url, options);
  const next = messageQueue(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, next };
}

function makeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    hostId: randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

async function connectHost(address, hostIdentity) {
  const challengeUrl = new URL(`http://127.0.0.1:${address.port}/challenge`);
  for (const [key, value] of Object.entries({ hostId: hostIdentity.hostId, publicKey: hostIdentity.publicKey, name: "macbook" })) {
    challengeUrl.searchParams.set(key, value);
  }
  const response = await fetch(challengeUrl);
  assert.equal(response.status, 200);
  const challenge = await response.json();
  const privateKey = createPrivateKey({ key: Buffer.from(hostIdentity.privateKey, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(agentSignaturePayload(hostIdentity.hostId, challenge.nonce)), privateKey).toString("base64");
  const wsUrl = new URL(`ws://127.0.0.1:${address.port}/ws`);
  for (const [key, value] of Object.entries({ hostId: hostIdentity.hostId, publicKey: hostIdentity.publicKey, nonce: challenge.nonce, signature })) {
    wsUrl.searchParams.set(key, value);
  }
  const conn = await openSocket(wsUrl);
  return { ...conn, challenge };
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

test("PI_INBOX_AUTO_PAIR_LOCAL auto-approves loopback agents on challenge", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-autopair-"));
  const hub = await InboxHub.create({
    dataDir: path.join(tempDir, "data"),
    publicDir: path.resolve("public"),
    publicUrl: "http://127.0.0.1:8091",
    autoPairLocal: true
  });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  t.after(async () => {
    await hub.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const hostIdentity = makeIdentity();
  const conn = await connectHost(hub.addresses().agent, hostIdentity);
  t.after(() => conn.socket.close());
  assert.equal(conn.challenge.paired, true);
  const paired = await conn.next((msg) => msg.type === "paired");
  assert.equal(paired.type, "paired");
});

test("handoff lease keeps the same Plannotator thread and project while laptop is offline, blocks cross-session escalation, and fences cleanly", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-lease-"));
  const hub = await InboxHub.create({
    dataDir: path.join(tempDir, "data"),
    publicDir: path.resolve("public"),
    publicUrl: "http://127.0.0.1:8091",
    autoPairLocal: true
  });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  t.after(async () => {
    await hub.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const addresses = hub.addresses();
  const doorBase = `http://127.0.0.1:${addresses.door.port}/api/inbox/device`;
  const hostIdentity = makeIdentity();
  const laptop = await connectHost(addresses.agent, hostIdentity);
  await laptop.next((msg) => msg.type === "paired");

  const sessionId = randomUUID();
  const laptopGen = randomUUID();
  const originCwd = "/Users/igor/Projects/demo-app";
  laptop.socket.send(JSON.stringify({
    type: "session_upsert",
    sessionId,
    generation: laptopGen,
    session: {
      sessionId,
      generation: laptopGen,
      cwd: originCwd,
      name: "demo-app",
      model: "anthropic/claude-opus-4-6",
      status: "idle",
      messages: [
        { id: "m1", role: "user", text: "Start local work" },
        { id: "m2", role: "assistant", text: "Local progress ready" }
      ]
    }
  }));

  const sessionKey = `${hostIdentity.hostId}:${sessionId}`;
  await waitFor(() => hub.store.getSession(sessionKey)?.online);

  const { machine } = hub.virtual.offer(hub.store.getHost(hostIdentity.hostId));
  machine.linkedAt = new Date().toISOString();
  await hub.virtual.persist();
  const doorHeaders = { authorization: `Bearer ${machine.token}`, "content-type": "application/json" };

  const beforeList = await (await fetch(`${doorBase}/threads`, { headers: doorHeaders })).json();
  const initialRow = beforeList.sections.flatMap((section) => section.threads)[0];
  assert.ok(initialRow);
  const initialThreadId = initialRow.thread_id;
  const initialProjectId = initialRow.project_id;

  laptop.socket.send(JSON.stringify({
    type: "handoff_issue",
    requestId: "issue-1",
    sessionId,
    cwd: originCwd,
    name: "demo-app",
    target: "fargate"
  }));
  const issued = await laptop.next((msg) => msg.type === "handoff_issue_result");
  assert.equal(issued.ok, true);
  assert.match(issued.token, /^hnd_/);

  laptop.socket.send(JSON.stringify({
    type: "session_patch",
    sessionId,
    generation: laptopGen,
    session: {
      sessionId,
      generation: laptopGen,
      cwd: originCwd,
      name: "demo-app",
      status: "idle",
      messages: [{ id: "stale-local", role: "assistant", text: "Should not appear" }]
    }
  }));

  laptop.socket.close();
  await waitFor(() => !hub.store.getHost(hostIdentity.hostId)?.online);

  const beforeThread = await (await fetch(`${doorBase}/threads/${initialThreadId}`, { headers: doorHeaders })).json();
  const queuedReply = await fetch(`${doorBase}/messages/${beforeThread.thread.messages.at(-1).id}/reply`, {
    method: "POST",
    headers: doorHeaders,
    body: JSON.stringify({ idempotency_key: "offline-mobile-reply", words: "Continue on Fargate", seen_through_seq: beforeThread.cursor })
  });
  assert.equal(queuedReply.status, 202);

  const remoteWsUrl = new URL(`ws://127.0.0.1:${addresses.agent.port}/ws`);
  const remote = await openSocket(remoteWsUrl, { headers: { authorization: `Bearer ${issued.token}` } });
  const remotePaired = await remote.next((msg) => msg.type === "paired");
  assert.equal(remotePaired.handoff.sessionId, sessionId);

  const remoteGen = randomUUID();
  remote.socket.send(JSON.stringify({
    type: "session_upsert",
    sessionId,
    generation: remoteGen,
    session: {
      sessionId,
      generation: remoteGen,
      cwd: "/workspace/demo-app-handoff",
      name: "demo-app",
      model: "anthropic/claude-opus-4-6",
      status: "idle",
      messages: [
        { id: "m1", role: "user", text: "Start local work" },
        { id: "m2", role: "assistant", text: "Local progress ready" },
        { id: "m3", role: "assistant", text: "Remote task booted" }
      ]
    }
  }));

  const flushed = await remote.next((msg) => msg.type === "reply");
  assert.equal(flushed.text, "Continue on Fargate");
  remote.socket.send(JSON.stringify({
    type: "reply_result",
    requestId: flushed.requestId,
    sessionId,
    generation: remoteGen,
    ok: true
  }));

  await waitFor(() => hub.store.getSession(sessionKey)?.messages.some((m) => m.id === "m3"));
  const stored = hub.store.getSession(sessionKey);
  assert.equal(stored.cwd, originCwd);
  assert.equal(stored.remoteCwd, "/workspace/demo-app-handoff");
  assert.equal(stored.messages.some((m) => m.id === "stale-local"), false);

  const sseController = new AbortController();
  const sseResponse = await fetch(`${doorBase}/events`, { headers: doorHeaders, signal: sseController.signal });
  assert.equal(sseResponse.status, 200);
  sseController.abort();

  const duringList = await (await fetch(`${doorBase}/threads`, { headers: doorHeaders })).json();
  const remoteRows = duringList.sections.flatMap((section) => section.threads);
  assert.equal(remoteRows.length, 1);
  assert.equal(remoteRows[0].thread_id, initialThreadId);
  assert.equal(remoteRows[0].project_id, initialProjectId);

  remote.socket.send(JSON.stringify({
    type: "session_upsert",
    sessionId: "other-session",
    generation: randomUUID(),
    session: { sessionId: "other-session", generation: randomUUID(), cwd: "/tmp", status: "idle", messages: [{ id: "x", role: "assistant", text: "nope" }] }
  }));
  const crossSessionErr = await remote.next((msg) => msg.type === "error");
  assert.match(crossSessionErr.error, /outside handoff lease/);

  remote.socket.send(JSON.stringify({ type: "handoff_fence", requestId: "bad", sessionId }));
  const forbiddenErr = await remote.next((msg) => msg.type === "error");
  assert.match(forbiddenErr.error, /Forbidden on handoff lease/);

  const laptopBack = await connectHost(addresses.agent, hostIdentity);
  t.after(() => laptopBack.socket.close());
  await laptopBack.next((msg) => msg.type === "paired");

  laptopBack.socket.send(JSON.stringify({
    type: "handoff_fence",
    requestId: "fence-1",
    sessionId,
    leaseId: issued.leaseId
  }));
  const fencedAck = await laptopBack.next((msg) => msg.type === "handoff_fence_result");
  assert.equal(fencedAck.ok, true);
  assert.equal(fencedAck.fenced, true);

  const remoteFencedNotice = await remote.next((msg) => msg.type === "handoff_fenced");
  assert.equal(remoteFencedNotice.sessionId, sessionId);
  await waitFor(() => remote.socket.readyState === WebSocket.CLOSED);

  await assert.rejects(openSocket(remoteWsUrl, { headers: { authorization: `Bearer ${issued.token}` } }));

  const resumedGen = randomUUID();
  laptopBack.socket.send(JSON.stringify({
    type: "session_patch",
    sessionId,
    generation: resumedGen,
    session: {
      sessionId,
      generation: resumedGen,
      cwd: originCwd,
      name: "demo-app",
      status: "idle",
      messages: [{ id: "m4", role: "assistant", text: "Back on laptop" }]
    }
  }));
  await waitFor(() => hub.store.getSession(sessionKey)?.messages.some((m) => m.id === "m4"));
});

test("bindHandoffEvents keeps central relay strictly opt-in and never acts from a lease runtime", async () => {
  const bus = new EventEmitter();
  let issuedTarget = null;
  let fencedArgs = null;
  let leaseMode = false;

  const controller = {
    get isHandoffLease() {
      return leaseMode;
    },
    async issueHandoffLease(target) {
      issuedTarget = target;
      return { relayUrl: "wss://inbox-relay.borges.dev", token: "hnd_test123", leaseId: "hl_1" };
    },
    async fenceHandoffLease(sessionId, leaseId) {
      fencedArgs = { sessionId, leaseId };
    }
  };

  bindHandoffEvents(bus, () => controller);

  const tasks = [];
  bus.emit("handoff:before-dispatch", {
    sessionId: "s1",
    target: "fargate",
    useInboxRelay: false,
    register: (task) => tasks.push(task)
  });
  assert.equal(tasks.length, 0);
  assert.equal(issuedTarget, null);

  bus.emit("handoff:before-dispatch", {
    sessionId: "s1",
    target: "fargate",
    useInboxRelay: true,
    register: (task) => tasks.push(task)
  });
  assert.equal(tasks.length, 1);
  const result = await tasks[0];
  assert.equal(issuedTarget, "fargate");
  assert.deepEqual(result, {
    env: { PI_INBOX_RELAY_URL: "wss://inbox-relay.borges.dev", PI_INBOX_HANDOFF_TOKEN: "hnd_test123" },
    leaseId: "hl_1"
  });

  const fenceTasks = [];
  bus.emit("handoff:before-pull", {
    sessionId: "s1",
    leaseId: "hl_1",
    register: (task) => fenceTasks.push(task)
  });
  assert.equal(fenceTasks.length, 1);
  await fenceTasks[0];
  assert.deepEqual(fencedArgs, { sessionId: "s1", leaseId: "hl_1" });

  leaseMode = true;
  const ignored = [];
  bus.emit("handoff:before-dispatch", {
    sessionId: "s1",
    target: "fargate",
    useInboxRelay: true,
    register: (task) => ignored.push(task)
  });
  assert.equal(ignored.length, 0);
});

test("real Pi-Bolt attaches to an existing session thread using PI_INBOX_HANDOFF_TOKEN without creating identity.json", { skip: !piBoltExecutable, timeout: 45000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-bolt-lease-"));
  const hub = await InboxHub.create({
    dataDir: path.join(tempDir, "data"),
    publicDir: path.resolve("public"),
    publicUrl: "http://127.0.0.1:8091",
    autoPairLocal: true
  });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });

  const hostIdentity = makeIdentity();
  const laptop = await connectHost(hub.addresses().agent, hostIdentity);
  await laptop.next((msg) => msg.type === "paired");

  const sessionId = randomUUID();
  const originCwd = "/Users/igor/Projects/bolt-handoff";
  laptop.socket.send(JSON.stringify({
    type: "handoff_issue",
    requestId: "bolt-issue",
    sessionId,
    cwd: originCwd,
    name: "bolt-handoff",
    target: "fargate"
  }));
  const issued = await laptop.next((msg) => msg.type === "handoff_issue_result");
  laptop.socket.close();

  const remoteWorkspace = path.join(tempDir, "remote-workspace");
  const sessionDir = path.join(tempDir, "sessions");
  const remoteStateDir = path.join(tempDir, "remote-state");
  await mkdir(remoteWorkspace, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const sessionFile = path.join(sessionDir, `2026-11-11T00-00-00-000Z_${sessionId}.jsonl`);
  const entries = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-11-11T00:00:00.000Z", cwd: remoteWorkspace }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-11-11T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Handed off prompt" }], timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-11-11T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Handed off answer from Pi-Bolt" }], stopReason: "stop", timestamp: 2 } })
  ].join("\n") + "\n";
  await writeFile(sessionFile, entries);

  const child = spawn(piBoltExecutable, ["--mode", "rpc", "--session", sessionFile, "--no-extensions", "--no-mcp", "-e", path.resolve("extension/pi-inbox.ts")], {
    cwd: remoteWorkspace,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(tempDir, "agent"),
      PI_INBOX_STATE_DIR: remoteStateDir,
      PI_INBOX_RELAY_URL: `ws://127.0.0.1:${hub.addresses().agent.port}`,
      PI_INBOX_HANDOFF_TOKEN: issued.token
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await hub.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const sessionKey = `${hostIdentity.hostId}:${sessionId}`;
  await waitFor(() => {
    const s = hub.store.getSession(sessionKey);
    return s?.online && s.messages.some((m) => m.text === "Handed off answer from Pi-Bolt");
  }, 20000);

  const synced = hub.store.getSession(sessionKey);
  assert.equal(synced.cwd, originCwd);
  assert.equal(existsSync(path.join(remoteStateDir, "identity.json")), false);
});
