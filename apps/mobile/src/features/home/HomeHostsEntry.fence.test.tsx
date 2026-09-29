// @vitest-environment happy-dom
/**
 * Entry point: HomeRouteScreen on Android, the `Home` route of `Stack.tsx`,
 * rendering the real HomeHeader and its AndroidHomeHeader. The thread list,
 * workspace state and native chrome are test boundaries; the header's buttons
 * and the route screen's navigation wiring are real.
 *
 * Phase 6 fence, criterion 1, and the guards for the Android Home header this
 * phase adds a button to.
 */
import type { PropsWithChildren, ReactNode } from "react";
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
vi.mock("uniwind", async () => (await import("../hosts/reactNativeDomTestDoubles")).uniwindDom);
vi.mock(
  "../../components/AppSymbol",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).appSymbolDom,
);
vi.mock(
  "../../components/AppText",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).appTextDom,
);
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => fixture.navigation,
  useIsFocused: () => true,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  NativeHeaderToolbar: { Button: () => null },
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [], useThreadShells: () => [] }));
vi.mock("../../state/use-pending-new-tasks", () => ({ usePendingNewTasks: () => [] }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ environments: [], state: { hasReadyEnvironment: true } }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../layout/WorkspaceEmptyDetail", () => ({ WorkspaceEmptyDetail: () => null }));
vi.mock("../layout/workspace-sidebar-toolbar", () => ({ WorkspaceSidebarToolbar: () => null }));
vi.mock("../layout/native-glass-header-items", () => ({
  withNativeGlassHeaderItem: <T,>(item: T) => item,
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: false,
  createNativeMailSearchToolbarItem: () => null,
}));
vi.mock("../updates/app-updates", () => ({
  checkForAppUpdateOnLaunch: async () => undefined,
  startAppUpdateForegroundRecheck: () => undefined,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ materialYouStyleLayoutActive: false }),
}));
vi.mock("../threads/use-thread-list-v2-enabled", () => ({ useThreadListV2Enabled: () => false }));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({
  useHardwareKeyboardCommand: () => undefined,
}));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: (props: PropsWithChildren) => props.children,
}));
vi.mock("../../components/MesuraWordmark", () => ({ MesuraWordmark: () => null }));
vi.mock("../../lib/mobileBranding", () => ({ resolveMobileStageLabel: () => "dev" }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("./AndroidHomeFab", () => ({
  AndroidHomeFabLayout: (props: { children: ReactNode }) => props.children,
}));
vi.mock("./HomeScreen", () => ({ HomeScreen: () => null }));
vi.mock("./home-thread-navigation", () => ({ useHomeThreadSelection: () => vi.fn() }));
vi.mock("./homeThreadList", () => ({ buildHomeProjectScopes: () => [] }));
vi.mock("./usePendingTaskListActions", () => ({
  usePendingTaskListActions: () => ({
    openPendingTask: vi.fn(),
    confirmDeletePendingTask: vi.fn(),
  }),
}));
vi.mock("./useThreadListActions", () => ({ useThreadListActions: () => ({}) }));
vi.mock("./use-thread-sort-order-persistence", () => ({
  useThreadSortOrderPersistence: () => undefined,
}));
vi.mock("./WorkspaceConnectionTitle", () => ({
  getConnectionAwareBrandHeaderOptions: () => ({}),
  WorkspaceConnectionTitle: (props: { brand: ReactNode }) => props.brand,
}));

import { HomeRouteScreen } from "./HomeRouteScreen";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mountHome() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<HomeRouteScreen />));
}

function button(label: string): HTMLButtonElement {
  const element = container?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`no button labelled "${label}"`);
  return element;
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

describe("criterion 1: the Android Home header opens Hosts in one tap", () => {
  it("home header server button opens the Hosts screen in one tap", async () => {
    await mountHome();

    await act(async () => button("Open hosts").click());

    expect(fixture.navigation.navigate).toHaveBeenCalledTimes(1);
    expect(fixture.navigation.navigate).toHaveBeenCalledWith("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsHosts" },
    });
  });
});

describe("guard: the Android Home header keeps its controls", () => {
  it("home header guard: the settings gear still opens Settings", async () => {
    await mountHome();

    await act(async () => button("Open settings").click());

    expect(fixture.navigation.navigate).toHaveBeenCalledWith("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "Settings" },
    });
  });

  it("home header guard: the filter button and the thread search stay in the header", async () => {
    await mountHome();

    expect(button("Filter and sort threads")).toBeTruthy();
    expect(container?.querySelector('input[aria-label="Search threads"]')).not.toBeNull();
  });
});
