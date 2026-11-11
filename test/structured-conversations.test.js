import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { InboxHub } from "../server/index.js";
import { agentSignaturePayload } from "../server/protocol.js";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { hostId: randomUUID(), publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
}

async function connectAgent(address, id) {
  const challengeUrl = new URL(`http://127.0.0.1:${address.port}/challenge`);
  for (const [key, value] of Object.entries({ hostId: id.hostId, publicKey: id.publicKey, name: "structured-host" })) challengeUrl.searchParams.set(key, value);
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
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5_000);
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

async function waitFor(check) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for live sessions");
}

test("structured conversation routes preserve official response shapes", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-structured-"));
  const hub = await InboxHub.create({ dataDir: temporary, publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const id = identity();
  const agent = await connectAgent(hub.addresses().agent, id);
  t.after(async () => { agent.terminate(); await hub.close(); await rm(temporary, { recursive: true, force: true }); });
  await nextMessage(agent, "pairing_required");
  const paired = nextMessage(agent, "paired");
  await fetch(`http://127.0.0.1:${hub.addresses().viewer.port}/api/hosts/${id.hostId}/approve`, { method: "POST" });
  await paired;
  const a = randomUUID();
  const b = randomUUID();
  const generationA = randomUUID();
  const generationB = randomUUID();
  agent.send(JSON.stringify({ type: "session_upsert", sessionId: a, generation: generationA, session: { sessionId: a, generation: generationA, cwd: "/workspace/same", name: "Session A", status: "idle", messages: [{ id: "structured", role: "assistant", text: ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::", actions: [{ key: "a-deadbeef", title: "Deploy the release", action: { where_url: "https://example.test/deploy" } }] }] } }));
  agent.send(JSON.stringify({ type: "session_upsert", sessionId: b, generation: generationB, session: { sessionId: b, generation: generationB, cwd: "/workspace/same", name: "Session B", status: "idle", messages: [{ id: "ready-b", role: "assistant", text: "B ready" }] } }));
  await waitFor(() => hub.sessionAgents.has(`${id.hostId}:${a}`) && hub.sessionAgents.has(`${id.hostId}:${b}`));
  const machine = hub.virtual.offer(hub.store.getHost(id.hostId)).machine;
  const door = `http://127.0.0.1:${hub.addresses().door.port}/api/inbox/device`;
  const request = (route, body) => fetch(`${door}${route}`, { method: "POST", headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const threadList = await (await fetch(`${door}/threads`, { headers: { authorization: `Bearer ${machine.token}` } })).json();
  const threadId = threadList.sections.flatMap((section) => section.threads).find((row) => row.subject === "Session A").thread_id;
  const opened = await (await fetch(`${door}/threads/${threadId}`, { headers: { authorization: `Bearer ${machine.token}` } })).json();
  const structured = opened.thread.messages.find((message) => message.body.includes("Ship it?"));
  const question = structured.questions.find((item) => item.kind !== "action");
  const action = structured.questions.find((item) => item.kind === "action");
  assert.equal(question.state, "open");
  assert.equal(action.action.where_url, "https://example.test/deploy");

  let delivery = nextMessage(agent, "reply");
  const reaskResponse = request(`/messages/${structured.id}/reask`, { idempotency_key: "reask-1" });
  const reaskDelivery = await delivery;
  assert.match(reaskDelivery.text, /Ship it\?/);
  agent.send(JSON.stringify({ type: "reply_result", requestId: reaskDelivery.requestId, sessionId: reaskDelivery.sessionId, generation: reaskDelivery.sessionId === a ? generationA : generationB, ok: true }));
  const reask = await (await reaskResponse).json();
  assert.equal(reask.message_id, structured.id);
  assert.equal(reask.replayed, false);
  assert.ok(reask.questions.some((item) => item.key === question.key));

  delivery = nextMessage(agent, "reply");
  const picksResponse = request(`/messages/${structured.id}/picks`, { idempotency_key: "pick-1", picks: [{ question: question.key, choice: "Yes" }] });
  const pickDelivery = await delivery;
  agent.send(JSON.stringify({ type: "reply_result", requestId: pickDelivery.requestId, sessionId: pickDelivery.sessionId, generation: generationA, ok: true }));
  const picked = await (await picksResponse).json();
  assert.equal(picked.message.questions.find((item) => item.key === question.key).answer, "Yes");
  assert.equal(picked.reply.reply_to, structured.id);

  const marked = await (await request(`/messages/${structured.id}/actions/${action.key}`, { idempotency_key: "action-1", outcome: "done", note: "Approved" })).json();
  assert.equal(marked.questions.find((item) => item.key === action.key).action_result.outcome, "done");
  const unmarked = await (await request(`/messages/${structured.id}/actions/${action.key}`, { idempotency_key: "action-2", outcome: null })).json();
  assert.equal(unmarked.questions.find((item) => item.key === action.key).state, "open");

  delivery = nextMessage(agent, "reply");
  const newMessageResponse = request(`/threads/${threadId}/message`, { idempotency_key: "new-message-1", session: b, body: "Take this message" });
  const newDelivery = await delivery;
  assert.equal(newDelivery.sessionId, b);
  agent.send(JSON.stringify({ type: "reply_result", requestId: newDelivery.requestId, sessionId: b, generation: generationB, ok: true }));
  const newMessage = await (await newMessageResponse).json();
  assert.deepEqual(newMessage.message.to, { host: "pi", session: b });
  assert.equal(newMessage.replayed, false);
  const replay = await request(`/threads/${threadId}/message`, { idempotency_key: "new-message-1", session: b, body: "Take this message" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal((await replay.json()).replayed, true);

  delivery = nextMessage(agent, "reply");
  const moveResponse = request(`/messages/${newMessage.message.id}/to`, { idempotency_key: "move-1", to: { host: "pi", session: a } });
  const moveDelivery = await delivery;
  assert.equal(moveDelivery.sessionId, a);
  agent.send(JSON.stringify({ type: "reply_result", requestId: moveDelivery.requestId, sessionId: a, generation: generationA, ok: true }));
  const moved = await (await moveResponse).json();
  assert.deepEqual(moved.message.to, { host: "pi", session: a });

  delivery = nextMessage(agent, "reply");
  const sendNowResponse = request(`/messages/${newMessage.message.id}/send-now`, { idempotency_key: "send-now-1" });
  const sendNowDelivery = await delivery;
  agent.send(JSON.stringify({ type: "reply_result", requestId: sendNowDelivery.requestId, sessionId: a, generation: generationA, ok: true }));
  const sendNow = await (await sendNowResponse).json();
  assert.ok(sendNow.message.deliver_now_at);

  const sessionB = hub.store.getSession(`${id.hostId}:${b}`);
  sessionB.messageOverrides[newMessage.message.id].handoff = { from: b, at: new Date().toISOString() };
  await hub.store.persist();
  delivery = nextMessage(agent, "reply");
  const undoResponse = request(`/messages/${newMessage.message.id}/handoff/undo`, { idempotency_key: "undo-1" });
  const undoDelivery = await delivery;
  assert.equal(undoDelivery.sessionId, b);
  agent.send(JSON.stringify({ type: "reply_result", requestId: undoDelivery.requestId, sessionId: b, generation: generationB, ok: true }));
  const undone = await (await undoResponse).json();
  assert.ok(undone.message.handoff.undone_at);
  assert.deepEqual(undone.message.to, { host: "pi", session: b });
  assert.equal((await request(`/messages/${newMessage.message.id}/to`, { idempotency_key: "move-missing", to: { session: "missing" } })).status, 409);
});
