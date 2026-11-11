import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboxHub } from "../server/index.js";

const executable = process.env.PI_INBOX_TEST_PI_BOLT;
const fabricWorker = process.env.PI_INBOX_TEST_FABRIC_WORKER;
const testModel = process.env.PI_INBOX_TEST_MODEL ?? "openrouter/z-ai/glm-5.3-flash";
async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

async function runFabricWorker(t, persistent) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-fabric-"));
  const hub = await InboxHub.create({ dataDir: path.join(temporary, "data"), publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  let child;
  let deadline;
  t.after(async () => {
    clearTimeout(deadline);
    if (child?.exitCode === null) child.kill("SIGTERM");
    await hub.close();
    await rm(temporary, { recursive: true, force: true });
  });

  const wrapper = path.join(temporary, "pi-bolt-worker");
  await writeFile(wrapper, `#!/bin/sh\nexec "${executable}" --no-extensions --no-mcp -e "${path.resolve("extension/pi-inbox.ts")}" "$@"\n`);
  await chmod(wrapper, 0o700);
  const taskFile = path.join(temporary, "task.txt");
  await writeFile(taskFile, "Reply with exactly 42 and nothing else.");
  const runId = persistent ? "actor" : "one-shot";
  const lineage = JSON.stringify({ version: 1, rootSessionId: "test-root", parentSessionId: "test-parent", runId, depth: 1, childIndex: 0, worker: true });
  const args = [
    fabricWorker,
    "--id", runId, "--runner", "pi", "--name", `Fabric ${runId}`,
    "--task-file", taskFile,
    "--status-file", path.join(temporary, "status.json"),
    "--lifecycle-file", path.join(temporary, "lifecycle.jsonl"),
    "--log-file", path.join(temporary, "worker.log"),
    "--cwd", temporary, "--pi-binary", wrapper,
    "--claude-binary", "claude", "--veda-binary", "veda", "--veda-backend", "pi", "--veda-persona", "default",
    "--timeout-ms", "60000", "--depth", "1", "--full-code-mode", "false", "--extensions", "true",
    "--tools", "[]", "--granted-risks", "[]", "--transport", "process", "--model", testModel,
    "--lineage", lineage
  ];
  if (persistent) args.push("--session-file", path.join(temporary, "actor.jsonl"), "--actor-id", "test-actor", "--actor-name", "Fabric actor");

  child = spawn(process.execPath, args, {
    cwd: temporary,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
      PI_INBOX_STATE_DIR: path.join(temporary, "identity"),
      PI_INBOX_RELAY_URL: `ws://127.0.0.1:${hub.addresses().agent.port}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  deadline = setTimeout(() => child.kill("SIGTERM"), 60000);
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(deadline);
  const status = JSON.parse(await readFile(path.join(temporary, "status.json"), "utf8"));
  assert.equal(exitCode, 0, output);
  assert.equal(status.status, "completed", status.error || output);
  assert.equal(hub.store.state.hosts.length, 0, "Fabric child registered an inbox host");
  assert.equal(hub.store.state.sessions.length, 0, "Fabric child published an inbox session");
}

test("Fabric one-shot and persistent actor workers stay out of the inbox", { skip: !executable || !fabricWorker, timeout: 150000 }, async (t) => {
  await t.test("one-shot", async (childTest) => runFabricWorker(childTest, false));
  await t.test("persistent actor", async (childTest) => runFabricWorker(childTest, true));
});

test("Pi-Bolt launches and stops a real session through the extension", { skip: !executable, timeout: 45000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-bolt-"));
  const hub = await InboxHub.create({ dataDir: path.join(temporary, "data"), publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const addresses = hub.addresses();
  const viewerBase = `http://127.0.0.1:${addresses.viewer.port}`;
  const doorBase = `http://127.0.0.1:${addresses.door.port}/api/inbox/device`;
  const wrapper = path.join(temporary, "pi-bolt-local");
  await writeFile(wrapper, `#!/bin/sh\nexec "${executable}" --no-extensions --no-mcp -e "${path.resolve("extension/pi-inbox.ts")}" "$@"\n`);
  await chmod(wrapper, 0o700);
  const child = spawn(executable, ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "-e", path.resolve("extension/pi-inbox.ts")], {
    cwd: temporary,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
      PI_INBOX_STATE_DIR: path.join(temporary, "identity"),
      PI_INBOX_RELAY_URL: `ws://127.0.0.1:${addresses.agent.port}`,
      PI_INBOX_LAUNCH_COMMAND: wrapper
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    for (const session of hub.store.state.sessions.filter((item) => item.launch && !item.launchStoppedAt)) {
      await hub.launch.stop(session).catch(() => undefined);
    }
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await hub.close();
    await rm(temporary, { recursive: true, force: true });
  });

  const state = await waitFor(async () => {
    const current = await (await fetch(`${viewerBase}/api/state`)).json();
    return current.hosts.length ? current : undefined;
  });
  const host = state.hosts[0];
  assert.equal(host.paired, false);
  assert.equal((await fetch(`${viewerBase}/api/hosts/${host.id}/approve`, { method: "POST" })).status, 200);
  await waitFor(() => hub.store.getHost(host.id)?.launch?.agents.includes("pi") ? true : undefined);

  await hub.store.upsertSession(host.id, {
    sessionId: "launch-project", generation: "launch-project", cwd: temporary, name: "launch-project", model: "test/model", status: "idle",
    messages: [{ id: "project-message", role: "assistant", text: "Existing project" }]
  });
  const { machine } = hub.virtual.offer(hub.store.getHost(host.id));
  machine.linkedAt = new Date().toISOString();
  await hub.virtual.persist();
  const headers = { authorization: `Bearer ${machine.token}`, "content-type": "application/json" };
  const discovery = await (await fetch(`${doorBase}/sessions`, { headers })).json();
  const project = discovery.launch.projects.find((item) => item.root === temporary);
  assert.ok(project);

  const body = {
    idempotency_key: "real-pi-bolt-launch", body: "Reply with a short launch confirmation",
    to: { launch: { agent: "pi", project_id: project.id } }, thread_name: "Real Pi-Bolt launch"
  };
  const launchResponse = await fetch(`${doorBase}/messages`, { method: "POST", headers: { ...headers, "x-plannotator-window": "1" }, body: JSON.stringify(body) }).catch((error) => {
    throw new Error(`${error.message}; parent stderr=${stderr}`);
  });
  const launchPayload = await launchResponse.text();
  assert.equal(launchResponse.status, 200, launchPayload);
  const launched = JSON.parse(launchPayload);
  const launchedSession = await waitFor(() => hub.store.state.sessions.find((session) => session.launch?.id === launched.launch.id && session.online));
  assert.equal(await realpath(launchedSession.cwd), await realpath(temporary));
  const thread = await (await fetch(`${doorBase}/threads/${launched.thread_id}`, { headers })).json();
  assert.equal(thread.thread.messages[0].body, body.body);
  assert.equal(thread.thread.messages[0].launch.id, launched.launch.id);

  const replay = await fetch(`${doorBase}/messages`, { method: "POST", headers: { ...headers, "x-plannotator-window": "1" }, body: JSON.stringify(body) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);

  const stop = await fetch(`${doorBase}/launch/${launched.launch.id}/stop`, { method: "POST", headers: { ...headers, "x-plannotator-window": "1" }, body: "{}" });
  const stopPayload = await stop.text();
  assert.equal(stop.status, 200, stopPayload);
  assert.equal(JSON.parse(stopPayload).run.state, "stopped");
  await waitFor(() => hub.store.getSession(launchedSession.key)?.online === false ? true : undefined);

  const resume = await fetch(`${doorBase}/messages/${thread.thread.messages[0].id}/reply`, {
    method: "POST", headers,
    body: JSON.stringify({ idempotency_key: "real-pi-bolt-resume", words: "Continue after restart", seen_through_seq: thread.cursor })
  });
  const resumePayload = await resume.text();
  assert.equal(resume.status, 200, resumePayload);
  await waitFor(() => hub.store.getSession(launchedSession.key)?.online && !hub.store.getSession(launchedSession.key)?.launchStoppedAt ? true : undefined);

  const finalStop = await fetch(`${doorBase}/launch/${launched.launch.id}/stop`, { method: "POST", headers: { ...headers, "x-plannotator-window": "1" }, body: "{}" });
  assert.equal(finalStop.status, 200);
});
