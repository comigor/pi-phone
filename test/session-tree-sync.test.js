import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { InboxHub } from "../server/index.js";

const { default: registerInbox } = await createJiti(import.meta.url).import("../extension/pi-inbox.ts");

const message = (id, role, text) => ({ type: "message", id, message: { role, content: [{ type: "text", text }], stopReason: "stop" } });

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for inbox synchronization");
}

test("tree navigation and compaction fully replace the published branch", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-tree-"));
  const previousRelay = process.env.PI_INBOX_RELAY_URL;
  const previousState = process.env.PI_INBOX_STATE_DIR;
  const hub = await InboxHub.create({ dataDir: path.join(temporary, "data"), publicDir: path.resolve("public"), publicUrl: "http://localhost" });
  await hub.listen({ viewerPort: 0, agentPort: 0, doorPort: 0, host: "127.0.0.1" });
  const handlers = new Map();
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, {});
    if (previousRelay === undefined) delete process.env.PI_INBOX_RELAY_URL;
    else process.env.PI_INBOX_RELAY_URL = previousRelay;
    if (previousState === undefined) delete process.env.PI_INBOX_STATE_DIR;
    else process.env.PI_INBOX_STATE_DIR = previousState;
    await hub.close();
    await rm(temporary, { recursive: true, force: true });
  });

  process.env.PI_INBOX_RELAY_URL = `ws://127.0.0.1:${hub.addresses().agent.port}`;
  process.env.PI_INBOX_STATE_DIR = path.join(temporary, "identity");
  let branch = [message("root", "user", "Original question"), message("old-answer", "assistant", "Abandoned answer"), { type: "custom", id: "trailing" }];
  const ctx = {
    cwd: temporary,
    hasUI: false,
    thinkingLevel: "high",
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "tree-session",
      getSessionName: () => "Tree session",
      getSessionFile: () => path.join(temporary, "root.jsonl"),
      getBranch: () => branch
    }
  };
  registerInbox({ events: { on() {} }, on(event, handler) { handlers.set(event, handler); } });
  await handlers.get("session_start")({}, ctx);
  const host = await waitFor(() => hub.store.state.hosts[0]);
  const viewerBase = `http://127.0.0.1:${hub.addresses().viewer.port}`;
  assert.equal((await fetch(`${viewerBase}/api/hosts/${host.id}/approve`, { method: "POST" })).status, 200);
  await waitFor(() => hub.store.getSession(`${host.id}:tree-session`)?.messages.length === 2);

  branch = [message("root", "user", "Original question"), message("alternate", "assistant", "Current branch answer"), { type: "custom", id: "alternate-leaf" }];
  await handlers.get("session_tree")?.({}, ctx);
  await waitFor(() => hub.store.getSession(`${host.id}:tree-session`)?.messages.at(-1)?.id === "alternate");
  assert.deepEqual(hub.store.getSession(`${host.id}:tree-session`).messages.map((entry) => entry.id), ["root", "alternate"]);

  branch = [message("after-compaction", "assistant", "Visible after compaction"), { type: "compaction", id: "summary" }, { type: "custom", id: "compacted-leaf" }];
  await handlers.get("session_compact")?.({}, ctx);
  await waitFor(() => hub.store.getSession(`${host.id}:tree-session`)?.messages.at(-1)?.id === "after-compaction");
  assert.deepEqual(hub.store.getSession(`${host.id}:tree-session`).messages.map((entry) => entry.id), ["after-compaction"]);
});
