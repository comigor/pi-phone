import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import webPush from "web-push";

export class PushDispatcher {
  constructor(dataDir, publicUrl, store) {
    this.dataDir = dataDir;
    this.publicUrl = publicUrl;
    this.store = store;
  }

  async load() {
    const file = path.join(this.dataDir, "vapid.json");
    let keys;
    try {
      keys = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      keys = webPush.generateVAPIDKeys();
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(keys), { mode: 0o600 });
    }
    this.publicKey = keys.publicKey;
    webPush.setVapidDetails("mailto:admin@borges.dev", keys.publicKey, keys.privateKey);
  }

  async notify(item) {
    const target = this.targetFor?.(item);
    let url = `${this.publicUrl}/session/${encodeURIComponent(item.sessionKey)}`;
    if (target) {
      const hash = new URLSearchParams({ machine: target.machine, thread: target.thread });
      if (target.message) hash.set("msg", target.message);
      url = `${this.publicUrl}/#${hash}`;
    }
    const actions = [{ action: "reply", title: "Reply" }, { action: "read", title: "Mark read" }];
    if (target?.message) actions.push({ action: "archive", title: "Archive" });
    const payload = JSON.stringify({
      title: `${item.project} is waiting`,
      body: item.body || item.title,
      ...target,
      url,
      actions
    });
    await Promise.all(this.store.state.subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, payload, { TTL: 86400, urgency: "high" });
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) await this.store.removeSubscription(subscription.endpoint);
      }
      return undefined;
    }));
  }
}
