import assert from "node:assert/strict";
import test from "node:test";
import { isSubagentSession } from "../extension/session-scope.ts";

test("Fabric child agents do not publish independent inbox threads", () => {
  assert.equal(isSubagentSession({ PI_FABRIC_LINEAGE: JSON.stringify({ version: 1, depth: 1, worker: true }) }), true);
  assert.equal(isSubagentSession({ PI_FABRIC_DEPTH: "2" }), true);
});

test("root sessions and user forks remain publishable", () => {
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession({ PI_FABRIC_DEPTH: "0" }), false);
  assert.equal(isSubagentSession({ PI_FABRIC_LINEAGE: "" }), false);
});
