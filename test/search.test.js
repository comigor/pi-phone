import assert from "node:assert/strict";
import test from "node:test";
import { mergeSearchAnswers } from "../server/search.js";
import { VirtualMachines } from "../server/virtual-machines.js";

function fixture() {
  const sessions = [{
    key: "host:one", hostId: "host", sessionId: "one", cwd: "/workspace/alpha", name: "Alpha session", status: "idle",
    createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:02:00.000Z", virtualCursor: 1, remoteReplies: [],
    messages: [
      { id: "a1", role: "assistant", text: "First line\nThe quickest brown fox jumps over the lazy dog", createdAt: "2026-11-09T00:01:00.000Z" },
      { id: "u1", role: "user", text: "Please inspect the Québéc result", createdAt: "2026-11-09T00:02:00.000Z", attachments: [{ name: "docs/report.pdf", data: Buffer.from("pdf").toString("base64"), mimeType: "application/pdf" }] }
    ]
  }, {
    key: "host:two", hostId: "host", sessionId: "two", cwd: "/workspace/beta", name: "Beta session", status: "running",
    createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:03:00.000Z", virtualCursor: 1, remoteReplies: [],
    messages: [{ id: "a2", role: "assistant", text: "Unrelated answer", createdAt: "2026-11-09T00:03:00.000Z" }]
  }];
  const virtual = new VirtualMachines({ dataDir: "/tmp", store: { state: { sessions } } });
  const machine = { hostId: "host", inboxId: "ibx_test" };
  virtual.machines.set("host", machine);
  return { virtual, machine, sessions };
}

test("virtual search finds messages with prefix and folded matching", () => {
  const { virtual, machine } = fixture();
  const prefix = virtual.search(machine, new URL("http://local/api/inbox/device/search?q=quick"));
  assert.equal(prefix.totals.messages, 1);
  assert.equal(prefix.groups.messages[0].snippet.marks[0][1], 5);
  const [markStart, markLength] = prefix.groups.messages[0].snippet.marks[0];
  assert.equal(prefix.groups.messages[0].snippet.text.slice(markStart, markStart + markLength), "quick");
  const folded = virtual.search(machine, new URL("http://local/api/inbox/device/search?q=quebec"));
  assert.equal(folded.groups.messages[0].author.kind, "me");
  assert.equal(folded.groups.messages[0].snippet.text.includes("Québéc"), true);
});

test("virtual search covers threads, files, projects, filters, and pagination", () => {
  const { virtual, machine, sessions } = fixture();
  const thread = virtual.search(machine, new URL("http://local/api/inbox/device/search?q=alpha"));
  assert.equal(thread.groups.threads.length, 1);
  assert.equal(thread.groups.projects.length, 1);
  const file = virtual.search(machine, new URL("http://local/api/inbox/device/search?q=report"));
  assert.equal(file.groups.files[0].folder, "docs");
  const fromAgent = virtual.search(machine, new URL("http://local/api/inbox/device/search?q=quebec&from=agent"));
  assert.equal(fromAgent.totals.messages, 0);
  const project = virtual.search(machine, new URL(`http://local/api/inbox/device/search?q=quick&project=${thread.groups.projects[0].id}`));
  assert.equal(project.totals.messages, 1);
  sessions[0].resolvedAt = "2026-11-09T00:04:00.000Z";
  const archived = virtual.search(machine, new URL("http://local/api/inbox/device/search?q=quick&status=archived"));
  assert.equal(archived.groups.messages[0].archived, true);
  const waiting = virtual.search(machine, new URL("http://local/api/inbox/device/search?q=quick&status=waiting"));
  assert.equal(waiting.totals.messages, 0);
});

test("merged search preserves source totals and paginates the combined rows", () => {
  const { virtual, machine } = fixture();
  const params = new URLSearchParams({ q: "quick", group: "messages", limit: "1", offset: "0" });
  const local = virtual.search(machine, new URL(`http://local/api/inbox/device/search?${params}`), false);
  const central = {
    q: "quick", terms: ["quick"], took_ms: 1, indexing: false, threads: 4,
    totals: { threads: 0, messages: 20, files: 0, projects: 0 }, recent: null,
    groups: { messages: [{ type: "message", id: "central", thread_id: "central", at: "2026-11-09T00:04:00.000Z", project: { id: "p", name: "p" } }] }
  };
  const merged = mergeSearchAnswers([central, local], params);
  assert.equal(merged.totals.messages, 21);
  assert.equal(merged.groups.messages.length, 1);
  assert.equal(merged.groups.messages[0].id, "central");
  const second = mergeSearchAnswers([central, local], new URLSearchParams({ q: "quick", group: "messages", limit: "1", offset: "1" }));
  assert.equal(second.groups.messages[0].author.kind, "agent");
});
