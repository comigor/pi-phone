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
    env: { PLANNOTATOR_TEST_SANDBOX: "1" }
  }).start();
  hub.plannotator = runtime;
  const central = runtime.url.origin;
  const agent = await connectAgent(addresses.agent, agentIdentity);
  t.after(async () => {
    agent.terminate();
    await hub.close();
    await runtime.stop();
    await rm(temporary, { recursive: true, force: true });
  });

  await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/hosts/${agentIdentity.hostId}/approve`, { method: "POST" });
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

  const centralHealth = await (await fetch(`${central}/api/inbox/health`)).json();
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
  assert.deepEqual((await projectArchive(false)).threads.map((thread) => thread.thread_id), [listed.thread_id]);
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
  const publicOutbox = await waitFor(async () => {
    const model = await (await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/outbox`)).json();
    return model.waiting.some((entry) => entry.key === held.key) ? model : null;
  });
  const waiting = publicOutbox.waiting.find((entry) => entry.key === held.key);
  assert.ok(["queued", "sending"].includes(waiting.state));
  const dismissed = await fetch(`http://127.0.0.1:${addresses.viewer.port}/api/inbox/outbox/${held.key}/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(dismissed.status, 200);
});
