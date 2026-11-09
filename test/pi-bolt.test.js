import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboxHub } from "../server/index.js";

const executable = process.env.PI_INBOX_TEST_PI_BOLT;

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

test("Pi-Bolt loads the extension and registers a real session", { skip: !executable, timeout: 30000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-bolt-"));
  const hub = await InboxHub.create({ dataDir: path.join(temporary, "data"), publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, host: "127.0.0.1" });
  const addresses = hub.addresses();
  const viewerBase = `http://127.0.0.1:${addresses.viewer.port}`;
  const child = spawn(executable, ["--mode", "rpc", "--no-session", "-e", path.resolve("extension/pi-inbox.ts")], {
    cwd: temporary,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
      PI_INBOX_STATE_DIR: path.join(temporary, "identity"),
      PI_INBOX_RELAY_URL: `ws://127.0.0.1:${addresses.agent.port}`
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
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
  const approval = await fetch(`${viewerBase}/api/hosts/${host.id}/approve`, { method: "POST" });
  assert.equal(approval.status, 200);

  const live = await waitFor(async () => {
    const current = await (await fetch(`${viewerBase}/api/state`)).json();
    return current.sessions.find((session) => session.hostId === host.id && session.online);
  });
  await waitFor(() => hub.sessionAgents.get(live.key)?.generation === live.generation ? true : undefined);
  const reply = { key: live.key, generation: live.generation, requestId: "pi-bolt-dedupe", text: "Deliver once" };
  await hub.deliverReply(reply);
  const afterFirst = await waitFor(async () => {
    const current = await (await fetch(`${viewerBase}/api/state`)).json();
    const session = current.sessions.find((item) => item.key === live.key);
    return session.messageCount > live.messageCount ? session : undefined;
  });
  await hub.deliverReply(reply);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterSecond = await (await fetch(`${viewerBase}/api/state`)).json();
  assert.equal(afterSecond.sessions.find((item) => item.key === live.key).messageCount, afterFirst.messageCount);
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.exitCode, 0, stderr);
});
