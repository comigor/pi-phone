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
  const forwardedBase = `${central}/api/inbox/m/${machine.id}`;
  const opened = await (await fetch(`${forwardedBase}/threads/${listed.thread_id}`)).json();
  assert.equal(opened.thread.messages[0].body, "Remote assistant");
  assert.ok(opened.thread.messages.some((message) => message.body.includes("Stop agent")));

  const image = opened.thread.messages[0].attachments[0];
  const imageResponse = await fetch(`${forwardedBase}/attachments/${image.id}/image`);
  assert.equal(imageResponse.status, 200);
  assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString(), "image");

  const replyDelivery = nextMessage(agent, "reply");
  const centralHealth = await (await fetch(`${central}/api/inbox/health`)).json();
  const replyResponse = fetch(`${forwardedBase}/messages/${opened.thread.messages[0].id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: central },
    body: JSON.stringify({ serverSession: centralHealth.serverSession, idempotency_key: "reply-contract", words: "Continue remotely", seen_through_seq: opened.cursor })
  });
  const delivered = await replyDelivery;
  assert.equal(delivered.text, "Continue remotely");
  agent.send(JSON.stringify({ type: "reply_result", requestId: delivered.requestId, sessionId, generation, ok: true }));
  const reply = await replyResponse;
  assert.equal(reply.status, 200);

  const upload = await fetch(`${forwardedBase}/uploads?name=person.png&idempotency_key=upload-contract`, {
    method: "POST",
    headers: { "content-type": "image/png", origin: central },
    body: "person-image"
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
  assert.equal(imageReply.attachments[0].data, Buffer.from("person-image").toString("base64"));
  agent.send(JSON.stringify({ type: "reply_result", requestId: imageReply.requestId, sessionId, generation, ok: true }));
  assert.equal((await imageReplyResponse).status, 200);
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

  const viewer = await fetch(`http://127.0.0.1:${addresses.viewer.port}/`);
  assert.equal(viewer.status, 200);
  assert.match(await viewer.text(), /plannotator/i);
});
