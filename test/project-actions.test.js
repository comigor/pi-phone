import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { InboxHub } from "../server/index.js";
import { agentSignaturePayload } from "../server/protocol.js";
import { InboxStore } from "../server/store.js";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { hostId: randomUUID(), publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
}

async function connectAgent(address, id) {
  const challengeUrl = new URL(`http://127.0.0.1:${address.port}/challenge`);
  for (const [key, value] of Object.entries({ hostId: id.hostId, publicKey: id.publicKey, name: "project-host" })) challengeUrl.searchParams.set(key, value);
  const challenge = await (await fetch(challengeUrl)).json();
  const privateKey = createPrivateKey({ key: Buffer.from(id.privateKey, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(agentSignaturePayload(id.hostId, challenge.nonce)), privateKey).toString("base64");
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  for (const [key, value] of Object.entries({ hostId: id.hostId, publicKey: id.publicKey, nonce: challenge.nonce, signature })) url.searchParams.set(key, value);
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}

function nextMessage(socket, type) {
  return new Promise((resolve) => {
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("project batches replay and Undo exactly, and deletion ignores late snapshots", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-project-actions-"));
  const hub = await InboxHub.create({ dataDir: temporary, publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const agentIdentity = identity();
  const agent = await connectAgent(hub.addresses().agent, agentIdentity);
  t.after(async () => {
    agent.terminate();
    await hub.close();
    await rm(temporary, { recursive: true, force: true });
  });
  await nextMessage(agent, "pairing_required");
  const paired = nextMessage(agent, "paired");
  await fetch(`http://127.0.0.1:${hub.addresses().viewer.port}/api/hosts/${agentIdentity.hostId}/approve`, { method: "POST" });
  await paired;
  const machine = hub.virtual.offer(hub.store.getHost(agentIdentity.hostId)).machine;
  const door = `http://127.0.0.1:${hub.addresses().door.port}/api/inbox/device`;
  const request = (route, init = {}) => fetch(`${door}${route}`, { ...init, headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json", ...(init.headers || {}) } });
  const generations = new Map();
  function publish(name, status, text) {
    const sessionId = name;
    const generation = generations.get(name) || randomUUID();
    generations.set(name, generation);
    agent.send(JSON.stringify({ type: "session_upsert", sessionId, generation, session: { sessionId, generation, cwd: "/workspace/project", name, status, messages: [{ id: `${name}-assistant`, role: "assistant", text }] } }));
  }
  publish("alpha", "idle", "Alpha waits");
  publish("beta", "idle", "Beta already looked");
  publish("running", "running", "Still working");
  await waitFor(() => hub.store.state.sessions.length === 3);
  const listed = await (await request("/threads")).json();
  const rows = listed.sections.flatMap((section) => section.threads);
  const alpha = rows.find((row) => row.subject === "alpha");
  const beta = rows.find((row) => row.subject === "beta");
  const running = rows.find((row) => row.subject === "running");
  assert.ok(alpha, JSON.stringify(listed));
  assert.ok(beta, JSON.stringify(listed));
  assert.ok(running, JSON.stringify(listed));
  const projectId = alpha.project_id;
  assert.equal(beta.project_id, projectId);
  assert.equal((await request(`/threads/${beta.thread_id}/read`, { method: "POST", body: "{}" })).status, 200);

  const readResponse = await request(`/projects/${projectId}/read`, { method: "POST", body: JSON.stringify({ batch_id: "batch-read" }) });
  assert.equal(readResponse.status, 200);
  const first = await readResponse.json();
  assert.deepEqual(first.batch.read, [alpha.thread_id]);
  assert.deepEqual(first.batch.looked, [beta.thread_id]);
  assert.equal(first.replayed, false);
  const cursor = machine.cursor;
  const replayResponse = await request(`/projects/${projectId}/read`, { method: "POST", body: JSON.stringify({ batch_id: "batch-read" }) });
  const replay = await replayResponse.json();
  assert.equal(replayResponse.headers.get("idempotent-replayed"), "true");
  assert.deepEqual({ ...replay, replayed: false }, first);
  assert.equal(machine.cursor, cursor);

  const reused = await request(`/projects/${projectId}/unread`, { method: "POST", body: JSON.stringify({ batch_id: "batch-read", threads: [] }) });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).code, "batch_id_reused");
  const undo = await request(`/projects/${projectId}/unread`, { method: "POST", body: JSON.stringify({ idempotency_key: "undo-read", threads: first.batch.read, looked: first.batch.looked }) });
  assert.equal(undo.status, 200);
  assert.equal((await undo.json()).threads.length, 2);
  assert.equal(hub.store.getSession(`${agentIdentity.hostId}:alpha`).readAt, null);
  assert.equal(hub.store.getSession(`${agentIdentity.hostId}:beta`).readAt, null);
  const replayedAfterUndo = await (await request(`/projects/${projectId}/read`, { method: "POST", body: JSON.stringify({ batch_id: "batch-read" }) })).json();
  assert.equal(replayedAfterUndo.replayed, true);
  assert.equal(hub.store.getSession(`${agentIdentity.hostId}:alpha`).readAt, null);

  const archiveResponse = await request(`/projects/${projectId}/resolve`, { method: "POST", body: JSON.stringify({ idempotency_key: "archive-project", resolved: true }) });
  assert.equal(archiveResponse.status, 200);
  const archive = await archiveResponse.json();
  assert.deepEqual(new Set(archive.batch.resolved), new Set([alpha.thread_id, beta.thread_id, running.thread_id]));
  for (const name of ["alpha", "beta", "running"]) assert.ok(hub.store.getSession(`${agentIdentity.hostId}:${name}`).resolvedAt);
  const unarchive = await request(`/projects/${projectId}/resolve`, { method: "POST", body: JSON.stringify({ idempotency_key: "unarchive-project", resolved: false, threads: archive.batch }) });
  assert.equal(unarchive.status, 200);
  for (const name of ["alpha", "beta", "running"]) assert.equal(hub.store.getSession(`${agentIdentity.hostId}:${name}`).resolvedAt, null);

  const uploadResponse = await request("/uploads?name=reuse.txt", { method: "POST", headers: { "content-type": "text/plain" }, body: "reuse these exact bytes" });
  const upload = (await uploadResponse.json()).upload;
  const alphaThread = await (await request(`/threads/${alpha.thread_id}`)).json();
  const replyRequest = nextMessage(agent, "reply");
  const replyResponsePromise = request(`/messages/${alphaThread.thread.messages[0].id}/reply`, {
    method: "POST", body: JSON.stringify({ idempotency_key: "reply-for-reuse", words: "Reuse this file", uploads: [upload.upload_id] })
  });
  const reply = await replyRequest;
  assert.equal(reply.text, "Reuse this file");
  agent.send(JSON.stringify({ type: "reply_result", requestId: reply.requestId, sessionId: "alpha", generation: generations.get("alpha"), ok: true }));
  const replyBody = await (await replyResponsePromise).json();
  const source = replyBody.reply.attachments[0];
  assert.equal(source.name, "reuse.txt");
  const reuseResponse = await request("/uploads/reuse", { method: "POST", body: JSON.stringify({ attachment_id: source.id, version: "sent", idempotency_key: "reuse-file" }) });
  assert.equal(reuseResponse.status, 200);
  const reusedUpload = (await reuseResponse.json()).upload;
  assert.notEqual(reusedUpload.upload_id, upload.upload_id);
  assert.equal(reusedUpload.name, source.name);
  assert.equal(reusedUpload.sha256, source.sent_sha256);
  assert.equal(reusedUpload.kind, source.kind);
  assert.equal(hub.virtual.uploads.get(reusedUpload.upload_id).data.toString(), "reuse these exact bytes");
  const reusedAgain = (await (await request("/uploads/reuse", { method: "POST", body: JSON.stringify({ attachment_id: source.id, version: "sent", idempotency_key: "reuse-file" }) })).json()).upload;
  assert.notEqual(reusedAgain.upload_id, reusedUpload.upload_id);
  assert.equal((await request("/uploads/reuse", { method: "POST", body: JSON.stringify({ attachment_id: source.id, version: "sent", sha256: "0".repeat(64) }) })).status, 409);
  assert.equal((await request("/uploads/reuse", { method: "POST", body: JSON.stringify({ attachment_id: "att_00000000000000000000000000", version: "sent" }) })).status, 404);

  const deleted = await request(`/threads/${beta.thread_id}/delete`, { method: "POST", body: JSON.stringify({ idempotency_key: "delete-beta" }) });
  assert.equal(deleted.status, 200);
  const deletion = await deleted.json();
  assert.equal(deletion.ok, true);
  assert.deepEqual(Object.keys(deletion.store).sort(), ["bytes", "dir", "projects"]);
  assert.equal((await request(`/threads/${beta.thread_id}`)).status, 404);
  assert.equal((await request(`/threads/${beta.thread_id}/delete`, { method: "POST", body: "{}" })).status, 404);
  publish("beta", "idle", "A late snapshot must not resurrect beta");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hub.store.getSession(`${agentIdentity.hostId}:beta`), undefined);
  assert.equal((await request(`/threads/${beta.thread_id}`)).status, 404);
  await hub.store.flush();
  const reopened = new InboxStore(temporary);
  await reopened.load();
  assert.equal(reopened.isSessionDeleted(`${agentIdentity.hostId}:beta`), true);
});
