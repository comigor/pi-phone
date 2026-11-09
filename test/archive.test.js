import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboxStore } from "../server/store.js";

const session = {
  sessionId: "session", generation: "generation", cwd: "/workspace/project", name: "project", status: "idle",
  messages: [{ id: "one", role: "assistant", text: "First answer" }]
};

test("only new agent messages restore an archived session", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-archive-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new InboxStore(dataDir);
  await store.load();
  const key = "host:session";
  await store.upsertSession("host", session);
  await store.updateVirtualSession(key, { resolvedAt: "2026-11-09T00:00:00.000Z" });

  await store.upsertSession("host", { ...session, status: "running" });
  assert.equal(store.getSession(key).resolvedAt, "2026-11-09T00:00:00.000Z");

  const second = { id: "two", role: "assistant", text: "New answer" };
  await store.upsertSession("host", { ...session, messages: [...session.messages, second] });
  assert.equal(store.getSession(key).resolvedAt, null);
  assert.equal(store.getSession(key).backFromArchive, true);

  await store.updateVirtualSession(key, { resolvedAt: "2026-11-09T01:00:00.000Z", backFromArchive: false });
  const third = { id: "three", role: "assistant", text: "Another answer" };
  await store.patchSession("host", { ...session, messages: [third] });
  assert.equal(store.getSession(key).resolvedAt, null);
  assert.equal(store.getSession(key).backFromArchive, true);
});
