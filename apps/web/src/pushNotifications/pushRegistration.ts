import type {
  EnvironmentId,
  PushPreferences,
  PushSubscriptionInput,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Mesura: the browser half of Web Push. The desktop shell never registers the worker:
 * it keeps its page notifications, and its window is the screen the phone stays quiet for.
 */

const PUSH_WORKER_URL = "/push-sw.js";
const PUSH_WORKER_SCOPE = "/";
/** The message `push-sw.js` posts to a window it focused for a tapped notification. */
const PUSH_OPEN_MESSAGE = "mesura-push-open";

/** Whether this client can hold a push subscription, and if not, why. */
export type PushSupport = "supported" | "desktop-shell" | "unsupported-browser";

export function detectPushSupport(): PushSupport {
  if (window.desktopBridge !== undefined) return "desktop-shell";
  if (
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    typeof PushManager === "undefined" ||
    typeof Notification === "undefined"
  ) {
    return "unsupported-browser";
  }
  return "supported";
}

function canHaveWorker(): boolean {
  return window.desktopBridge === undefined && "serviceWorker" in navigator;
}

// Page notifications need the registration synchronously, inside the render
// that decides to notify, so the last one seen is kept here. A per-notification
// lookup would make the constructor path asynchronous for every page without
// a worker; `watchPushRegistration` keeps this current instead.
let knownRegistration: ServiceWorkerRegistration | undefined;

/** The push worker's registration as last seen, for showing page notifications. */
export function knownPushRegistration(): ServiceWorkerRegistration | undefined {
  return knownRegistration;
}

/** Looks up the push worker a previous visit registered. */
export async function refreshPushRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  knownRegistration = canHaveWorker()
    ? await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE).catch(() => undefined)
    : undefined;
  return knownRegistration;
}

/**
 * Keeps `knownPushRegistration` current. A worker registered in another tab
 * claims this page on activation, which fires `controllerchange` here.
 */
export function watchPushRegistration(): () => void {
  void refreshPushRegistration();
  if (!canHaveWorker()) return () => undefined;
  const container = navigator.serviceWorker;
  const refresh = () => void refreshPushRegistration();
  container.addEventListener("controllerchange", refresh);
  return () => container.removeEventListener("controllerchange", refresh);
}

async function registerPushWorker(): Promise<ServiceWorkerRegistration> {
  // `updateViaCache: "none"` makes every update check fetch the script itself.
  await navigator.serviceWorker.register(PUSH_WORKER_URL, {
    scope: PUSH_WORKER_SCOPE,
    updateViaCache: "none",
  });
  // `pushManager.subscribe` needs an active worker, and `ready` waits for one.
  knownRegistration = await navigator.serviceWorker.ready;
  return knownRegistration;
}

/** This browser's push subscription, or null when it has none. */
export async function currentBrowserSubscription(): Promise<PushSubscription | null> {
  const registration = await refreshPushRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Registers the worker and subscribes this browser to pushes signed with `publicKey`. */
export async function subscribeBrowser(publicKey: string): Promise<PushSubscription> {
  const registration = await registerPushWorker();
  const applicationServerKey = decodeBase64Url(publicKey);
  const existing = await registration.pushManager.getSubscription();
  // A subscription made for another server key cannot be reused; the browser
  // rejects a subscribe call while it exists.
  if (existing && !sameBytes(existing.options.applicationServerKey, applicationServerKey)) {
    await existing.unsubscribe();
  }
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}

/** The `push.subscribe` payload for a browser subscription. */
export function subscriptionInput(
  subscription: PushSubscription,
  preferences: PushPreferences,
  userAgent = navigator.userAgent,
): PushSubscriptionInput {
  const { keys } = subscription.toJSON();
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (!p256dh || !auth) throw new Error("The browser returned a push subscription without keys.");
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh, auth },
    label: deviceLabel(userAgent),
    preferences,
  };
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function sameBytes(left: ArrayBuffer | null, right: Uint8Array): boolean {
  if (left === null || left.byteLength !== right.byteLength) return false;
  const bytes = new Uint8Array(left);
  return bytes.every((byte, index) => byte === right[index]);
}

/** A short device name for the host's subscription list, such as "Chrome on Android". */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "another system";
  return `${browser} on ${system}`;
}

/** The web router's thread route, `/$environmentId/$threadId`, as a URL path. */
export function threadRoutePath(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function pushOpenPath(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, url } = data as { readonly type?: unknown; readonly url?: unknown };
  if (type !== PUSH_OPEN_MESSAGE || typeof url !== "string") return null;
  // Only a path on this origin; the worker never sends anything else.
  return url.startsWith("/") && !url.startsWith("//") ? url : null;
}

/** Calls `open` with the route of each notification the push worker opens in this window. */
export function listenForPushOpen(open: (path: string) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => undefined;
  const container = navigator.serviceWorker;
  const onMessage = (event: MessageEvent) => {
    const path = pushOpenPath(event.data);
    if (path !== null) open(path);
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}
