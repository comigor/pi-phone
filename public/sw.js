self.addEventListener("push", (event) => {
  let data = { title: "Pi Inbox", body: "An agent is waiting", url: "/" };
  try {
    if (event.data) data = event.data.json();
  } catch {
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: data.url },
    tag: data.url
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    if (existing) {
      await existing.focus();
      existing.navigate(event.notification.data.url);
      return;
    }
    return clients.openWindow(event.notification.data.url);
  }));
});
