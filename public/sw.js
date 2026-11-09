function openThread(url) {
  return clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    if (existing) {
      await existing.navigate(url);
      await existing.focus();
      return;
    }
    return clients.openWindow(url);
  });
}

async function performAction(action, data) {
  const health = await fetch("/api/inbox/health", { cache: "no-store", credentials: "same-origin" });
  if (!health.ok) throw new Error("Could not read inbox session");
  const { serverSession } = await health.json();
  const read = action === "read";
  const path = read
    ? `/api/inbox/m/${encodeURIComponent(data.machine)}/threads/${encodeURIComponent(data.thread)}/read`
    : `/api/inbox/m/${encodeURIComponent(data.machine)}/messages/${encodeURIComponent(data.message)}/resolve`;
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serverSession,
      idempotency_key: crypto.randomUUID(),
      ...(read ? {} : { resolved: true })
    })
  });
  if (!response.ok && response.status !== 202) throw new Error(`Notification action failed (${response.status})`);
}

self.addEventListener("push", (event) => {
  let data = { title: "Pi Inbox", body: "An agent is waiting", url: "/", actions: [] };
  try {
    if (event.data) data = event.data.json();
  } catch {
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data,
    actions: data.actions,
    tag: data.thread || data.url
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || { url: "/" };
  if (event.action !== "read" && event.action !== "archive") {
    event.waitUntil(openThread(data.url));
    return;
  }
  event.waitUntil((async () => {
    try {
      await performAction(event.action, data);
      await self.registration.showNotification("Pi Inbox", {
        body: event.action === "read" ? "Marked as read." : "Thread archived.",
        icon: "/icon.svg"
      });
    } catch {
      await self.registration.showNotification("Pi Inbox", {
        body: "The notification action failed. Open the thread to retry.",
        icon: "/icon.svg"
      });
      await openThread(data.url);
    }
  })());
});
