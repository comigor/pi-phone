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
  return {
    hostId: randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

async function connectAgent(address, id) {
  const challengeUrl = new URL(`http://127.0.0.1:${address.port}/challenge`);
  for (const [key, value] of Object.entries({ hostId: id.hostId, publicKey: id.publicKey, name: "creation-host" })) challengeUrl.searchParams.set(key, value);
  const challenge = await (await fetch(challengeUrl)).json();
  const privateKey = createPrivateKey({ key: Buffer.from(id.privateKey, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(agentSignaturePayload(id.hostId, challenge.nonce)), privateKey).toString("base64");
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  for (const [key, value] of Object.entries({ hostId: id.hostId, publicKey: id.publicKey, nonce: challenge.nonce, signature })) url.searchParams.set(key, value);
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
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

test("official folder and clone APIs drive prepared Pi launches", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-creation-"));
  const hub = await InboxHub.create({ dataDir: temporary, publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const agentIdentity = identity();
  const agent = await connectAgent(hub.addresses().agent, agentIdentity);
  const children = [];
  t.after(async () => {
    for (const child of children) child.terminate();
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
  const request = (route, init = {}) => fetch(`${door}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json", "x-plannotator-window": "1", ...(init.headers || {}) }
  });

  agent.send(JSON.stringify({ type: "host_hello", launch: { agents: ["pi"], home: "/Users/igor" } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const unsupported = await request("/launch/folders?path=~");
  assert.equal(unsupported.status, 409);
  assert.equal((await unsupported.json()).code, "agent_unavailable");
  const notWindow = await request("/launch/folders?path=~", { headers: { "x-plannotator-window": "0" } });
  assert.equal(notWindow.status, 403);

  agent.send(JSON.stringify({ type: "host_hello", launch: { agents: ["pi"], home: "/Users/igor", creation: 1 } }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const folderRequest = nextMessage(agent, "folder_list");
  const folderResponsePromise = request("/launch/folders?path=~%2FProjects");
  const folder = await folderRequest;
  assert.equal(folder.path, "~/Projects");
  agent.send(JSON.stringify({ type: "folder_list_result", requestId: folder.requestId, ok: true, listing: { path: "~/Projects", exists: true, state: "folder", folders: ["pi-phone"], writable: true } }));
  const folderResponse = await folderResponsePromise;
  assert.equal(folderResponse.status, 200);
  assert.deepEqual((await folderResponse.json()).folders, ["pi-phone"]);

  const checkRequest = nextMessage(agent, "clone_check");
  const checkResponsePromise = request(`/launch/clone-check?url=${encodeURIComponent("https://github.com/acme/private.git")}`);
  const check = await checkRequest;
  assert.equal(check.url, "https://github.com/acme/private.git");
  agent.send(JSON.stringify({ type: "clone_check_result", requestId: check.requestId, ok: true, reach: "auth" }));
  assert.deepEqual(await (await checkResponsePromise).json(), { reach: "auth" });

  const targetRequest = nextMessage(agent, "clone_target");
  const targetResponsePromise = request(`/launch/clone?url=${encodeURIComponent("github.com/acme/widget")}&into=~%2FProjects`);
  const target = await targetRequest;
  assert.equal(target.into, "~/Projects");
  agent.send(JSON.stringify({ type: "clone_target_result", requestId: target.requestId, ok: true, target: {
    into: "~/Projects", path: "~/Projects/widget", name: "widget", state: "clone", taken: null, writable: true,
    real: "/Users/igor/Projects/widget", intoReal: "/Users/igor/Projects", repo: { url: "https://github.com/acme/widget.git" }
  } }));
  const targetResponse = await targetResponsePromise;
  assert.equal(targetResponse.status, 200);
  assert.deepEqual(await targetResponse.json(), { into: "~/Projects", path: "~/Projects/widget", name: "widget", state: "clone", taken: null, writable: true });

  async function launch({ idempotency, to, cwd, name, prepare, cloneTarget }) {
    const startRequest = nextMessage(agent, "launch_start");
    const cloneRequest = cloneTarget ? nextMessage(agent, "clone_target") : null;
    const responsePromise = request("/messages", { method: "POST", body: JSON.stringify({ idempotency_key: idempotency, body: `Prompt for ${idempotency}`, thread_name: name, to: { launch: { agent: "pi", ...to } } }) });
    if (cloneRequest) {
      const clone = await cloneRequest;
      agent.send(JSON.stringify({ type: "clone_target_result", requestId: clone.requestId, ok: true, target: cloneTarget }));
    }
    const start = await startRequest;
    prepare(start);
    agent.send(JSON.stringify({ type: "launch_result", requestId: start.requestId, launchId: start.launchId, sessionId: start.sessionId, ok: true, cwd, scratch: to.scratch === true, ...(start.clone ? { clone: { url: start.clone.url, state: "cloned" } } : {}) }));
    const child = await connectAgent(hub.addresses().agent, agentIdentity);
    children.push(child);
    const generation = randomUUID();
    const delivery = nextMessage(child, "reply");
    child.send(JSON.stringify({ type: "session_upsert", sessionId: start.sessionId, generation, session: { sessionId: start.sessionId, generation, cwd, name, status: "idle", messages: [] } }));
    const delivered = await delivery;
    assert.equal(delivered.text, `Prompt for ${idempotency}`);
    child.send(JSON.stringify({ type: "reply_result", requestId: delivered.requestId, sessionId: start.sessionId, generation, ok: true }));
    const response = await responsePromise;
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  }

  const scratch = await launch({
    idempotency: "scratch-launch", to: { scratch: true }, cwd: "/Users/igor/.pi/agent/pi-inbox/scratch/research", name: "Research",
    prepare: (start) => { assert.equal(start.scratch, true); assert.equal(start.cwd, ""); }
  });
  assert.equal(scratch.message.launch.scratch, true);
  assert.equal(scratch.message.launch.folder, "/Users/igor/.pi/agent/pi-inbox/scratch/research");

  const created = await launch({
    idempotency: "create-launch", to: { folder: "~/Projects/New Client", create: true }, cwd: "/Users/igor/Projects/New Client", name: "New Client",
    prepare: (start) => { assert.equal(start.arbitrary, true); assert.equal(start.create, true); assert.equal(start.cwd, "~/Projects/New Client"); }
  });
  assert.equal(created.message.launch.made_folder, true);
  assert.equal(created.message.launch.folder, "/Users/igor/Projects/New Client");

  const cloned = await launch({
    idempotency: "clone-launch", to: { folder: "~/Projects", clone: { url: "github.com/acme/widget/tree/main" } }, cwd: "/Users/igor/Projects/widget", name: "Widget",
    cloneTarget: { state: "clone", real: "/Users/igor/Projects/widget", repo: { url: "https://github.com/acme/widget.git", branch: "main" } },
    prepare: (start) => { assert.equal(start.cwd, "/Users/igor/Projects/widget"); assert.deepEqual(start.clone, { url: "https://github.com/acme/widget.git", branch: "main" }); }
  });
  assert.deepEqual(cloned.message.launch.clone, { url: "https://github.com/acme/widget.git", state: "cloned" });
  assert.equal(cloned.message.launch.folder, "/Users/igor/Projects/widget");
});
