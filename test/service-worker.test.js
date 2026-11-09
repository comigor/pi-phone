import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

async function worker(fetch, clients) {
  const listeners = new Map();
  const shown = [];
  const self = {
    location: { origin: "https://inbox.example" },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    addEventListener: (name, listener) => listeners.set(name, listener)
  };
  const context = vm.createContext({ self, clients, fetch, crypto: webcrypto, URL, encodeURIComponent });
  vm.runInContext(await readFile(new URL("../public/sw.js", import.meta.url), "utf8"), context);
  return { listeners, shown };
}
function eventWaiter() {
  let promise;
  return { waitUntil: (value) => { promise = value; }, promise: () => promise };
}

test("push displays deep-link data and click opens the Plannotator thread", async () => {
  const opened = [];
  const clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); }
  };
  const { listeners } = await worker(async () => { throw new Error("No fetch expected"); }, clients);
  const data = { title: "pi-phone is waiting", body: "Answer", url: "https://inbox.example/#machine=ibx&thread=msg&msg=reply", thread: "msg", actions: [{ action: "reply", title: "Reply" }] };
  const push = eventWaiter();
  listeners.get("push")({ data: { json: () => data }, waitUntil: push.waitUntil });
  await push.promise();
  const notification = { data, close: () => {} };
  const click = eventWaiter();
  listeners.get("notificationclick")({ action: "", notification, waitUntil: click.waitUntil });
  await click.promise();
  assert.deepEqual(opened, [data.url]);
});

test("read and archive actions use a fresh server session", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/inbox/health") return { ok: true, json: async () => ({ serverSession: "fresh-session" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const clients = { matchAll: async () => [], openWindow: async () => { throw new Error("Actions must not open a window"); } };
  const { listeners, shown } = await worker(fetch, clients);
  for (const action of ["read", "archive"]) {
    const click = eventWaiter();
    const notification = { close: () => {}, data: { machine: "ibx machine", thread: "msg thread", message: "msg message", url: "/#thread=msg" } };
    listeners.get("notificationclick")({ action, notification, waitUntil: click.waitUntil });
    await click.promise();
  }
  assert.equal(calls[1].url, "/api/inbox/m/ibx%20machine/threads/msg%20thread/read");
  assert.equal(calls[3].url, "/api/inbox/m/ibx%20machine/messages/msg%20message/resolve");
  const readBody = JSON.parse(calls[1].options.body);
  const archiveBody = JSON.parse(calls[3].options.body);
  assert.equal(readBody.serverSession, "fresh-session");
  assert.equal(archiveBody.serverSession, "fresh-session");
  assert.equal(archiveBody.resolved, true);
  assert.ok(readBody.idempotency_key);
  assert.ok(archiveBody.idempotency_key);
  assert.deepEqual(shown.map((entry) => entry.options.body), ["Marked as read.", "Thread archived."]);
});
