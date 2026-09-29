/**
 * Entry point: RootStack, the static navigator `App.tsx` hands to
 * `createStaticNavigation` with its deep-link prefixes. The path config is
 * derived from it by React Navigation's own `createPathConfigForStaticNavigation`
 * and resolved by its own `getStateFromPath`, exactly as the linking container
 * does after stripping a prefix. The navigator factories record their static
 * config instead of rendering, and every screen module is a stub: only the
 * route tree and its `linking` paths are under test. `@react-navigation/native`
 * is replaced by the same functions taken from `@react-navigation/core`.
 *
 * Phase 6 fence, criterion 3, and the guards for the deep links that exist.
 */
import { describe, expect, it, vi } from "vite-plus/test";

const stubs = vi.hoisted(() => {
  const component = () => null;
  /**
   * A module whose named exports are inert components. The names are listed
   * because a catch-all Proxy module stalls vitest's module loader.
   */
  const stubModule = (...names: string[]) =>
    Object.fromEntries(names.map((name) => [name, component]));
  return { stubModule };
});

// The linking functions come from `@react-navigation/core`, which
// `@react-navigation/native` re-exports. Loading native itself pulls in the
// React Native module graph, so the spec reaches its sibling core package.
vi.mock("@react-navigation/native", async () => {
  const NodeFs = await import("node:fs");
  const NodeModule = await import("node:module");
  const NodePath = await import("node:path");
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = NodeFs.realpathSync(
    require.resolve("@react-navigation/native/package.json"),
  );
  const coreModules = NodePath.join(NodePath.dirname(nativePackage), "..", "core", "lib", "module");
  const staticNavigation = await import(NodePath.join(coreModules, "StaticNavigation.js"));
  const stateFromPath = await import(NodePath.join(coreModules, "getStateFromPath.js"));
  const pathFromState = await import(NodePath.join(coreModules, "getPathFromState.js"));
  return {
    createPathConfigForStaticNavigation: staticNavigation.createPathConfigForStaticNavigation,
    getStateFromPath: stateFromPath.getStateFromPath,
    getPathFromState: pathFromState.getPathFromState,
    StackActions: { replace: () => ({}) },
    useNavigation: () => ({}),
  };
});
vi.mock(
  "react-native",
  async () => (await import("./features/hosts/reactNativeDomTestDoubles")).reactNativeDom,
);
vi.mock(
  "uniwind",
  async () => (await import("./features/hosts/reactNativeDomTestDoubles")).uniwindDom,
);
vi.mock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: (config: unknown) => ({ config }),
  createNativeStackScreen: <T>(screen: T) => screen,
}));
vi.mock("./native/StackHeader", () => ({ nativeHeaderScrollEdgeEffects: () => undefined }));
vi.mock("./native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("./native/sheet-surface", () => ({ FORM_SHEET_PRESENTATION_OPTIONS: {} }));
vi.mock("./components/CompactBrandTitle", () => ({ getCompactBrandHeaderOptions: () => ({}) }));
vi.mock("./components/AppText", () => stubs.stubModule("AppText"));
vi.mock("./features/agent-awareness/notificationNavigation", () =>
  stubs.stubModule("useAgentNotificationNavigation"),
);
vi.mock("./features/archive/ArchivedThreadsRouteScreen", () =>
  stubs.stubModule("ArchivedThreadsRouteScreen"),
);
vi.mock("./features/cloud/connectOnboardingNavigation", () =>
  stubs.stubModule("useConnectOnboardingNavigation"),
);
vi.mock("./features/cloud/ConnectOnboardingRouteScreen", () =>
  stubs.stubModule("ConnectOnboardingRouteScreen"),
);
vi.mock("./features/connection/ConnectionsNewRouteScreen", () =>
  stubs.stubModule("ConnectionsNewRouteScreen"),
);
vi.mock("./features/connection/ConnectionsRouteScreen", () =>
  stubs.stubModule("ConnectionsRouteScreen"),
);
vi.mock("./features/diagnostics/SettingsDiagnosticsRouteScreen", () =>
  stubs.stubModule("SettingsDiagnosticsRouteScreen"),
);
vi.mock("./features/files/AttachmentFileScreen", () => stubs.stubModule("AttachmentFileScreen"));
vi.mock("./features/files/ThreadFilesRouteScreen", () =>
  stubs.stubModule("ThreadFilesTreeScreen", "ThreadFileScreen"),
);
vi.mock("./features/home/HomeRouteScreen", () => stubs.stubModule("HomeRouteScreen"));
vi.mock("./features/hosts/HostsRouteScreen", () => stubs.stubModule("HostsRouteScreen"));
vi.mock("./features/keyboard/HardwareKeyboardCommandProvider", () =>
  stubs.stubModule("HardwareKeyboardCommandOverlay", "HardwareKeyboardCommandProvider"),
);
vi.mock("./features/layout/AdaptiveWorkspaceLayout", () =>
  stubs.stubModule("AdaptiveWorkspaceLayout"),
);
vi.mock("./features/projects/AddProjectDestinationRoute", () =>
  stubs.stubModule("AddProjectDestinationRoute"),
);
vi.mock("./features/projects/AddProjectLocalRoute", () => stubs.stubModule("AddProjectLocalRoute"));
vi.mock("./features/projects/AddProjectRepositoryRoute", () =>
  stubs.stubModule("AddProjectRepositoryRoute"),
);
vi.mock("./features/projects/AddProjectSourceRoute", () =>
  stubs.stubModule("AddProjectSourceRoute"),
);
vi.mock("./features/review/ReviewCommentComposerSheet", () =>
  stubs.stubModule("ReviewCommentComposerSheet"),
);
vi.mock("./features/review/ReviewSheet", () => stubs.stubModule("ReviewSheet"));
vi.mock("./features/settings/components/SettingsLegalDocumentRouteScreen", () =>
  stubs.stubModule(
    "SettingsLegalDocumentCloseHeaderButton",
    "SettingsLegalDocumentExternalHeaderButton",
  ),
);
vi.mock("./features/settings/SettingsAppearanceRouteScreen", () =>
  stubs.stubModule("SettingsAppearanceRouteScreen"),
);
vi.mock("./features/settings/SettingsAuthRouteScreen", () =>
  stubs.stubModule("SettingsAuthRouteScreen"),
);
vi.mock("./features/settings/SettingsClientStorageRouteScreen", () =>
  stubs.stubModule("SettingsClientStorageRouteScreen"),
);
vi.mock("./features/settings/SettingsEnvironmentsRouteScreen", () =>
  stubs.stubModule("SettingsEnvironmentsRouteScreen"),
);
vi.mock("./features/settings/SettingsKeyboardRouteScreen", () =>
  stubs.stubModule("SettingsKeyboardRouteScreen"),
);
vi.mock("./features/settings/SettingsLegalRouteScreen", () =>
  stubs.stubModule("SettingsLegalRouteScreen"),
);
vi.mock("./features/settings/SettingsOpenSourceLicensesRouteScreen", () =>
  stubs.stubModule("SettingsOpenSourceLicenseRouteScreen", "SettingsOpenSourceLicensesRouteScreen"),
);
vi.mock("./features/settings/SettingsProjectGroupingRouteScreen", () =>
  stubs.stubModule("SettingsProjectGroupingRouteScreen"),
);
vi.mock("./features/settings/SettingsRouteScreen", () => stubs.stubModule("SettingsRouteScreen"));
vi.mock("./features/sharing/incoming-share-presentation", () =>
  stubs.stubModule(
    "EMPTY_INCOMING_SHARE_PRESENTATION_STATE",
    "transitionIncomingSharePresentation",
  ),
);
vi.mock("./features/sharing/IncomingShareProvider", () => stubs.stubModule("useIncomingShare"));
vi.mock("./features/shortcuts/useAppShortcuts", () => stubs.stubModule("useAppShortcuts"));
vi.mock("./features/showcase/ShowcaseCaptureCoordinator", () =>
  stubs.stubModule("ShowcaseCaptureCoordinator"),
);
vi.mock("./features/terminal/ThreadTerminalRouteScreen", () =>
  stubs.stubModule("ThreadTerminalRouteScreen"),
);
vi.mock("./features/threads/git/GitBranchesSheet", () => stubs.stubModule("GitBranchesSheet"));
vi.mock("./features/threads/git/GitCommitSheet", () => stubs.stubModule("GitCommitSheet"));
vi.mock("./features/threads/git/GitConfirmSheet", () => stubs.stubModule("GitConfirmSheet"));
vi.mock("./features/threads/git/GitOverviewSheet", () => stubs.stubModule("GitOverviewSheet"));
vi.mock("./features/threads/NewTaskContextPickerScreens", () =>
  stubs.stubModule("NewTaskBranchPickerRouteScreen", "NewTaskEnvironmentPickerRouteScreen"),
);
vi.mock("./features/threads/NewTaskDraftRouteScreen", () =>
  stubs.stubModule("NewTaskDraftRouteScreen"),
);
vi.mock("./features/threads/new-task-flow-provider", () => stubs.stubModule("NewTaskFlowProvider"));
vi.mock("./features/threads/NewTaskRouteScreen", () => stubs.stubModule("NewTaskRouteScreen"));
vi.mock("./features/threads/ThreadRouteScreen", () => stubs.stubModule("ThreadRouteScreen"));
vi.mock("./features/threads/ThreadSettingsSheet", () =>
  stubs.stubModule(
    "ExistingThreadSettingsRouteProvider",
    "ExistingThreadSettingsRouteScreen",
    "NewTaskThreadSettingsRouteScreen",
  ),
);
vi.mock("./features/usage/UsageLimitsPooled", () => stubs.stubModule("UsageLimitAccountScreen"));
vi.mock("./features/usage/UsageRouteScreen", () => stubs.stubModule("UsageRouteScreen"));
vi.mock("./state/composer-attachment-uploads", () =>
  stubs.stubModule("useComposerAttachmentUploadWorker"),
);
vi.mock("./state/use-thread-outbox-drain", () => stubs.stubModule("useThreadOutboxDrain"));

import { createPathConfigForStaticNavigation, getStateFromPath } from "@react-navigation/native";
import { RootStack } from "./Stack";

interface RouteState {
  readonly routes: ReadonlyArray<{
    readonly name: string;
    readonly params?: object;
    readonly state?: RouteState;
  }>;
  readonly index?: number;
}

const linkingConfig = {
  // App.tsx: `config: { initialRouteName: "Home" }`, merged over the static tree.
  initialRouteName: "Home",
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

/** The route names from the root to the focused leaf that a deep link opens. */
function openedRoute(url: string): { readonly names: string[]; readonly params: object | null } {
  // The linking container strips a registered prefix before resolving the path.
  const path = url.replace(/^t3code(-dev|-preview)?:\/\//, "");
  let state = getStateFromPath(path, linkingConfig) as RouteState | undefined;
  const names: string[] = [];
  let params: object | null = null;
  while (state !== undefined) {
    const route = state.routes[state.index ?? state.routes.length - 1];
    if (route === undefined) break;
    names.push(route.name);
    params = route.params ?? null;
    state = route.state;
  }
  return { names, params };
}

describe("criterion 3: the Hosts deep link", () => {
  it("deep link t3code-dev://settings/hosts opens the Hosts screen inside Settings", () => {
    expect(openedRoute("t3code-dev://settings/hosts").names).toEqual([
      "SettingsSheet",
      "SettingsContent",
      "SettingsHosts",
    ]);
  });
});

describe("guard: the deep links that exist keep their destinations", () => {
  it.each([
    ["t3code-dev://settings", ["SettingsSheet", "SettingsContent", "Settings"]],
    ["t3code-dev://settings/usage", ["SettingsSheet", "SettingsContent", "SettingsUsage"]],
    [
      "t3code-dev://settings/environments",
      ["SettingsSheet", "SettingsContent", "SettingsEnvironments"],
    ],
    [
      "t3code-dev://settings/diagnostics",
      ["SettingsSheet", "SettingsContent", "SettingsDiagnostics"],
    ],
    ["t3code-dev://settings/auth", ["SettingsSheet", "SettingsAuth"]],
    ["t3code-dev://settings/legal", ["SettingsLegal"]],
    ["t3code-dev://connections", ["Connections"]],
    ["t3code-dev://new/draft", ["NewTaskSheet", "NewTaskDraft"]],
    ["t3code-dev://threads/env-1/thread-1/terminal", ["ThreadTerminal"]],
    ["t3code-dev://no/such/route", ["NotFound"]],
  ])("stack linking guard: %s keeps its route", (url, names) => {
    expect(openedRoute(url).names).toEqual(names);
  });

  it("stack linking guard: a thread link carries its environment and thread", () => {
    const opened = openedRoute("t3code-dev://threads/env-1/thread-1");
    expect(opened.names).toEqual(["Thread"]);
    expect(opened.params).toEqual({ environmentId: "env-1", threadId: "thread-1" });
  });
});
