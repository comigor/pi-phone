import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostLauncher } from "../extension/host-launch.ts";

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // The child may not have created its first output yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

test("host supervisor starts, stops, and resumes a session process", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-host-launch-"));
  const script = path.join(temporary, "fake-pi.mjs");
  const log = path.join(temporary, "launches.jsonl");
  await writeFile(script, `
    import { appendFileSync } from "node:fs";
    appendFileSync(process.env.FAKE_LAUNCH_LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    setInterval(() => {}, 1000).unref();
  `);
  const launcher = new HostLauncher({ command: process.execPath, prefixArgs: [script], env: { FAKE_LAUNCH_LOG: log } });
  t.after(async () => {
    await launcher.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const sessionId = "01a1b887-3eff-75d8-b4ce-60dce39df983";
  await launcher.start(sessionId, temporary, "Relay investigation");
  await launcher.start(sessionId, temporary, "Relay investigation");
  await waitFor(async () => (await readFile(log, "utf8")).trim().split("\n").length === 1);
  await launcher.stop(sessionId);
  await launcher.start(sessionId, temporary, "Relay investigation");
  await waitFor(async () => (await readFile(log, "utf8")).trim().split("\n").length === 2);
  const launches = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(await realpath(launches[0].cwd), await realpath(temporary));
  assert.deepEqual(launches[0].args, ["--mode", "rpc", "--session-id", sessionId, "--name", "Relay investigation"]);
  assert.notEqual(launches[0].pid, launches[1].pid);
  await launcher.close();
});