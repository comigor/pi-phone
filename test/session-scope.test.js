import assert from "node:assert/strict";
import test from "node:test";
import { isSubagentSession } from "../extension/session-scope.ts";

test("Fabric child agents do not publish independent inbox threads", () => {
  assert.equal(isSubagentSession({ PI_FABRIC_LINEAGE: JSON.stringify({ version: 1, depth: 1, worker: true }) }), true);
  assert.equal(isSubagentSession({ PI_FABRIC_DEPTH: "2" }), true);
});

test("native task agents nested below a parent session do not publish threads", () => {
  assert.equal(isSubagentSession({}, "/home/user/.omp/agent/sessions/project/parent.jsonl/Research.jsonl"), true);
  assert.equal(isSubagentSession({}, "/home/user/.omp/agent/sessions/project/2026-11-11T12-32-19-841Z_01a1ca98-4781-75f1-baa4-5d760f1ff44a/Research.jsonl"), true);
  assert.equal(isSubagentSession({}, "C:\\Users\\user\\.omp\\agent\\sessions\\parent.jsonl\\Research.jsonl"), true);
});

test("root sessions and user forks remain publishable", () => {
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession({ PI_FABRIC_DEPTH: "0" }), false);
  assert.equal(isSubagentSession({ PI_FABRIC_LINEAGE: "" }), false);
  assert.equal(isSubagentSession({}, "/home/user/.omp/agent/sessions/project/root.jsonl"), false);
  assert.equal(isSubagentSession({}, "/home/user/.omp/agent/sessions/project/fork.jsonl"), false);
});
