import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { InboxHub } from "../server/index.js";
import { agentSignaturePayload, parseMessage } from "../server/protocol.js";

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
    } else messages.push(message);
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

async function openSocket(url) {
  const socket = new WebSocket(url);
  const next = messageQueue(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, next };
}

async function connectAgent(address, identity) {
  const challengeUrl = new URL(`http://127.0.0.1:${address.port}/challenge`);
  for (const [key, value] of Object.entries({ hostId: identity.hostId, publicKey: identity.publicKey, name: "test-host" })) challengeUrl.searchParams.set(key, value);
  const response = await fetch(challengeUrl);
  assert.equal(response.status, 200);
  const challenge = await response.json();
  const privateKey = (await import("node:crypto")).createPrivateKey({ key: Buffer.from(identity.privateKey, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(agentSignaturePayload(identity.hostId, challenge.nonce)), privateKey).toString("base64");
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  for (const [key, value] of Object.entries({ hostId: identity.hostId, publicKey: identity.publicKey, nonce: challenge.nonce, signature })) url.searchParams.set(key, value);
  return await openSocket(url);
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    hostId: randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

test("invalid protocol input is rejected without throwing", () => {
  for (const input of ["", "null", "[]", "{}", "not-json", Buffer.from("{")]) assert.equal(parseMessage(input), null);
  assert.deepEqual(parseMessage('{"type":"ping"}'), { type: "ping" });
});

test("paired host publishes an inbox item and receives a live reply", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-"));
  const publicDir = path.resolve("public");
  const hub = await InboxHub.create({ dataDir, publicDir, publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, host: "127.0.0.1" });
  const addresses = hub.addresses();
  const viewerBase = `http://127.0.0.1:${addresses.viewer.port}`;
  const viewer = await openSocket(`ws://127.0.0.1:${addresses.viewer.port}/ws`);
  const agentIdentity = identity();
  const agent = await connectAgent(addresses.agent, agentIdentity);
  t.after(async () => {
    viewer.socket.terminate();
    agent.socket.terminate();
    await hub.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const pairing = await agent.next((message) => message.type === "pairing_required");
  assert.match(pairing.pairingCode, /^[A-F0-9]{8}$/);
  const pendingState = await (await fetch(`${viewerBase}/api/state`)).json();
  const host = pendingState.hosts.find((item) => item.id === agentIdentity.hostId);
  assert.equal(host.paired, false);
  assert.equal(host.pairingCode, pairing.pairingCode);

  const approved = await fetch(`${viewerBase}/api/hosts/${agentIdentity.hostId}/approve`, { method: "POST" });
  assert.equal(approved.status, 200);
  await agent.next((message) => message.type === "paired");

  const sessionId = randomUUID();
  const generation = randomUUID();
  agent.socket.send(JSON.stringify({
    type: "session_upsert",
    sessionId,
    generation,
    session: {
      sessionId,
      generation,
      cwd: "/workspace/example",
      name: "example",
      model: "test/model",
      thinkingLevel: "high",
      status: "idle",
      messages: [{ id: "m1", role: "assistant", text: "Should I continue?", toolCalls: [] }]
    }
  }));
  const sessionKey = `${agentIdentity.hostId}:${sessionId}`;
  await viewer.next((message) => message.type === "session" && message.session?.key === sessionKey);

  agent.socket.send(JSON.stringify({ type: "agent_settled", sessionId, generation, runId: "run-1", aborted: false }));
  const inbox = await viewer.next((message) => message.type === "inbox" && message.item.sessionKey === sessionKey);
  assert.equal(inbox.item.body, "Should I continue?");
  assert.equal(inbox.item.status, "pending");

  const replySocket = await openSocket(`ws://127.0.0.1:${addresses.viewer.port}/ws`);
  t.after(() => replySocket.socket.terminate());
  replySocket.socket.send(JSON.stringify({ type: "reply", requestId: "request-1", sessionKey, generation, text: "Yes, continue" }));
  const delivered = await agent.next((message) => message.type === "reply" && message.requestId === "request-1");
  assert.equal(delivered.text, "Yes, continue");
  agent.socket.send(JSON.stringify({ type: "reply_result", requestId: "request-1", sessionId, generation, ok: true }));
  const result = await replySocket.next((message) => message.type === "reply_result" && message.requestId === "request-1");
  assert.equal(result.ok, true);

  const finalState = await (await fetch(`${viewerBase}/api/state`)).json();
  assert.equal(finalState.inbox.find((item) => item.id === inbox.item.id).status, "answered");

  agent.socket.send(JSON.stringify({ type: "agent_settled", sessionId, generation, runId: "run-2", aborted: false }));
  const locallyAnswered = await viewer.next((message) => message.type === "inbox" && message.item.id === `${sessionKey}:run-2`);
  assert.equal(locallyAnswered.item.status, "pending");

  agent.socket.send(JSON.stringify({
    type: "session_upsert",
    sessionId,
    generation,
    session: {
      sessionId,
      generation,
      cwd: "/workspace/example",
      name: "example",
      model: "test/model",
      thinkingLevel: "high",
      status: "running",
      messages: [
        { id: "m1", role: "assistant", text: "Should I continue?", toolCalls: [] },
        { id: "m2", role: "user", text: "Answered directly in Pi", toolCalls: [] }
      ]
    }
  }));
  await viewer.next((message) => message.type === "session" && message.session?.key === sessionKey && message.session.status === "running");
  const runningState = await (await fetch(`${viewerBase}/api/state`)).json();
  assert.equal(runningState.inbox.find((item) => item.id === locallyAnswered.item.id).status, "answered");

  agent.socket.send("not-json");
  const error = await agent.next((message) => message.type === "error");
  assert.equal(error.error, "Invalid message");
});
