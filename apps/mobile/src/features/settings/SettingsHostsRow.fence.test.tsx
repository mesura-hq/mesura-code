// @vitest-environment happy-dom
/**
 * Entry point: SettingsRouteScreen on Android, the `Settings` route of
 * `Stack.tsx`, in its local (no T3 Connect) layout. Its sections, the real
 * SettingsRow and the row's navigation are real; environments, preferences,
 * updates and native chrome are test boundaries.
 *
 * Phase 6 fence, criterion 2 (the Settings half), and the guards for the
 * settings rows this phase adds a row beside.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  navigation: { navigate: vi.fn(), goBack: vi.fn(), setOptions: vi.fn() },
}));

vi.mock(
  "react-native",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).reactNativeDom,
);
vi.mock(
  "../../components/AppSymbol",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).appSymbolDom,
);
vi.mock(
  "../../components/AppText",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).appTextDom,
);
vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidScreenHeader: (props: { title: string }) => <h1>{props.title}</h1>,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => fixture.navigation }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: vi.fn(), isLoaded: true, isSignedIn: false }),
  useUser: () => ({ user: null }),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.0.0", extra: {} } } }));
vi.mock("expo-notifications", () => ({ getPermissionsAsync: async () => ({ granted: false }) }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../agent-awareness/capabilities", () => ({ supportsAgentAwarenessPush: () => false }));
vi.mock("../agent-awareness/androidNotifications", () => ({
  openAndroidLiveUpdateSettings: async () => undefined,
  supportsAndroidLiveUpdateSettings: () => false,
}));
vi.mock("../agent-awareness/liveActivityPreferences", () => ({
  setLiveActivityUpdatesEnabled: vi.fn(),
}));
vi.mock("../agent-awareness/notificationPermissions", () => ({
  requestAgentNotificationPermission: vi.fn(),
}));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  getAgentAwarenessRegistrationStatus: () => "unknown",
  refreshAgentAwarenessRegistration: vi.fn(),
  subscribeAgentAwarenessRegistrationStatus: () => () => undefined,
}));
vi.mock("../cloud/managedRelayState", () => ({ refreshManagedRelayEnvironments: vi.fn() }));
vi.mock("../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => false,
  resolveRelayClerkTokenOptions: () => ({}),
}));
vi.mock("../layout/native-glass-header-items", () => ({
  withNativeGlassHeaderItem: <T,>(item: T) => item,
}));
vi.mock("../layout/workspace-sidebar-toolbar", () => ({ WorkspaceSidebarToolbar: () => null }));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  reportAtomCommandResult: vi.fn(),
  settleAsyncResult: vi.fn(),
  settlePromise: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../state/preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  return {
    mobilePreferencesAtom: Atom.make(AsyncResult.success({})),
    updateMobilePreferencesAtom: Atom.make<unknown>(null),
  };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("@t3tools/client-runtime/state/shared-settings", () => ({
  supportsSharedSettingsSync: () => false,
}));
vi.mock("../threads/use-thread-list-v2-enabled", () => ({ useThreadListV2Enabled: () => true }));
vi.mock("../updates/app-updates", () => ({
  isAppUpdateCheckAvailable: () => false,
  registerHiddenUpdateTap: () => ({ nextCount: 0, shouldCheck: false }),
  runAppUpdateCheck: vi.fn(),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: { label: string }) => <div>{props.label}</div>,
}));

import { SettingsRouteScreen } from "./SettingsRouteScreen";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function openSettings() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<SettingsRouteScreen />));
}

function settingsRows(): string[] {
  return Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [],
    (row) => row.getAttribute("aria-label")!,
  );
}

function settingsRow(label: string): HTMLButtonElement {
  const row = container?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!row) throw new Error(`no settings row labelled "${label}"`);
  return row;
}

beforeEach(() => {
  fixture.navigation.navigate.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("criterion 2: Settings shows a Hosts row next to Usage", () => {
  it("settings Hosts row sits right after Usage and opens the Hosts screen", async () => {
    await openSettings();

    const rows = settingsRows();
    expect(rows.indexOf("Hosts")).toBe(rows.indexOf("Usage") + 1);

    await act(async () => settingsRow("Hosts").click());

    expect(fixture.navigation.navigate).toHaveBeenCalledWith("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsHosts" },
    });
  });
});

describe("guard: the settings rows stay where they are", () => {
  it("settings guard: the existing rows are listed in their order", async () => {
    await openSettings();

    const rows = settingsRows().filter((label) => label !== "Hosts");
    expect(rows).toEqual([
      "Environments",
      "Project Grouping",
      "Usage",
      "Appearance",
      "Archived Threads",
      "Client Storage",
      "Diagnostics",
      "Open source licenses",
      "Legal",
    ]);
  });

  it("settings guard: Usage still opens the Usage screen", async () => {
    await openSettings();

    await act(async () => settingsRow("Usage").click());

    expect(fixture.navigation.navigate).toHaveBeenCalledWith("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsUsage" },
    });
  });
});
