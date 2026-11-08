// Mesura: the Web Push service worker. It only shows pushes and opens the
// thread a tapped notification names. It has no fetch handler and keeps
// no cache, so a deploy is never served stale and a fixed worker replaces a
// broken one on the next page load.

const FALLBACK_TITLE = "Mesura Code";
const ICON = "/icon-192.png";

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(data) {
  if (!data) return null;
  try {
    const payload = data.json();
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

self.addEventListener("push", (event) => {
  // Chrome requires every push to show a notification; an unreadable payload
  // still shows one rather than Chrome's generic "site updated" notice.
  const payload = readPayload(event.data);
  const tag = stringOr(payload?.tag, undefined);
  event.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(stringOr(payload?.title, FALLBACK_TITLE), {
          body: stringOr(payload?.body, ""),
          tag,
          renotify: tag !== undefined,
          data: { url: stringOr(payload?.url, "/") },
          icon: ICON,
          badge: ICON,
        });
      } catch {
        // The payload's options were refused; a bare notification still meets Chrome's rule.
        await self.registration.showNotification(FALLBACK_TITLE, { data: { url: "/" } });
      }
    })(),
  );
});

/** Only a path on this origin; anything else opens the app's root. */
function appPath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = appPath(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = windows[0];
      if (!target) {
        await self.clients.openWindow(url);
        return;
      }
      await target.focus();
      // The app navigates with its own router (`pushRegistration.ts`), which
      // keeps its state instead of reloading the page.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worker's Client.postMessage takes no targetOrigin; it reaches only this origin's window.
      target.postMessage({ type: "mesura-push-open", url });
    })(),
  );
});
