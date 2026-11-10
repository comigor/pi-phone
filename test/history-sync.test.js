import assert from "node:assert/strict";
import test from "node:test";
import { snapshotMessages } from "../extension/history-sync.ts";

const message = (id, role, content, extra = {}) => ({ type: "message", id, message: { role, content, ...extra } });

test("published history keeps users and final assistant responses only", () => {
  const branch = [
    message("user", "user", "Fix the history"),
    message("working", "assistant", [
      { type: "text", text: "I will inspect it" },
      { type: "toolCall", name: "read", arguments: { path: "/private" } }
    ], { stopReason: "toolUse" }),
    message("result", "toolResult", [{ type: "text", text: "Sensitive raw tool output" }]),
    message("answer", "assistant", [{ type: "text", text: "History is fixed" }], { stopReason: "stop" }),
    message("failure", "assistant", [], { stopReason: "error", errorMessage: "Model failed" }),
    message("blank", "assistant", [], { stopReason: "stop" })
  ];
  assert.deepEqual(snapshotMessages(branch).map(({ id, text }) => ({ id, text })), [
    { id: "user", text: "Fix the history" },
    { id: "answer", text: "History is fixed" },
    { id: "failure", text: "Model failed" }
  ]);
  assert.ok(snapshotMessages(branch).every((entry) => entry.role !== "toolResult" && entry.toolCalls.length === 0));
});

test("incremental snapshots skip tool entries and preserve final images", () => {
  const toolResult = message("result", "toolResult", "raw output");
  assert.deepEqual(snapshotMessages([toolResult], true), []);
  const final = message("image", "assistant", [
    { type: "text", text: "Screenshot ready" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
  ], { stopReason: "stop" });
  assert.deepEqual(snapshotMessages([final], true).map((entry) => ({ id: entry.id, images: entry.images })), [
    { id: "image", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] }
  ]);
});
