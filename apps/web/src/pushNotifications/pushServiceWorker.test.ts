// @effect-diagnostics nodeBuiltinImport:off - loads the shipped worker script off the checkout, outside any Effect.
/**
 * Entry point: `apps/web/public/push-sw.js`, the file the browser registers,
 * evaluated as a classic worker script inside a fresh `node:vm` context whose
 * global is a fake `ServiceWorkerGlobalScope`: `self`, `clients`,
 * `registration`, `skipWaiting` and `addEventListener` are fixtures, so the
 * script may reach them either as `self.x` or as bare globals.
 *
 * Phone push phase 2, criteria 4 (a notification per push, with its tag, and
 * no fetch handler) and 5 (a click focuses an open window and asks it to open
 * the thread route, or opens a new window at that route).
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

const WORKER_PATH = NodeURL.fileURLToPath(new URL("../../public/push-sw.js", import.meta.url));
const ORIGIN = "https://vigilia-home.example.ts.net:8443";
const THREAD_ROUTE = "/push-env/push-thread";

interface FakeClient {
  readonly url: string;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly navigate: ReturnType<typeof vi.fn>;
}

function makeClient(url = `${ORIGIN}/`): FakeClient {
  const client: FakeClient = {
    url,
    focus: vi.fn(async () => client),
    postMessage: vi.fn(),
    navigate: vi.fn(async () => client),
  };
  return client;
}

/** Loads the worker into a fresh fake global scope and returns its listeners. */
function loadWorker({ windows = [] as FakeClient[] } = {}) {
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  const registration = {
    showNotification: vi.fn(async (_title: string, _options?: NotificationOptions) => undefined),
    scope: `${ORIGIN}/`,
  };
  const clients = {
    matchAll: vi.fn(async () => windows),
    openWindow: vi.fn(async (_url: string) => null),
    claim: vi.fn(async () => undefined),
  };
  const scope: Record<string, unknown> = {
    registration,
    clients,
    location: new URL(`${ORIGIN}/push-sw.js`),
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, listener: (event: unknown) => unknown) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    URL,
    console,
  };
  scope.self = scope;
  NodeVM.runInNewContext(NodeFS.readFileSync(WORKER_PATH, "utf8"), scope, {
    filename: WORKER_PATH,
  });

  /** Fires an extendable event and waits for every `waitUntil` promise. */
  async function fire(type: string, fields: Record<string, unknown> = {}) {
    const pending: Array<Promise<unknown>> = [];
    const event = {
      type,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      ...fields,
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    await Promise.all(pending);
  }

  return { listeners, registration, clients, scope, fire };
}

function pushData(json: () => unknown) {
  return {
    json,
    text: () => {
      const value = json();
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

const PAYLOAD = {
  title: "mesura-code",
  body: "Fix the push sender\nneeds your approval",
  tag: "thread:push-env:push-thread",
  url: THREAD_ROUTE,
};

function samePath(value: unknown): string {
  return new URL(String(value), ORIGIN).pathname;
}

describe("push service worker (criterion 4: one notification per push)", () => {
  it("push service worker spec: a push shows one notification with the payload's title, body, tag and route", async () => {
    const worker = loadWorker();

    await worker.fire("push", { data: pushData(() => PAYLOAD) });

    expect(worker.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.registration.showNotification).toHaveBeenCalledWith(
      PAYLOAD.title,
      expect.objectContaining({
        body: PAYLOAD.body,
        tag: PAYLOAD.tag,
        data: expect.objectContaining({ url: PAYLOAD.url }),
      }),
    );
  });

  it("push service worker spec: a push whose body is not JSON still shows a Mesura Code notification", async () => {
    const worker = loadWorker();

    await worker.fire("push", {
      data: pushData(() => {
        throw new SyntaxError("Unexpected token");
      }),
    });

    expect(worker.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.registration.showNotification.mock.calls[0]![0]).toBe("Mesura Code");
  });

  it("push service worker spec: a push with no data still shows a Mesura Code notification", async () => {
    const worker = loadWorker();

    await worker.fire("push", { data: null });

    expect(worker.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.registration.showNotification.mock.calls[0]![0]).toBe("Mesura Code");
  });

  it("push service worker spec: the worker registers no fetch handler and never touches the Cache API", () => {
    const worker = loadWorker();

    expect([...worker.listeners.keys()]).toContain("push");
    expect(worker.listeners.has("fetch")).toBe(false);
    expect(NodeFS.readFileSync(WORKER_PATH, "utf8")).not.toMatch(/\bcaches\b/);
  });

  it("push service worker spec: an updated worker takes over at once with skipWaiting and clients.claim", async () => {
    const worker = loadWorker();

    await worker.fire("install");
    await worker.fire("activate");

    expect(worker.scope.skipWaiting).toHaveBeenCalled();
    expect(worker.clients.claim).toHaveBeenCalled();
  });
});

// The review of phase 2 asked what happens when Chrome refuses the notification itself.
describe("push service worker regression: a refused notification", () => {
  it("push service worker regression: a showNotification that rejects falls back to a Mesura Code notification", async () => {
    const worker = loadWorker();
    worker.registration.showNotification.mockRejectedValueOnce(new TypeError("Bad options"));

    await worker.fire("push", { data: pushData(() => PAYLOAD) });

    expect(worker.registration.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.registration.showNotification.mock.calls[1]![0]).toBe("Mesura Code");
  });

  it("push service worker regression: a showNotification that throws falls back to a Mesura Code notification", async () => {
    const worker = loadWorker();
    worker.registration.showNotification.mockImplementationOnce(() => {
      throw new TypeError("Bad options");
    });

    await worker.fire("push", { data: pushData(() => PAYLOAD) });

    expect(worker.registration.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.registration.showNotification.mock.calls[1]![0]).toBe("Mesura Code");
  });
});

describe("push service worker (criterion 5: a click opens the thread)", () => {
  function clickEvent() {
    return {
      notification: {
        title: PAYLOAD.title,
        tag: PAYLOAD.tag,
        data: { url: THREAD_ROUTE },
        close: vi.fn(),
      },
      action: "",
    };
  }

  it("push service worker spec: a click with an app window open focuses it and posts mesura-push-open with the route", async () => {
    const appWindow = makeClient();
    const worker = loadWorker({ windows: [appWindow] });
    const event = clickEvent();

    await worker.fire("notificationclick", event);

    expect(event.notification.close).toHaveBeenCalled();
    expect(worker.clients.matchAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: "window", includeUncontrolled: true }),
    );
    expect(appWindow.focus).toHaveBeenCalled();
    expect(appWindow.postMessage).toHaveBeenCalledWith({
      type: "mesura-push-open",
      url: THREAD_ROUTE,
    });
    expect(worker.clients.openWindow).not.toHaveBeenCalled();
  });

  it("push service worker spec: a click with no app window open opens a new window at the thread route", async () => {
    const worker = loadWorker({ windows: [] });
    const event = clickEvent();

    await worker.fire("notificationclick", event);

    expect(event.notification.close).toHaveBeenCalled();
    expect(worker.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(samePath(worker.clients.openWindow.mock.calls[0]![0])).toBe(THREAD_ROUTE);
  });
});
