import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { InboxHub } from "../server/index.js";
import { PlannotatorRuntime } from "../server/plannotator.js";
import { agentSignaturePayload } from "../server/protocol.js";
import { VirtualMachines } from "../server/virtual-machines.js";

const binary = process.env.PLANNOTATOR_TEST_BINARY || "plannotator";
const available = spawnSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" }).status === 0;

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    hostId: randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

async function connectAgent(address, id) {
  const challengeUrl = new URL(`http://127.0.0.1:${address.port}/challenge`);
  for (const [key, value] of Object.entries({ hostId: id.hostId, publicKey: id.publicKey, name: "contract-host" })) challengeUrl.searchParams.set(key, value);
  const challenge = await (await fetch(challengeUrl)).json();
  const privateKey = (await import("node:crypto")).createPrivateKey({ key: Buffer.from(id.privateKey, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(agentSignaturePayload(id.hostId, challenge.nonce)), privateKey).toString("base64");
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  for (const [key, value] of Object.entries({ hostId: id.hostId, publicKey: id.publicKey, nonce: challenge.nonce, signature })) url.searchParams.set(key, value);
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

test("legacy text-only image replies stay in their original position", () => {
  const virtual = new VirtualMachines({ dataDir: "/tmp" });
  const session = {
    key: "host:session", sessionId: "session", cwd: "/workspace", name: "session", status: "idle", updatedAt: "2026-11-08T23:00:00.000Z",
    messages: [
      { id: "user", role: "user", text: "this message should have an image", images: [] },
      { id: "assistant", role: "assistant", text: "Current answer", images: [] }
    ],
    remoteReplies: [{ id: "relay:legacy", role: "user", text: "this message should have an image", attachments: [{ data: Buffer.from("old-png"), mimeType: "image/png" }] }]
  };
  const messages = virtual.messagesFor(session);
  assert.deepEqual(messages.map((message) => message.body), ["this message should have an image", "Current answer"]);
  assert.equal(messages[0].id, virtual.virtualMessage(session, session.remoteReplies[0], 0).id);
});

test("full-history updates project only the latest message", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-projection-"));
  const virtual = new VirtualMachines({ dataDir });
  virtual.machines.set("host", { cursor: 0 });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const session = {
    key: "host:session", hostId: "host", sessionId: "session", cwd: "/workspace", name: "session", status: "idle", updatedAt: "2026-11-08T23:00:00.000Z",
    messages: Array.from({ length: 1705 }, (_, index) => ({ id: `m${index}`, role: "assistant", text: `Message ${index}`, images: [] })), remoteReplies: []
  };
  let projections = 0;
  const project = virtual.virtualMessage;
  virtual.virtualMessage = function (...args) { projections++; return project.apply(this, args); };
  await virtual.changed(session);
  virtual.row(session);
  assert.equal(projections, 1);
});

test("history refreshes only project new or changed messages", () => {
  const virtual = new VirtualMachines({ dataDir: "/tmp" });
  const session = {
    key: "host:session", hostId: "host", sessionId: "session", cwd: "/workspace", name: "session", status: "idle", updatedAt: "2026-11-08T23:00:00.000Z",
    messages: [{ id: "one", role: "assistant", text: "one" }, { id: "two", role: "assistant", text: "two" }], remoteReplies: []
  };
  let projections = 0;
  const project = virtual.virtualMessage;
  virtual.virtualMessage = function (...args) { projections++; return project.apply(this, args); };
  const first = virtual.messagesFor(session);
  assert.equal(projections, 2);
  assert.deepEqual(virtual.messagesFor(session), first);
  assert.equal(projections, 2);
  session.messages.push({ id: "three", role: "assistant", text: "three" });
  virtual.messagesFor(session);
  assert.equal(projections, 3);
  session.messages[0] = { ...session.messages[0], text: "changed" };
  virtual.messagesFor(session);
  assert.equal(projections, 4);
  session.acks = { [first[0].id]: { emoji: "👍" } };
  virtual.messagesFor(session);
  assert.equal(projections, 5);
});

test("virtual change bursts emit one latest-message notification", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-changes-"));
  const virtual = new VirtualMachines({ dataDir });
  virtual.machines.set("host", { cursor: 0 });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const session = { key: "host:session", hostId: "host", sessionId: "session", cwd: "/workspace", name: "session", status: "idle", updatedAt: "2026-11-08T23:00:00.000Z", messages: [{ id: "one", role: "assistant", text: "one" }], remoteReplies: [] };
  const writes = [];
  virtual.streams.set("host", new Set([{ write: (value) => writes.push(value) }]));
  const first = virtual.changed(session);
  session.messages.push({ id: "two", role: "assistant", text: "two" });
  await Promise.all([first, virtual.changed(session), virtual.changed(session)]);
  assert.equal(virtual.machines.get("host").cursor, 1);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes("two"));
});

test("empty startup sessions stay out of Plannotator and deep links", () => {
  const empty = { key: "host:empty", hostId: "host", sessionId: "empty", cwd: "/workspace", name: "poke-s3", status: "idle", updatedAt: "2026-11-09T13:07:53.989Z", messages: [], remoteReplies: [] };
  const active = { ...empty, key: "host:active", sessionId: "active", messages: [{ id: "m1", role: "assistant", text: "Ready" }] };
  const virtual = new VirtualMachines({ dataDir: "/tmp", store: { state: { sessions: [empty, active] } } });
  const machine = { hostId: "host", inboxId: "machine", cursor: 0 };
  virtual.machines.set("host", machine);
  const rows = virtual.list(machine).sections.flatMap((section) => section.threads);
  assert.deepEqual(rows.map((row) => row.thread_id), [virtual.row(active).thread_id]);
  assert.equal(virtual.findThread(virtual.row(empty).thread_id), undefined);
  assert.equal(virtual.session(machine, virtual.row(empty).thread_id), undefined);
});

test("attachment listing makes one pass over session history", () => {
  const virtual = new VirtualMachines({ dataDir: "/tmp" });
  const session = {
    key: "host:session", sessionId: "session", cwd: "/workspace", name: "session", status: "idle", updatedAt: "2026-11-08T23:00:00.000Z",
    messages: Array.from({ length: 1705 }, (_, index) => ({ id: `m${index}`, role: "assistant", text: `Message ${index}`, images: index === 1704 ? [{ data: "aW1hZ2U=", mimeType: "image/png" }] : [] })), remoteReplies: []
  };
  let legacyScans = 0;
  virtual.attachmentsFor = () => { legacyScans++; return []; };
  const attachments = virtual.persistedAttachments(session);
  assert.equal(legacyScans, 0);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].data.toString(), "image");
});

test("Artifacts exposes the complete viewer attachment contract", () => {
  const virtual = new VirtualMachines({ dataDir: "/tmp" });
  const message = { id: "image-message", role: "assistant", text: "Screenshot", createdAt: "2026-11-08T23:00:00.000Z", images: [{ name: "image-1.png", data: "aW1hZ2U=", mimeType: "image/png" }] };
  const session = { key: "host:session", sessionId: "session", cwd: "/workspace", name: "session", status: "idle", updatedAt: "2026-11-08T23:00:00.000Z", messages: [message], remoteReplies: [] };
  const attachment = virtual.attachmentsModel(session).attachments[0];
  for (const field of ["path", "named_path", "sent_sha256", "sent_at", "sent_mtime", "message_id", "current", "changed_since_sent", "unavailable", "media_type"]) {
    assert.notEqual(attachment[field], undefined, `${field} is required by AttachmentPane`);
  }
  assert.equal(attachment.path, "image-1.png");
  assert.equal(attachment.message_id, virtual.virtualMessage(session, message, 0).id);
  assert.equal(attachment.current.sha256, attachment.sent_sha256);
  assert.equal(attachment.changed_since_sent, false);
  assert.equal(attachment.unavailable, null);
});

test("tool activity is hidden from persisted histories", () => {
  const virtual = new VirtualMachines({ dataDir: "/tmp" });
  const session = {
    key: "host:session", sessionId: "session", cwd: "/workspace", name: "session", status: "idle", updatedAt: "2026-11-08T23:00:00.000Z", remoteReplies: [],
    messages: [
      { id: "question", role: "user", text: "Question" },
      { id: "working", role: "assistant", text: "Working", toolCalls: [{ name: "bash", arguments: {} }] },
      { id: "result", role: "toolResult", text: "Raw output" },
      { id: "answer", role: "assistant", text: "Final answer", toolCalls: [] }
    ]
  };
  assert.deepEqual(virtual.messagesFor(session).map((message) => message.body), ["Question", "Final answer"]);
  assert.equal(virtual.row(session).message_count, 2);
});


test("offline replies are accepted and delivered on reconnect", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-offline-reply-"));
  const hub = await InboxHub.create({ dataDir: temporary, publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const agentIdentity = identity();
  const agent = await connectAgent(hub.addresses().agent, agentIdentity);
  let reconnected;
  t.after(async () => {
    agent.terminate();
    reconnected?.terminate();
    await hub.close();
    await rm(temporary, { recursive: true, force: true });
  });
  await nextMessage(agent, "pairing_required");
  const paired = nextMessage(agent, "paired");
  await fetch(`http://127.0.0.1:${hub.addresses().viewer.port}/api/hosts/${agentIdentity.hostId}/approve`, { method: "POST" });
  await paired;
  const sessionId = randomUUID();
  const generation = randomUUID();
  agent.send(JSON.stringify({
    type: "session_upsert", sessionId, generation,
    session: { sessionId, generation, cwd: "/workspace/offline", name: "offline-reply", status: "idle", messages: [{ id: "root", role: "assistant", text: "Waiting" }] }
  }));
  const key = `${agentIdentity.hostId}:${sessionId}`;
  await waitFor(() => hub.store.getSession(key));
  const machine = hub.virtual.offer(hub.store.getHost(agentIdentity.hostId)).machine;
  const messageId = hub.virtual.virtualMessage(hub.store.getSession(key), hub.store.getSession(key).messages[0], 0).id;
  agent.close();
  await waitFor(() => hub.store.getSession(key).online === false ? true : undefined);
  const reply = () => fetch(`http://127.0.0.1:${hub.addresses().door.port}/api/inbox/device/messages/${messageId}/reply`, {
    method: "POST", headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: "offline-reply", words: "Deliver on reconnect", seen_through_seq: 1 })
  });
  const accepted = await reply();
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).outbox.key, "offline-reply");
  assert.equal(hub.store.getSession(key).pendingReplies.length, 1);
  assert.equal((await reply()).status, 202);
  assert.equal(hub.store.getSession(key).pendingReplies.length, 1);

  reconnected = await connectAgent(hub.addresses().agent, agentIdentity);
  const delivered = nextMessage(reconnected, "reply");
  const nextGeneration = randomUUID();
  reconnected.send(JSON.stringify({
    type: "session_upsert", sessionId, generation: nextGeneration,
    session: { sessionId, generation: nextGeneration, cwd: "/workspace/offline", name: "offline-reply", status: "idle", messages: [{ id: "root", role: "assistant", text: "Waiting" }] }
  }));
  const request = await delivered;
  assert.equal(request.text, "Deliver on reconnect");
  reconnected.send(JSON.stringify({ type: "reply_result", requestId: request.requestId, sessionId, generation: nextGeneration, ok: true }));
  await waitFor(() => hub.store.getSession(key).pendingReplies.length === 0 && hub.store.getSession(key).remoteReplies.length === 1 ? true : undefined);
});

test("host launches and resumes a Pi session over its existing WSS connection", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-launch-"));
  const hub = await InboxHub.create({ dataDir: temporary, publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const agentIdentity = identity();
  const bystander = await connectAgent(hub.addresses().agent, agentIdentity);
  const parent = await connectAgent(hub.addresses().agent, agentIdentity);
  const children = [bystander];
  t.after(async () => {
    for (const child of children) child.terminate();
    parent.terminate();
    await hub.close();
    await rm(temporary, { recursive: true, force: true });
  });
  await nextMessage(parent, "pairing_required");
  const paired = nextMessage(parent, "paired");
  await fetch(`http://127.0.0.1:${hub.addresses().viewer.port}/api/hosts/${agentIdentity.hostId}/approve`, { method: "POST" });
  await paired;
  parent.send(JSON.stringify({ type: "host_hello", launch: { agents: ["pi"], home: "/Users/igor" } }));
  const parentSession = randomUUID();
  const parentGeneration = randomUUID();
  parent.send(JSON.stringify({
    type: "session_upsert", sessionId: parentSession, generation: parentGeneration,
    session: { sessionId: parentSession, generation: parentGeneration, cwd: "/Users/igor/Projects/pi-phone", name: "pi-phone", status: "idle", messages: [{ id: "parent-message", role: "assistant", text: "Ready" }] }
  }));
  await waitFor(() => hub.store.getSession(`${agentIdentity.hostId}:${parentSession}`));
  const machine = hub.virtual.offer(hub.store.getHost(agentIdentity.hostId)).machine;
  const door = `http://127.0.0.1:${hub.addresses().door.port}/api/inbox/device`;
  const doorRequest = (route, init = {}) => fetch(`${door}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json", "x-plannotator-window": "1", ...(init.headers || {}) }
  });
  const health = await waitFor(async () => {
    const response = await doorRequest("/health");
    const body = await response.json();
    return body.launch_from_machines === 1 ? body : null;
  });
  assert.equal(health.machine_links, 1);
  const discovery = await (await doorRequest("/sessions")).json();
  assert.deepEqual(discovery.launch.agents.map((agent) => agent.agent), ["pi"]);
  const project = discovery.launch.projects.find((item) => item.root === "/Users/igor/Projects/pi-phone");
  assert.ok(project);

  const refused = await doorRequest("/messages", {
    method: "POST", headers: { "x-plannotator-window": "0" },
    body: JSON.stringify({ idempotency_key: "not-a-window", body: "No launch", to: { launch: { agent: "pi", project_id: project.id } } })
  });
  assert.equal(refused.status, 403);

  const startMessage = nextMessage(parent, "launch_start");
  const launchResponsePromise = doorRequest("/messages", {
    method: "POST",
    body: JSON.stringify({ idempotency_key: "launch-contract", body: "Investigate the relay", thread_name: "Relay investigation", to: { launch: { agent: "pi", project_id: project.id } } })
  });
  const start = await startMessage;
  assert.equal(start.cwd, "/Users/igor/Projects/pi-phone");
  assert.equal(start.name, "Relay investigation");
  parent.send(JSON.stringify({ type: "launch_result", requestId: start.requestId, launchId: start.launchId, ok: true }));
  const child = await connectAgent(hub.addresses().agent, agentIdentity);
  children.push(child);
  const firstDelivery = nextMessage(child, "reply");
  const childGeneration = randomUUID();
  child.send(JSON.stringify({
    type: "session_upsert", sessionId: start.sessionId, generation: childGeneration,
    session: { sessionId: start.sessionId, generation: childGeneration, cwd: start.cwd, name: start.name, status: "idle", messages: [] }
  }));
  const delivered = await firstDelivery;
  assert.equal(delivered.text, "Investigate the relay");
  child.send(JSON.stringify({ type: "reply_result", requestId: delivered.requestId, sessionId: start.sessionId, generation: childGeneration, ok: true }));
  const launchResponse = await launchResponsePromise;
  const launchBody = await launchResponse.text();
  assert.equal(launchResponse.status, 200, launchBody);
  const launched = JSON.parse(launchBody);
  assert.equal(launched.launch.state, "starting");
  assert.equal(launched.message.body, "Investigate the relay");
  assert.equal(launched.message.launch.agent, "pi");
  assert.equal(launched.message.launch.session_ref, start.sessionId);

  const stopMessage = nextMessage(parent, "launch_stop");
  const stopResponsePromise = doorRequest(`/launch/${launched.launch.id}/stop`, { method: "POST", body: "{}" });
  const stop = await stopMessage;
  assert.equal(stop.sessionId, start.sessionId);
  parent.send(JSON.stringify({ type: "launch_result", requestId: stop.requestId, launchId: stop.launchId, ok: true }));
  assert.equal((await stopResponsePromise).status, 200);
  child.terminate();
  await waitFor(() => hub.store.getSession(`${agentIdentity.hostId}:${start.sessionId}`)?.online === false);

  const resumeMessage = nextMessage(parent, "launch_start");
  const resumeResponsePromise = doorRequest(`/messages/${launched.message.id}/reply`, {
    method: "POST", body: JSON.stringify({ idempotency_key: "resume-contract", words: "Continue after stop" })
  });
  const resumed = await resumeMessage;
  assert.equal(resumed.sessionId, start.sessionId);
  parent.send(JSON.stringify({ type: "launch_result", requestId: resumed.requestId, launchId: resumed.launchId, ok: true }));
  const resumedChild = await connectAgent(hub.addresses().agent, agentIdentity);
  children.push(resumedChild);
  const resumedDelivery = nextMessage(resumedChild, "reply");
  const resumedGeneration = randomUUID();
  resumedChild.send(JSON.stringify({
    type: "session_upsert", sessionId: start.sessionId, generation: resumedGeneration,
    session: { sessionId: start.sessionId, generation: resumedGeneration, cwd: start.cwd, name: start.name, status: "idle", messages: [] }
  }));
  const continued = await resumedDelivery;
  assert.equal(continued.text, "Continue after stop");
  resumedChild.send(JSON.stringify({ type: "reply_result", requestId: continued.requestId, sessionId: start.sessionId, generation: resumedGeneration, ok: true }));
  assert.equal((await resumeResponsePromise).status, 200);
});

test("an unchanged Plannotator links to a virtual Pi host and controls its session", { skip: !available, timeout: 60_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-virtual-"));
  const agentIdentity = identity();
  let runtime;
  const hub = await InboxHub.create({
    dataDir: path.join(temporary, "relay"),
    publicDir: path.resolve("public"),
    publicUrl: "http://localhost",
    linkMachine: (code) => runtime.link(code)
  });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const addresses = hub.addresses();
  const virtualAddress = `http://127.0.0.1:${addresses.door.port}`;
  hub.virtual.publicAddress = virtualAddress;
  runtime = await new PlannotatorRuntime({
    binary,
    dataDir: path.join(temporary, "central"),
    virtualAddress,
    env: { PLANNOTATOR_TEST_SANDBOX: "1", HOME: temporary }
  }).start();
  hub.plannotator = runtime;
  const central = runtime.url.origin;
  let agent = await connectAgent(addresses.agent, agentIdentity);
  const children = [];
  t.after(async () => {
    for (const child of children) child.terminate();
    agent.terminate();
    await hub.close();
    await runtime.stop();
    await rm(temporary, { recursive: true, force: true });
  });

  await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/hosts/${agentIdentity.hostId}/approve`, { method: "POST" });
  agent.send(JSON.stringify({ type: "host_hello", launch: { agents: ["pi"], home: "/Users/igor", creation: 1 } }));
  await waitFor(() => hub.store.getHost(agentIdentity.hostId)?.launch);
  const sessionId = randomUUID();
  const generation = randomUUID();
  agent.send(JSON.stringify({
    type: "session_upsert",
    sessionId,
    generation,
    session: {
      sessionId,
      generation,
      cwd: "/workspace/contract",
      name: "contract-session",
      model: "test/model",
      status: "running",
      messages: [{ id: "assistant-1", role: "assistant", text: "Remote assistant", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] }]
    }
  }));

  const machine = await waitFor(async () => {
    const response = await fetch(`${central}/api/inbox/machines`);
    const model = await response.json();
    return model.machines.find((item) => !item.self && item.state === "online");
  });
  const listed = await waitFor(async () => {
    const model = await (await fetch(`${central}/api/inbox/threads?machines=1`)).json();
    return model.sections.flatMap((section) => section.threads).find((row) => row.subject === "contract-session" && row.machine === machine.id);
  });
  assert.ok(listed.delivery === null || ["delivered", "undelivered", "saved", "sending", "queued"].includes(listed.delivery.state));
  const forwardedBase = `${central}/api/inbox/m/${machine.id}`;
  const opened = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
  assert.equal(opened.thread.messages[0].body, "Remote assistant");
  assert.ok(opened.thread.messages.some((message) => message.body.includes("Stop agent")));

  const centralHealth = await (await fetch(`${central}/api/inbox/health`)).json();
  const seen = (key, throughSeq) => fetch(`${forwardedBase}/threads/${listed.thread_id}/seen`, {
    method: "POST", headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: key, through_seq: throughSeq })
  });
  const seenResponse = await seen("seen-contract", opened.thread.messages[0].seq);
  assert.equal(seenResponse.status, 200);
  assert.equal((await seenResponse.json()).thread.unseen, 0);
  const afterSeen = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
  assert.equal(afterSeen.thread.messages[0].person_seen_seq, opened.thread.messages[0].seq);
  assert.equal(afterSeen.row.unseen, 0);
  assert.equal((await seen("seen-backwards-contract", 0)).status, 200);
  const afterBackwardsLook = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
  assert.equal(afterBackwardsLook.thread.messages[0].person_seen_seq, opened.thread.messages[0].seq);

  const publicThread = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/m/${machine.id}/threads/${listed.thread_id}`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(publicThread.headers.get("content-encoding"), "gzip");
  assert.equal((await publicThread.json()).thread.messages[0].body, "Remote assistant");

  const publicSearch = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/search?q=Remote+assistant`);
  assert.equal(publicSearch.status, 200);
  const searchModel = await publicSearch.json();
  assert.ok(searchModel.groups.messages.some((message) => message.thread_id === listed.thread_id && message.snippet.text === "Remote assistant"));

  const image = opened.thread.messages[0].attachments[0];
  const imageResponse = await fetch(`${forwardedBase}/attachments/${image.id}/image`);
  assert.equal(imageResponse.status, 200);
  assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString(), "image");

  const archiveWrite = (resolved) => fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/resolve`, {
    method: "POST", headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, resolved, idempotency_key: `archive-${resolved}-${randomUUID()}` })
  });
  assert.equal((await archiveWrite(true)).status, 200);
  const archivedModel = await (await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/threads/archived`)).json();
  assert.ok(archivedModel.threads.some((thread) => thread.thread_id === listed.thread_id && thread.machine === machine.id));
  await waitFor(async () => {
    const model = await (await fetch(`${central}/api/inbox/threads?machines=1`)).json();
    return model.sections.flatMap((section) => section.threads).every((thread) => thread.thread_id !== listed.thread_id) ? model : null;
  });
  assert.equal((await archiveWrite(false)).status, 200);
  const projectArchive = async (resolved) => {
    const response = await fetch(`${forwardedBase}/projects/${listed.project_id}/resolve`, {
      method: "POST", headers: { "content-type": "application/json", origin: central },
      body: JSON.stringify({
        serverSession: centralHealth.serverSession, resolved, idempotency_key: randomUUID(),
        ...(resolved ? { batch_id: randomUUID() } : { threads: { resolved: [listed.thread_id], read: [] } })
      })
    });
    const payload = await response.text();
    assert.equal(response.status, 200, payload);
    return JSON.parse(payload);
  };
  assert.deepEqual((await projectArchive(true)).batch.resolved, [listed.thread_id]);
  const restoreDelivery = nextMessage(agent, "reply");
  const restoreResponse = fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/reply`, {
    method: "POST", headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "restore-on-send-contract", words: "Restore this thread", seen_through_seq: opened.cursor })
  });
  const restoreRequest = await restoreDelivery;
  agent.send(JSON.stringify({ type: "reply_result", requestId: restoreRequest.requestId, sessionId, generation, ok: true }));
  assert.equal((await restoreResponse).status, 200);
  assert.equal(hub.store.getSession(`${agentIdentity.hostId}:${sessionId}`).resolvedAt, null);
  assert.deepEqual((await projectArchive(true)).batch.resolved, [listed.thread_id]);
  assert.deepEqual((await projectArchive(false)).threads.map((thread) => thread.thread_id), [listed.thread_id]);

  const pin = async (pinned) => {
    const response = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/threads/${listed.thread_id}/pin`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverSession: centralHealth.serverSession, pinned })
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const centralHasPin = async () => {
    const model = await (await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/threads?machines=1`)).json();
    return model.pins?.some((thread) => thread.thread_id === listed.thread_id);
  };
  const eventStream = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/events`, {
    headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(6_000)
  });
  const eventReader = eventStream.body.getReader();
  const pinEvent = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await eventReader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: pins")) return true;
    }
  })();
  const pinned = await pin(true);
  assert.ok(await pinEvent);
  await eventReader.cancel();
  const pinEntry = pinned.pins.find((thread) => thread.thread_id === listed.thread_id);
  assert.ok(pinEntry);
  await waitFor(async () => await centralHasPin() ? true : undefined);
  assert.ok(!(await pin(false)).pins.some((thread) => thread.thread_id === listed.thread_id));
  await waitFor(async () => !(await centralHasPin()) ? true : undefined);
  const restoredPin = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/pins`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, restore: { thread_id: listed.thread_id, index: 0, pinned_at: pinEntry.pinned_at } })
  });
  assert.equal(restoredPin.status, 200);
  assert.ok((await restoredPin.json()).pins.some((thread) => thread.thread_id === listed.thread_id));
  assert.ok(!(await pin(false)).pins.some((thread) => thread.thread_id === listed.thread_id));

  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  const snooze = async (value, expectedStatus = 200) => {
    const response = await fetch(`${forwardedBase}/threads/${listed.thread_id}/snooze`, {
      method: "POST", headers: { "content-type": "application/json", origin: central },
      body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: randomUUID(), until: value })
    });
    const payload = await response.text();
    assert.equal(response.status, expectedStatus, payload);
    return JSON.parse(payload);
  };
  assert.equal((await snooze(until)).snoozed.until, until);
  const snoozedList = await waitFor(async () => {
    const model = await (await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1`)).json();
    return model.snoozed?.some((thread) => thread.thread_id === listed.thread_id) ? model : null;
  });
  assert.ok(snoozedList.sections.flatMap((section) => section.threads).every((thread) => thread.thread_id !== listed.thread_id));
  assert.equal((await snooze(null)).snoozed, null);
  const expired = new Date(Date.now() - 60_000).toISOString();
  const expiredStatus = centralHealth.version === "0.28.48" ? 200 : 409;
  const expiredAnswer = await snooze(expired, expiredStatus);
  if (expiredStatus === 409) assert.equal(expiredAnswer.code, "snooze_past");
  else assert.equal(expiredAnswer.snoozed.until, expired);
  await hub.store.updateVirtualSession(`${agentIdentity.hostId}:${sessionId}`, { snoozedUntil: expired, snoozedAt: new Date().toISOString() });
  const expiredList = await (await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1`)).json();
  assert.ok(expiredList.snoozed.every((thread) => thread.thread_id !== listed.thread_id));
  assert.ok(expiredList.sections.flatMap((section) => section.threads).some((thread) => thread.thread_id === listed.thread_id));
  await snooze(null);
  const draft = await fetch(`${forwardedBase}/threads/${listed.thread_id}/draft`);
  assert.equal(draft.status, 200);
  assert.equal((await draft.json()).draft, null);

  const uploadResponse = await fetch(`${forwardedBase}/uploads?name=note.txt`, { method: "POST", headers: { "content-type": "text/plain" }, body: "persisted upload" });
  const draftUpload = (await uploadResponse.json()).upload;
  const reloadedVirtual = new VirtualMachines({ dataDir: path.join(temporary, "relay"), drafts: hub.drafts, store: hub.store });
  await reloadedVirtual.load();
  assert.equal(reloadedVirtual.uploads.get(draftUpload.upload_id).data.toString(), "persisted upload");

  const publicDraft = `http://127.0.0.1:${addresses.viewer.port}/api/inbox/m/${machine.id}/threads/${listed.thread_id}/draft`;
  const savedDraftResponse = await fetch(publicDraft, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Persistent draft", base: null, files: [{ upload_id: draftUpload.upload_id }], all_files: true }) });
  assert.equal(savedDraftResponse.status, 200);
  const savedDraft = (await savedDraftResponse.json()).draft;
  assert.equal(savedDraft.body, "Persistent draft");
  assert.equal(savedDraft.files[0].upload_id, draftUpload.upload_id);
  assert.equal((await (await fetch(`${forwardedBase}/threads/${listed.thread_id}/draft`)).json()).draft.body, "Persistent draft");
  const conflict = await fetch(publicDraft, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Stale editor", base: null }) });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "draft_conflict");
  const deleted = await fetch(`${publicDraft}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal((await deleted.json()).deleted, true);
  assert.equal((await (await fetch(publicDraft)).json()).draft, null);
  const taggable = await fetch(`${forwardedBase}/threads/${listed.thread_id}/taggable`);
  assert.equal(taggable.status, 200);
  assert.ok((await taggable.json()).sessions.some((item) => item.session === sessionId && item.owner && item.taggable));
  const tidy = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/tidy?project=${listed.project_id}`);
  assert.equal(tidy.status, 200);
  assert.deepEqual(await tidy.json(), { serverSession: centralHealth.serverSession, count: 0, agents: [], run: null });
  const outbox = await fetch(`${central}/api/inbox/outbox`);
  assert.equal(outbox.status, 200);
  assert.deepEqual(await outbox.json(), { waiting: [], notices: [] });
  const replyDelivery = nextMessage(agent, "reply");
  const replyResponse = fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "reply-contract", words: "Continue remotely", seen_through_seq: opened.cursor - 1 })
  });
  const delivered = await replyDelivery;
  assert.equal(delivered.text, "Continue remotely");
  agent.send(JSON.stringify({ type: "reply_result", requestId: delivered.requestId, sessionId, generation, ok: true }));
  const reply = await replyResponse;
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).thread, undefined);

  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("person-image")]);
  const upload = await fetch(`${forwardedBase}/uploads?name=person.png&idempotency_key=upload-contract`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", origin: central },
    body: png
  });
  assert.equal(upload.status, 200);
  const uploaded = (await upload.json()).upload;
  const withImage = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
  const imageReplyDelivery = nextMessage(agent, "reply");
  const imageReplyResponse = fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "image-reply-contract", words: "Inspect this image", seen_through_seq: withImage.cursor, uploads: [uploaded.upload_id] })
  });
  const imageReply = await imageReplyDelivery;
  assert.equal(imageReply.attachments[0].data, png.toString("base64"));
  assert.equal(imageReply.attachments[0].mimeType, "image/png");
  agent.send(JSON.stringify({ type: "reply_result", requestId: imageReply.requestId, sessionId, generation, ok: true }));
  const imageReplyResult = await imageReplyResponse;
  assert.equal(imageReplyResult.status, 200);
  const imageReplyBody = await imageReplyResult.json();
  const uploadedImage = imageReplyBody.reply.attachments[0];
  assert.equal(uploadedImage.mime_type, "image/png");
  const persistedMessages = [
    { id: "assistant-1", role: "assistant", text: "Remote assistant", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] },
    { id: "user-continue", role: "user", text: "Continue remotely", images: [] },
    { id: "user-image", role: "user", text: "Inspect this image\n\n[Image: original 1x1, displayed at 1x1.]", images: [{ data: Buffer.from("transcoded-jpeg").toString("base64"), mimeType: "image/jpeg" }] },
    { id: "user-restore", role: "user", text: "Restore this thread", images: [] },
    { id: "assistant-2", role: "assistant", text: "Image answer", images: [] }
  ];
  const publishPersisted = (status) => agent.send(JSON.stringify({
    type: "session_upsert", sessionId, generation,
    session: { sessionId, generation, cwd: "/workspace/contract", name: "contract-session", model: "test/model", status, messages: persistedMessages }
  }));
  publishPersisted("idle");
  const reconciledImage = await waitFor(async () => {
    const model = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
    const conversation = model.thread.messages.filter((message) => message.seq > 0);
    const copies = conversation.filter((message) => message.body.startsWith("Inspect this image"));
    return copies.length === 1 && conversation.at(-1)?.body === "Image answer" ? model : null;
  });
  assert.equal(reconciledImage.thread.messages.filter((message) => message.body.startsWith("Inspect this image")).length, 1);
  publishPersisted("running");
  await waitFor(async () => (await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json()).thread.messages.some((message) => message.body.includes("Stop agent")));
  const persistedImage = await fetch(`${forwardedBase}/attachments/${uploadedImage.id}/image`);
  assert.equal(persistedImage.status, 200);
  assert.equal(Buffer.from(await persistedImage.arrayBuffer()).toString("base64"), png.toString("base64"));
  const beforeImageOnly = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
  const imageOnlyDelivery = nextMessage(agent, "reply");
  const imageOnlyResponse = fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "image-only-contract", words: "", seen_through_seq: beforeImageOnly.cursor, uploads: [uploaded.upload_id] })
  });
  const imageOnly = await imageOnlyDelivery;
  assert.equal(imageOnly.text, "Image attached");
  assert.equal(imageOnly.attachments[0].mimeType, "image/png");
  agent.send(JSON.stringify({ type: "reply_result", requestId: imageOnly.requestId, sessionId, generation, ok: true }));
  assert.equal((await imageOnlyResponse).status, 200);

  const annotationResponse = await fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "annotation-contract", annotation: {
      id: "ann-contract", blockId: "block-1", startOffset: 0, endOffset: 6, type: "COMMENT", text: "Clarify this", originalText: "Remote", createdA: 1
    } })
  });
  assert.equal(annotationResponse.status, 200);
  const annotation = (await annotationResponse.json()).annotation;
  assert.equal(annotation.message_id, opened.thread.messages[0].id);
  const pendingAttachments = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}/attachments`)).json();
  assert.equal(pendingAttachments.annotations.length, 1);
  const beforeAnnotationReply = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
  const annotationReplyDelivery = nextMessage(agent, "reply");
  const annotationReplyResponse = fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({
      serverSession: centralHealth.serverSession, idempotency_key: "annotation-reply-contract", words: "Address the comment",
      feedback: "# Feedback on your messages\n\n> Clarify this", annotation_ids: ["ann-contract"], seen_through_seq: beforeAnnotationReply.cursor
    })
  });
  const annotationReply = await annotationReplyDelivery;
  assert.match(annotationReply.text, /Address the comment/);
  assert.match(annotationReply.text, /Clarify this/);
  agent.send(JSON.stringify({ type: "reply_result", requestId: annotationReply.requestId, sessionId, generation, ok: true }));
  assert.equal((await annotationReplyResponse).status, 200);
  const sentAttachments = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}/attachments`)).json();
  assert.equal(sentAttachments.annotations.length, 0);

  const ackDelivery = nextMessage(agent, "reply");
  const ackResponse = fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "ack-contract", ack: true })
  });
  const ack = await ackDelivery;
  assert.match(ack.text, /Looks good/);
  assert.match(ack.text, new RegExp(opened.thread.messages[0].id));
  agent.send(JSON.stringify({ type: "reply_result", requestId: ack.requestId, sessionId, generation, ok: true }));
  assert.equal((await ackResponse).status, 200);

  const stopDelivery = nextMessage(agent, "stop");
  const control = opened.thread.messages.find((message) => message.body.includes("Stop agent"));
  const stoppedResponse = fetch(`${forwardedBase}/messages/${control.id}/picks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "stop-contract", picks: [{ question: "q-stop", choice: "Stop agent" }] })
  });
  const stop = await stopDelivery;
  agent.send(JSON.stringify({ type: "stop_result", requestId: stop.requestId, sessionId, generation, ok: true }));
  const stopped = await stoppedResponse;
  assert.equal(stopped.status, 200);

  const remoteViewer = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/machines`, {
    headers: { "x-forwarded-for": "203.0.113.10", forwarded: "for=203.0.113.10", "tailscale-user-login": "remote@example.com" }
  });
  assert.equal(remoteViewer.status, 200);
  assert.doesNotMatch(await remoteViewer.text(), /local_only/);

  const viewer = await fetch(`http://127.0.0.1:${addresses.viewer.port}/`);
  assert.equal(viewer.status, 200);
  assert.match(await viewer.text(), /plannotator/i);
  const worker = await fetch(`http://127.0.0.1:${addresses.viewer.port}/sw.js`);
  assert.equal(worker.status, 200);
  assert.match(await worker.text(), /notificationclick/);

  const launchDiscovery = await waitFor(async () => {
    const model = await (await fetch(`${forwardedBase}/sessions`)).json();
    return model.launch?.agents.some((entry) => entry.agent === "pi") ? model : null;
  });
  assert.equal(launchDiscovery.launch.projects[0].id, listed.project_id);
  const launchRequest = nextMessage(agent, "launch_start");
  const launchResponsePromise = fetch(`${forwardedBase}/messages`, {
    method: "POST", headers: { "content-type": "application/json", origin: central, "x-plannotator-window": "1" },
    body: JSON.stringify({
      serverSession: centralHealth.serverSession, idempotency_key: "upstream-launch-contract", body: "Launch from central Plannotator",
      to: { launch: { agent: "pi", project_id: listed.project_id } }, thread_name: "Central launch"
    })
  });
  const launchStart = await launchRequest;
  agent.send(JSON.stringify({ type: "launch_result", requestId: launchStart.requestId, launchId: launchStart.launchId, sessionId: launchStart.sessionId, ok: true }));
  const child = await connectAgent(addresses.agent, agentIdentity);
  children.push(child);
  const childGeneration = randomUUID();
  const launchDelivery = nextMessage(child, "reply");
  child.send(JSON.stringify({
    type: "session_upsert", sessionId: launchStart.sessionId, generation: childGeneration,
    session: { sessionId: launchStart.sessionId, generation: childGeneration, cwd: "/workspace/contract", name: "Central launch", model: "test/model", status: "idle", messages: [] }
  }));
  const launchedPrompt = await launchDelivery;
  child.send(JSON.stringify({ type: "reply_result", requestId: launchedPrompt.requestId, sessionId: launchStart.sessionId, generation: childGeneration, ok: true }));
  const launchResponse = await launchResponsePromise;
  assert.equal(launchResponse.status, 200);
  const launched = await launchResponse.json();
  assert.equal(launched.launch.state, "starting");
  const launchedThread = await (await fetch(`${forwardedBase}/threads/${launched.thread_id}`)).json();
  assert.equal(launchedThread.thread.messages[0].launch.id, launched.launch.id);
  const launchStopRequest = nextMessage(agent, "launch_stop");
  const launchStopResponse = fetch(`${forwardedBase}/launch/${launched.launch.id}/stop`, {
    method: "POST", headers: { "content-type": "application/json", origin: central }, body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "upstream-stop-contract" })
  });
  const stopOutcome = await Promise.race([
    launchStopRequest.then((request) => ({ request })),
    launchStopResponse.then(async (response) => ({ response, body: await response.text() }))
  ]);
  if (stopOutcome.response) assert.fail(`Central Stop failed before forwarding: ${stopOutcome.response.status} ${stopOutcome.body}`);
  const launchStop = stopOutcome.request;
  agent.send(JSON.stringify({ type: "launch_result", requestId: launchStop.requestId, launchId: launchStop.launchId, sessionId: launchStop.sessionId, ok: true }));
  assert.equal((await launchStopResponse).status, 200);

  const folderListingRequest = nextMessage(agent, "folder_list");
  const folderListingResponsePromise = fetch(`${forwardedBase}/launch/folders?path=~`, { headers: { origin: central, "sec-fetch-site": "same-origin", "x-plannotator-window": "1" } });
  const folderListing = await folderListingRequest;
  agent.send(JSON.stringify({ type: "folder_list_result", requestId: folderListing.requestId, ok: true, listing: { path: "~", exists: true, state: "folder", folders: ["Projects"], start: false, writable: true } }));
  const folderListingResponse = await folderListingResponsePromise;
  assert.equal(folderListingResponse.status, 200);
  assert.deepEqual((await folderListingResponse.json()).folders, ["Projects"]);

  const scratchRequest = nextMessage(agent, "launch_start");
  const scratchResponsePromise = fetch(`${forwardedBase}/messages`, {
    method: "POST", headers: { "content-type": "application/json", origin: central, "x-plannotator-window": "1" },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "upstream-scratch-contract", body: "Start in scratch", thread_name: "Scratch central", to: { launch: { agent: "pi", scratch: true } } })
  });
  const scratchStart = await scratchRequest;
  assert.equal(scratchStart.scratch, true);
  agent.send(JSON.stringify({ type: "launch_result", requestId: scratchStart.requestId, launchId: scratchStart.launchId, sessionId: scratchStart.sessionId, ok: true, cwd: "/workspace/scratch", scratch: true }));
  const scratchChild = await connectAgent(addresses.agent, agentIdentity);
  children.push(scratchChild);
  const scratchGeneration = randomUUID();
  const scratchDelivery = nextMessage(scratchChild, "reply");
  scratchChild.send(JSON.stringify({ type: "session_upsert", sessionId: scratchStart.sessionId, generation: scratchGeneration, session: { sessionId: scratchStart.sessionId, generation: scratchGeneration, cwd: "/workspace/scratch", name: "Scratch central", model: "test/model", status: "idle", messages: [] } }));
  const scratchPrompt = await scratchDelivery;
  scratchChild.send(JSON.stringify({ type: "reply_result", requestId: scratchPrompt.requestId, sessionId: scratchStart.sessionId, generation: scratchGeneration, ok: true }));
  const scratchResponse = await scratchResponsePromise;
  assert.equal(scratchResponse.status, 200);
  const scratchLaunched = await scratchResponse.json();
  assert.equal(scratchLaunched.message.launch.scratch, true);
  assert.equal(scratchLaunched.message.launch.folder, "/workspace/scratch");
  const retryRequest = nextMessage(agent, "launch_start");
  const retryResponsePromise = fetch(`${forwardedBase}/launch/${launched.launch.id}/retry`, {
    method: "POST", headers: { "content-type": "application/json", origin: central, "x-plannotator-window": "1" },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "upstream-retry-contract" })
  });
  const retryStart = await retryRequest;
  assert.equal(retryStart.sessionId, launchStart.sessionId);
  assert.equal(retryStart.cwd, "/workspace/contract");
  agent.send(JSON.stringify({ type: "launch_result", requestId: retryStart.requestId, launchId: retryStart.launchId, sessionId: retryStart.sessionId, ok: true, cwd: "/workspace/contract" }));
  const retryGeneration = randomUUID();
  child.send(JSON.stringify({ type: "session_upsert", sessionId: launchStart.sessionId, generation: retryGeneration, session: { sessionId: launchStart.sessionId, generation: retryGeneration, cwd: "/workspace/contract", name: "Central launch", model: "test/model", status: "idle", messages: [] } }));
  const retryResponse = await retryResponsePromise;
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).run.state, "waiting_answer");

  const trustResponse = await fetch(`${forwardedBase}/launch/${launched.launch.id}/trust`, {
    method: "POST", headers: { "content-type": "application/json", origin: central, "x-plannotator-window": "1" },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "upstream-trust-contract", warning: null })
  });
  assert.equal(trustResponse.status, 200);
  assert.equal((await trustResponse.json()).run.untrusted, false);

  const deleteRequest = nextMessage(agent, "launch_delete");
  const deleteResponsePromise = fetch(`${forwardedBase}/launch/${scratchLaunched.launch.id}/delete`, {
    method: "POST", headers: { "content-type": "application/json", origin: central, "x-plannotator-window": "1" },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "upstream-delete-contract" })
  });
  const deletion = await deleteRequest;
  assert.equal(deletion.cwd, "/workspace/scratch");
  agent.send(JSON.stringify({ type: "launch_result", requestId: deletion.requestId, launchId: deletion.launchId, sessionId: deletion.sessionId, ok: true, scratch_removed: true }));
  const deleteResponse = await deleteResponsePromise;
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { ok: true, scratch_removed: true });
  assert.equal((await (await fetch(`${forwardedBase}/threads/${scratchLaunched.thread_id}`)).json()).run, null);
  scratchChild.close();
  child.close();

  const bystander = await connectAgent(addresses.agent, agentIdentity);
  children.push(bystander);
  agent.close();
  await waitFor(() => hub.store.getSession(`${agentIdentity.hostId}:${sessionId}`)?.online === false);
  const offlineReply = await fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central, "x-plannotator-thread": "contract-session" },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "offline-outbox-contract", words: "Deliver after reconnect", seen_through_seq: opened.cursor })
  });
  assert.equal(offlineReply.status, 202);
  const held = (await offlineReply.json()).outbox;
  assert.equal(held.key, "offline-outbox-contract");
  assert.equal(held.words, "Deliver after reconnect");
  assert.equal(held.thread, "contract-session");
  const pending = await waitFor(() => {
    const session = hub.store.getSession(`${agentIdentity.hostId}:${sessionId}`);
    return session.pendingReplies?.find((entry) => entry.requestId === held.key);
  });
  assert.equal(pending.text, "Deliver after reconnect");
  agent = await connectAgent(addresses.agent, agentIdentity);
  const delivery = nextMessage(agent, "reply");
  const reconnectGeneration = randomUUID();
  agent.send(JSON.stringify({
    type: "session_upsert", sessionId, generation: reconnectGeneration,
    session: {
      sessionId, generation: reconnectGeneration, cwd: "/workspace/contract", name: "contract-session", model: "test/model", status: "running",
      messages: [{ id: "assistant-1", role: "assistant", text: "Remote assistant", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] }]
    }
  }));
  const request = await delivery;
  assert.equal(request.requestId, held.key);
  agent.send(JSON.stringify({ type: "reply_result", requestId: request.requestId, sessionId, generation: reconnectGeneration, ok: true }));
  await waitFor(() => {
    const session = hub.store.getSession(`${agentIdentity.hostId}:${sessionId}`);
    return session.pendingReplies.length === 0 && session.remoteReplies.some((entry) => entry.requestId === held.key) ? true : undefined;
  });
});
