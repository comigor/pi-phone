import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DraftStore } from "../server/drafts.js";

test("reply drafts survive reload, reject stale editors, and apply file operations", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-drafts-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new DraftStore(dataDir);
  await store.load();
  const first = await store.save("msg_test", { body: "first", base: null, files: [{ upload_id: "upl_one" }], all_files: true });
  const reloaded = new DraftStore(dataDir);
  await reloaded.load();
  assert.equal(reloaded.get("msg_test").body, "first");
  await assert.rejects(reloaded.save("msg_test", { body: "other editor", base: null }), (error) => error.code === "draft_conflict");
  const second = await reloaded.save("msg_test", { body: "same editor", base: null, base_body: "first", files_add: [{ upload_id: "upl_two" }] });
  assert.deepEqual(second.files.map((file) => file.upload_id), ["upl_one", "upl_two"]);
  const third = await reloaded.save("msg_test", { body: "same editor", base: second.updated_at, files_remove: ["upl_one"] });
  assert.deepEqual(third.files.map((file) => file.upload_id), ["upl_two"]);
  assert.equal(await reloaded.clearSent("msg_test", third.updated_at, "same editor", ["upl_two"]), true);
  assert.equal(reloaded.get("msg_test"), null);
  const empty = await reloaded.save("msg_test", { body: "   ", base: null });
  assert.equal(empty, null);
});
