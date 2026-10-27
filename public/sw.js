// The service worker: shows the reminders the server sends (src/server/push.ts) and opens the
// app when one is tapped. It does nothing else: pages and data load as they always do.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show the default below. A push must always show something on iPhone.
  }
  event.waitUntil(
    self.registration.showNotification(message.title || "Mandala", {
      body: message.body || "",
      tag: message.tag,
      icon: "/icon-192.png",
      data: { url: message.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      // The app already open: bring it to the front instead of opening a second one.
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const app = open.find((client) => new URL(client.url).origin === self.location.origin);
      if (app) return app.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
