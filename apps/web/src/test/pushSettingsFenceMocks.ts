import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { type Mock, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";

/**
 * Mocks for the `-settingsPushNotifications*.fence` tests, loaded from inside their hoisted
 * `vi.mock` factories (see `appRootFenceMocks.tsx`), so no runtime imports of the app. Replaced:
 * the browser push stack (headless Chromium has no push service), the push RPCs at `useAtomCommand`,
 * their permission, client settings, project groups and environment discovery.
 */

export const PUSH_FENCE_PRIMARY_ENVIRONMENT_ID = "push-fence-primary";
export const PUSH_FENCE_ENDPOINT = "https://fcm.googleapis.com/fcm/send/push-fence-device";
export const PUSH_FENCE_DEVICE_KEYS = { p256dh: "BPushFenceP256dhKey", auth: "pushFenceAuth" };

/** A 65-byte uncompressed P-256 point, as a VAPID public key is. */
export const PUSH_FENCE_VAPID_KEY_BYTES = Uint8Array.from({ length: 65 }, (_, index) =>
  index === 0 ? 4 : (index * 37) % 256,
);
const VAPID_PUBLIC_KEY = btoa(String.fromCharCode(...PUSH_FENCE_VAPID_KEY_BYTES))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");

const DEFAULT_PREFERENCES = { approval: true, input: true, failed: true, completed: false };

export type PushRpcMethod = "publicKey" | "subscribe" | "unsubscribe" | "status" | "sendTest";

interface FakeSubscription {
  readonly endpoint: string;
  readonly options: { applicationServerKey: ArrayBuffer | null; userVisibleOnly: boolean };
  readonly toJSON: () => unknown;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  readonly getKey: (name: string) => ArrayBuffer | null;
}

export const pushSettingsFence = {
  storedClientSettings: null as Record<string, unknown> | null,
  serverSubscribed: false,
  rpc: [] as Array<{ method: PushRpcMethod; environmentId: unknown; input: unknown }>,
  /** Whether the connection holds the settings scope the push RPCs need. */
  canWriteSettings: true,
  /** RPCs that fail, as an unreachable host answers. */
  failing: new Set<PushRpcMethod>(),
  /** The primary environment's connection phase, or null for no presentation. */
  primaryConnectionPhase: null as string | null,
  permission: "default" as NotificationPermission,
  /** What the permission prompt answers when the switch asks. */
  permissionAnswer: "granted" as NotificationPermission,
  subscription: null as FakeSubscription | null,
  registered: false,
  requestPermission: vi.fn() as Mock,
  register: vi.fn() as Mock,
  subscribe: vi.fn() as Mock,
  showNotification: vi.fn() as Mock,
};

function pushMethodOf(label: string | undefined): PushRpcMethod | null {
  const key = (label ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!key.includes("push")) return null;
  if (key.includes("publickey")) return "publicKey";
  if (key.includes("unsubscribe")) return "unsubscribe";
  if (key.includes("subscribe")) return "subscribe";
  if (key.includes("status")) return "status";
  if (key.includes("test")) return "sendTest";
  return null;
}

function answerPush(method: PushRpcMethod): unknown {
  switch (method) {
    case "publicKey":
      return { publicKey: VAPID_PUBLIC_KEY };
    case "subscribe":
      pushSettingsFence.serverSubscribed = true;
      return { subscribed: true, preferences: DEFAULT_PREFERENCES };
    case "unsubscribe":
      pushSettingsFence.serverSubscribed = false;
      return { removed: true };
    case "status":
      return pushSettingsFence.serverSubscribed
        ? { subscribed: true, preferences: DEFAULT_PREFERENCES }
        : { subscribed: false };
    case "sendTest":
      return { outcome: "delivered" };
  }
}

export function mockUseAtomCommand() {
  return {
    useAtomCommand: (command: { label?: string }, options?: string | { label?: string }) => {
      const label = typeof options === "string" ? options : (options?.label ?? command.label);
      return async (value: { environmentId?: unknown; input?: unknown } | undefined) => {
        const method = pushMethodOf(command.label) ?? pushMethodOf(label);
        if (method === null) return { _tag: "Success", value: undefined };
        pushSettingsFence.rpc.push({
          method,
          environmentId: value?.environmentId,
          input: value?.input,
        });
        if (pushSettingsFence.failing.has(method)) {
          return { _tag: "Failure", cause: Cause.fail(new Error("The host did not answer.")) };
        }
        return { _tag: "Success", value: answerPush(method) };
      };
    },
  };
}

const settingsWritable = Atom.make(true);
const settingsReadOnly = Atom.make(false);

export async function mockPushNotificationsState(original: () => Promise<object>) {
  return {
    ...(await original()),
    pushSettingsPermissionAtom: () =>
      pushSettingsFence.canWriteSettings ? settingsWritable : settingsReadOnly,
  };
}

export async function mockLocalApi(original: () => Promise<object>) {
  return {
    ...(await original()),
    ensureLocalApi: () => ({
      persistence: {
        getClientSettings: async () => pushSettingsFence.storedClientSettings,
        setClientSettings: async (settings: Record<string, unknown>) => {
          pushSettingsFence.storedClientSettings = settings;
        },
      },
    }),
  };
}

export function mockSettingsProjectGroups() {
  return { useSettingsProjectGroups: () => [] };
}

const primaryPresentationListeners = new Set<() => void>();
let primaryPresentation: { label: string; connection: { phase: string } } | null = null;

/** Moves the primary connection to `phase`, as the connection supervisor does. */
export function setPrimaryConnectionPhase(phase: string | null): void {
  pushSettingsFence.primaryConnectionPhase = phase;
  primaryPresentation = phase === null ? null : { label: "Fence host", connection: { phase } };
  for (const listener of primaryPresentationListeners) listener();
}

export async function mockEnvironments(original: () => Promise<object>) {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    primaryPresentationListeners.add(listener);
    return () => void primaryPresentationListeners.delete(listener);
  };
  return {
    ...(await original()),
    useEnvironments: () => ({ environments: [], isReady: true }),
    usePrimaryEnvironmentId: () => PUSH_FENCE_PRIMARY_ENVIRONMENT_ID,
    usePrimaryEnvironment: () => useSyncExternalStore(subscribe, () => primaryPresentation),
    useEnvironmentProviders: () => new Map(),
  };
}

export async function mockPrimaryEnvironment() {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(PUSH_FENCE_PRIMARY_ENVIRONMENT_ID) };
}

function makeSubscription(): FakeSubscription {
  return {
    endpoint: PUSH_FENCE_ENDPOINT,
    options: { applicationServerKey: PUSH_FENCE_VAPID_KEY_BYTES.buffer, userVisibleOnly: true },
    toJSON: () => ({
      endpoint: PUSH_FENCE_ENDPOINT,
      expirationTime: null,
      keys: PUSH_FENCE_DEVICE_KEYS,
    }),
    unsubscribe: vi.fn(async () => {
      pushSettingsFence.subscription = null;
      return true;
    }),
    getKey: () => null,
  };
}

const registration = {
  scope: `${location.origin}/`,
  active: { scriptURL: `${location.origin}/push-sw.js`, state: "activated" },
  installing: null,
  waiting: null,
  pushManager: {
    getSubscription: async () => pushSettingsFence.subscription,
    permissionState: async () =>
      pushSettingsFence.permission === "default"
        ? "prompt"
        : (pushSettingsFence.permission as PermissionState),
    subscribe: (options: PushSubscriptionOptionsInit) => pushSettingsFence.subscribe(options),
  },
  showNotification: (title: string, options?: NotificationOptions) =>
    pushSettingsFence.showNotification(title, options),
  getNotifications: async () => [],
  update: async () => undefined,
  unregister: async () => true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const fakeNotification = {
  get permission() {
    return pushSettingsFence.permission;
  },
  requestPermission: () => pushSettingsFence.requestPermission(),
};

const serviceWorkerContainer = Object.assign(new EventTarget(), {
  controller: null,
  register: (url: string | URL, options?: RegistrationOptions) =>
    pushSettingsFence.register(url, options),
  getRegistration: async () => (pushSettingsFence.registered ? registration : undefined),
  getRegistrations: async () => (pushSettingsFence.registered ? [registration] : []),
  startMessages: () => undefined,
});
// `Object.assign` would read a getter once; `ready` must follow the registration.
Object.defineProperty(serviceWorkerContainer, "ready", {
  get: () =>
    pushSettingsFence.registered ? Promise.resolve(registration) : new Promise(() => undefined),
});

/** Installs the fake push stack for one test and resets every recorded call. */
export function installPushBrowser({
  pushSupported = true,
  permission = "default" as NotificationPermission,
  subscribed = false,
} = {}): AsyncDisposable {
  const stack = new AsyncDisposableStack();
  const fence = pushSettingsFence;
  fence.storedClientSettings = null;
  fence.rpc = [];
  fence.canWriteSettings = true;
  fence.failing = new Set();
  setPrimaryConnectionPhase(null);
  fence.serverSubscribed = subscribed;
  fence.permission = permission;
  fence.permissionAnswer = "granted";
  fence.registered = subscribed;
  fence.subscription = subscribed ? makeSubscription() : null;
  fence.requestPermission.mockReset().mockImplementation(async () => {
    fence.permission = fence.permissionAnswer;
    return fence.permission;
  });
  fence.register.mockReset().mockImplementation(async () => {
    fence.registered = true;
    return registration;
  });
  fence.subscribe.mockReset().mockImplementation(async () => {
    fence.subscription = makeSubscription();
    return fence.subscription;
  });
  fence.showNotification.mockReset().mockResolvedValue(undefined);

  const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", {
    value: serviceWorkerContainer,
    configurable: true,
  });
  stack.defer(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
    } else Reflect.deleteProperty(navigator, "serviceWorker");
  });
  stack.use(stubGlobal("Notification", fakeNotification));
  if (pushSupported) {
    // Feature detection only checks that the constructor exists.
    stack.use(stubGlobal("PushManager", function PushManager() {}));
  } else {
    const original = Object.getOwnPropertyDescriptor(globalThis, "PushManager");
    Reflect.deleteProperty(globalThis, "PushManager");
    stack.defer(() => {
      if (original) Object.defineProperty(globalThis, "PushManager", original);
    });
  }
  return stack;
}

export function pushRpcCalls(method: PushRpcMethod) {
  return pushSettingsFence.rpc.filter((call) => call.method === method);
}
