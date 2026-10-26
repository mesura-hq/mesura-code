import { Atom } from "effect/reactivity";
import { vi } from "vite-plus/test";

/**
 * The fixture the `AppRoot.presence*.fence` tests mount the app over: the
 * page's visibility, focus and input, the presence RPC and one `vi.mock`
 * factory per replaced boundary, wired through a hoisted loader:
 *
 * ```ts
 * const fenceMocks = vi.hoisted(() => () => import("./test/presenceFenceMocks"));
 * vi.mock("./state/pushNotifications", async (original) =>
 *   (await fenceMocks()).mockPushNotificationsState(original),
 * );
 * ```
 *
 * This module must stay free of runtime imports of the app, because it is
 * loaded from inside those factories. Mounting lives in `presenceFenceApp.tsx`.
 *
 * Boundaries replaced, and nothing else:
 * - The presence RPC, at `openPresenceReport` in `~/state/pushNotifications`:
 *   the `push.presence` call stays open while its report holds, so each
 *   report is recorded with the fake clock's time, and `openReports` counts
 *   the reports opened and not yet closed.
 * - The environments: `useEnvironments` lists `presenceFence.environments`,
 *   all connected, and re-renders its readers when `setEnvironments` changes
 *   the list, as a host connecting or disconnecting does; `useServerConfigs` (`~/state/entities`) advertises
 *   `pushPresence` for those marked `takesPresence`; `pushSettingsPermissionAtom`
 *   grants for those marked `granted`. The primary environment id, at
 *   `~/state/environments` and `~/state/primaryEnvironment`, is the first.
 * - The page: `document.visibilityState`, `document.hidden` and
 *   `document.hasFocus()` follow `setPage`, which also fires the events a
 *   browser fires. Headless Chromium's own focus cannot be driven.
 */

export const PRESENCE_FENCE_PRIMARY_ENVIRONMENT_ID = "presence-fence-primary";

export interface PresenceReport {
  readonly environmentId: unknown;
  readonly input: unknown;
  /** `Date.now()` on the fake clock when the report left. */
  readonly at: number;
}

export interface PresenceFenceEnvironment {
  readonly environmentId: string;
  /** The server advertises `pushPresence`. */
  readonly takesPresence: boolean;
  /** This connection holds the scope the push RPCs need. */
  readonly granted: boolean;
}

const PRIMARY_ONLY: ReadonlyArray<PresenceFenceEnvironment> = [
  { environmentId: PRESENCE_FENCE_PRIMARY_ENVIRONMENT_ID, takesPresence: true, granted: true },
];

export const presenceFence = {
  reports: [] as Array<PresenceReport>,
  environments: PRIMARY_ONLY,
  /** Reports opened and not yet closed; the client holds at most one. */
  openReports: 0,
  visible: true,
  focused: true,
};

const granted = Atom.make(true);
const refused = Atom.make(false);

const permissionFor = (environmentId: unknown) =>
  presenceFence.environments.some(
    (environment) => environment.environmentId === environmentId && environment.granted,
  )
    ? granted
    : refused;

export async function mockPushNotificationsState(original: () => Promise<object>) {
  const actual = (await original()) as Record<string, unknown>;
  const mocked: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === "object" && value !== null && "permissionAtom" in value) {
      mocked[name] = { ...value, permissionAtom: permissionFor };
    } else if (name.endsWith("PermissionAtom")) {
      mocked[name] = permissionFor;
    } else {
      mocked[name] = value;
    }
  }
  mocked.openPresenceReport = (_registry: unknown, environmentId: unknown, active: unknown) => {
    presenceFence.reports.push({ environmentId, input: { active }, at: Date.now() });
    presenceFence.openReports += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      presenceFence.openReports -= 1;
    };
  };
  return mocked;
}

const environmentListeners = new Set<() => void>();

const subscribeToEnvironments = (listener: () => void) => {
  environmentListeners.add(listener);
  return () => void environmentListeners.delete(listener);
};

/** Changes the connected environments after mount; call it inside `act`. */
export function setEnvironments(next: ReadonlyArray<PresenceFenceEnvironment>): void {
  presenceFence.environments = next;
  for (const listener of environmentListeners) listener();
}

/** One derived value per environment list, so a snapshot is stable between changes. */
function perEnvironmentList<A>(derive: (list: ReadonlyArray<PresenceFenceEnvironment>) => A) {
  let source: ReadonlyArray<PresenceFenceEnvironment> | null = null;
  let value: A;
  return () => {
    if (source !== presenceFence.environments) {
      source = presenceFence.environments;
      value = derive(source);
    }
    return value;
  };
}

const environmentsSnapshot = perEnvironmentList((list) => ({
  environments: list.map(({ environmentId }) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
  })),
  isReady: true,
}));

const serverConfigsSnapshot = perEnvironmentList(
  (list) =>
    new Map(
      list.map(({ environmentId, takesPresence }) => [
        environmentId,
        { environment: { capabilities: takesPresence ? { pushPresence: true } : {} } },
      ]),
    ),
);

export async function mockEnvironments(original: () => Promise<object>) {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    usePrimaryEnvironmentId: () => presenceFence.environments[0]?.environmentId ?? null,
    useEnvironments: () => useSyncExternalStore(subscribeToEnvironments, environmentsSnapshot),
  };
}

export async function mockEntities(original: () => Promise<object>) {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useServerConfigs: () => useSyncExternalStore(subscribeToEnvironments, serverConfigsSnapshot),
  };
}

export async function mockPrimaryEnvironment(original: () => Promise<object>) {
  return {
    ...(await original()),
    primaryEnvironmentIdAtom: Atom.make(PRESENCE_FENCE_PRIMARY_ENVIRONMENT_ID),
  };
}

export interface PresencePageOptions {
  readonly visible?: boolean;
  readonly focused?: boolean;
  readonly environments?: ReadonlyArray<PresenceFenceEnvironment>;
}

/** Starts a test: no reports, a visible and focused page, and the stubs installed. */
export function installPresencePage(initial: PresencePageOptions = {}): Disposable {
  presenceFence.reports.length = 0;
  presenceFence.openReports = 0;
  presenceFence.environments = initial.environments ?? PRIMARY_ONLY;
  presenceFence.visible = initial.visible ?? true;
  presenceFence.focused = initial.focused ?? true;
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => (presenceFence.visible ? "visible" : "hidden"));
  const hidden = vi
    .spyOn(document, "hidden", "get")
    .mockImplementation(() => !presenceFence.visible);
  const hasFocus = vi.spyOn(document, "hasFocus").mockImplementation(() => presenceFence.focused);
  return {
    [Symbol.dispose]() {
      visibility.mockRestore();
      hidden.mockRestore();
      hasFocus.mockRestore();
    },
  };
}

/** Changes the page as a browser would, firing the events for what changed. */
export function setPage(next: { readonly visible?: boolean; readonly focused?: boolean }): void {
  if (next.visible !== undefined && next.visible !== presenceFence.visible) {
    presenceFence.visible = next.visible;
    document.dispatchEvent(new Event("visibilitychange"));
  }
  if (next.focused !== undefined && next.focused !== presenceFence.focused) {
    presenceFence.focused = next.focused;
    window.dispatchEvent(new FocusEvent(next.focused ? "focus" : "blur"));
  }
}

/** One input from the developer, as the document receives it. */
export function giveInput(kind: "pointer" | "key" = "pointer"): void {
  document.dispatchEvent(
    kind === "pointer"
      ? new PointerEvent("pointerdown", { bubbles: true })
      : new KeyboardEvent("keydown", { bubbles: true, key: "j" }),
  );
}

/** The `active` value of every report so far, in order. */
export function reportedStates(): Array<unknown> {
  return presenceFence.reports.map((report) => (report.input as { active?: unknown })?.active);
}

/** `ClientPresence.ACTIVE_REPORT_LIFETIME_MS` on the server. */
const HOST_ACTIVE_REPORT_LIFETIME_MS = 2 * 60 * 1000;

/**
 * Whether a host that received these reports holds pushes at `time`: its
 * latest report is active and younger than two minutes, as `ClientPresence`
 * decides on the server.
 */
export function hostHoldsPushesAt(
  time: number,
  environmentId: string = PRESENCE_FENCE_PRIMARY_ENVIRONMENT_ID,
): boolean {
  const latest = presenceFence.reports.findLast(
    (report) => report.environmentId === environmentId && report.at <= time,
  );
  return (
    (latest?.input as { active?: unknown } | undefined)?.active === true &&
    time - latest!.at < HOST_ACTIVE_REPORT_LIFETIME_MS
  );
}
