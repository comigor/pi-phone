import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import webPush from "web-push";
import { PushDispatcher } from "../server/push.js";
import { VirtualMachines } from "../server/virtual-machines.js";

test("push payloads deep-link into Plannotator and carry actions", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-inbox-push-"));
  const original = webPush.sendNotification;
  t.after(async () => {
    webPush.sendNotification = original;
    await rm(dataDir, { recursive: true, force: true });
  });
  const store = { state: { subscriptions: [{ endpoint: "https://push.example/subscription" }] } };
  const dispatcher = new PushDispatcher(dataDir, "https://inbox.example", store);
  await dispatcher.load();
  dispatcher.targetFor = () => ({ machine: "ibx_machine", thread: "msg_thread", message: "msg_message" });
  let sent;
  webPush.sendNotification = async (subscription, payload, options) => { sent = { subscription, payload: JSON.parse(payload), options }; };
  await dispatcher.notify({ sessionKey: "host:session", project: "pi-phone", title: "Ready for input", body: "The latest answer" });
  assert.equal(sent.subscription.endpoint, "https://push.example/subscription");
  assert.equal(sent.payload.url, "https://inbox.example/#machine=ibx_machine&thread=msg_thread&msg=msg_message");
  assert.equal(sent.payload.body, "The latest answer");
  assert.deepEqual(sent.payload.actions.map((action) => action.action), ["reply", "read", "archive"]);
  assert.equal(sent.options.urgency, "high");
});

test("virtual notification targets select the latest assistant message", () => {
  const session = {
    key: "host:session", hostId: "host", sessionId: "session", cwd: "/workspace", name: "session", status: "idle",
    updatedAt: "2026-11-09T00:00:00.000Z", remoteReplies: [],
    messages: [
      { id: "one", role: "assistant", text: "First" },
      { id: "two", role: "user", text: "Question" },
      { id: "three", role: "assistant", text: "Latest" },
      { id: "tool", role: "assistant", text: "Working", toolCalls: [{ name: "bash", arguments: {} }] },
      { id: "result", role: "toolResult", text: "Raw output" }
    ]
  };
  const virtual = new VirtualMachines({ dataDir: "/tmp", store: { state: { sessions: [session] }, getSession: () => session } });
  virtual.machines.set("host", { inboxId: "ibx_machine" });
  const target = virtual.notificationTarget({ sessionKey: session.key, hostId: "host" });
  assert.equal(target.machine, "ibx_machine");
  assert.equal(target.thread, virtual.row(session).thread_id);
  assert.equal(target.message, virtual.virtualMessage(session, session.messages[2], 2).id);
});
