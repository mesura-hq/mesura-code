/**
 * Shared data and module mocks for the mobile agent-thread-search suites that
 * mount the application entry points through `agentThreadSearch.testMount.tsx`.
 *
 * Import this module first in each suite: its `vi.mock` calls register before
 * the application graph loads. The mocks replace the native and data
 * boundaries only — React Native host views become DOM elements, native header
 * chrome becomes recorded options, list rows become one button per thread, and
 * entities, connections, the lexical content search, the agent-search atom
 * family, and the RPC command boundary read the mutable `agentSearchFixture`.
 * Search state, mode switching, filtering, and navigation decisions stay real.
 *
 * It must not import application modules: the factories run while the
 * application graph is loading.
 */
import type {
  AgentThreadSearchInput,
  AgentThreadSearchMatch,
  AgentThreadSearchResult,
} from "@t3tools/client-runtime/state/agent-thread-search";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  createElement,
  useEffect,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { vi } from "vite-plus/test";

/* ─── Data ───────────────────────────────────────────────────────────── */

export const LAPTOP_ENVIRONMENT_ID = EnvironmentId.make("mobile-agent-search-laptop");
export const VIGILIA_ENVIRONMENT_ID = EnvironmentId.make("mobile-agent-search-vigilia");
export const LAPTOP_LABEL = "Arch laptop";
export const VIGILIA_LABEL = "Vigilia home";
export const MESURA_PROJECT_ID = ProjectId.make("mobile-agent-search-mesura");
export const HQ_PROJECT_ID = ProjectId.make("mobile-agent-search-hq");
export const MESURA_PROJECT_TITLE = "Mesura Code";
export const HQ_PROJECT_TITLE = "Mesura HQ";

const NOW = "2026-09-29T12:00:00.000Z";

function projectShell(
  environmentId: EnvironmentId,
  id: ProjectId,
  title: string,
): EnvironmentProject {
  return {
    id,
    environmentId,
    title,
    workspaceRoot: `/repos/${title.toLowerCase().replaceAll(" ", "-")}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  } as EnvironmentProject;
}

export function threadShell(input: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
}): EnvironmentThreadShell {
  const shell = {
    id: ThreadId.make(input.id),
    projectId: input.projectId,
    title: input.title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: input.updatedAt ?? NOW,
    updatedAt: input.updatedAt ?? NOW,
    archivedAt: input.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: input.updatedAt ?? NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as unknown as OrchestrationThreadShell;
  return { ...shell, environmentId: input.environmentId };
}

export const PANE_FOCUS_TITLE = "Pane focus design";
export const HOSTS_DOCK_TITLE = "Hosts dock layout";
export const ARCHIVED_UPLOAD_TITLE = "Large attachment uploads";

/** One active thread per environment, in different projects. */
export function defaultThreadShells(): EnvironmentThreadShell[] {
  return [
    threadShell({
      environmentId: LAPTOP_ENVIRONMENT_ID,
      id: "mobile-thread-pane-focus",
      projectId: MESURA_PROJECT_ID,
      title: PANE_FOCUS_TITLE,
      updatedAt: "2026-09-29T11:00:00.000Z",
    }),
    threadShell({
      environmentId: VIGILIA_ENVIRONMENT_ID,
      id: "mobile-thread-hosts-dock",
      projectId: HQ_PROJECT_ID,
      title: HOSTS_DOCK_TITLE,
      updatedAt: "2026-09-29T10:00:00.000Z",
    }),
  ];
}

/** The archived thread the agent search can return; it is absent from active shells. */
export function archivedUploadShell(archivedAt: string | null): EnvironmentThreadShell {
  return threadShell({
    environmentId: VIGILIA_ENVIRONMENT_ID,
    id: "mobile-thread-archived-upload",
    projectId: HQ_PROJECT_ID,
    title: ARCHIVED_UPLOAD_TITLE,
    updatedAt: "2026-09-20T10:00:00.000Z",
    archivedAt,
  });
}

export function agentMatch(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: string;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly reason: string;
  readonly archivedAt?: string | null;
}): AgentThreadSearchMatch {
  return {
    environmentId: input.environmentId,
    environmentLabel: input.environmentLabel,
    threadId: ThreadId.make(input.threadId),
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    threadTitle: input.threadTitle,
    archivedAt: input.archivedAt ?? null,
    reason: input.reason,
  };
}

export const FULL_COVERAGE = {
  unavailableEnvironments: [],
  budgetExhausted: false,
  unreadEvidence: false,
} as const;

export interface AgentSearchCall {
  readonly surface: string;
  readonly input: AgentThreadSearchInput;
  readonly deferred: Deferred.Deferred<AgentThreadSearchResult>;
  interrupted: boolean;
}

type CommandResult = AsyncResult.Success<unknown, unknown> | AsyncResult.Failure<unknown, unknown>;

/** The label `threadEnvironment.unarchive` dispatches under. */
export const UNARCHIVE_COMMAND_LABEL = "environment-data:commands:thread:unarchive";

export function commandSuccess(): CommandResult {
  return AsyncResult.success(undefined);
}

export function commandFailure(message: string): CommandResult {
  return AsyncResult.failure(Cause.fail(new Error(message)));
}

export interface RecordedAlert {
  readonly title: string;
  readonly message: string | undefined;
  readonly buttons: ReadonlyArray<{
    readonly text?: string;
    readonly style?: string;
    readonly onPress?: () => void;
  }>;
}

export interface WorkspaceFixtureEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  connectionState: "connected" | "connecting" | "reconnecting" | "disconnected" | "available";
}

export const agentSearchFixture = {
  platform: "android" as "android" | "ios",
  window: { width: 412, height: 915, scale: 2, fontScale: 1 },
  environments: [] as WorkspaceFixtureEnvironment[],
  projects: [] as EnvironmentProject[],
  threads: [] as EnvironmentThreadShell[],
  /** Content matches the lexical `useThreadSearch` returns for any query. */
  contentMatches: [] as EnvironmentThreadSearchMatch[],
  /** Archived shells `useArchivedThreadSnapshots` returns, per environment. */
  archivedThreads: [] as EnvironmentThreadShell[],
  agentCalls: [] as AgentSearchCall[],
  /** Every RPC command the application dispatched, in order. */
  commandCalls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  /** Per-command replies by command label; unlisted commands succeed. */
  commandReplies: new Map<string, (value: unknown) => Promise<CommandResult>>(),
  alerts: [] as RecordedAlert[],
  /** Every navigation request, normalized to `{ name, params }` where it names a route. */
  navigations: [] as Array<{
    readonly kind: string;
    readonly name?: string;
    readonly params?: unknown;
  }>,
  /** The last options each screen-options host applied, by render order. */
  screenOptions: [] as Array<Record<string, unknown>>,
  archivedRefreshes: [] as EnvironmentId[],
};

const fixtureListeners = new Set<() => void>();
let fixtureVersion = 0;

/** Re-renders every fixture reader, the way the shell stream and supervisor do. */
export function publishFixtureChange(): void {
  fixtureVersion += 1;
  for (const listener of fixtureListeners) listener();
}

function useFixtureVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      fixtureListeners.add(listener);
      return () => {
        fixtureListeners.delete(listener);
      };
    },
    () => fixtureVersion,
  );
}

/** Adds or replaces an active thread shell, as the shell stream's upsert does. */
export function deliverThreadShell(shell: EnvironmentThreadShell): void {
  agentSearchFixture.threads = [
    ...agentSearchFixture.threads.filter(
      (thread) => !(thread.environmentId === shell.environmentId && thread.id === shell.id),
    ),
    shell,
  ];
  publishFixtureChange();
}

export function setEnvironmentConnectionState(
  environmentId: EnvironmentId,
  connectionState: WorkspaceFixtureEnvironment["connectionState"],
): void {
  agentSearchFixture.environments = agentSearchFixture.environments.map((environment) =>
    environment.environmentId === environmentId ? { ...environment, connectionState } : environment,
  );
  publishFixtureChange();
}

export function resetAgentSearchFixture(): void {
  agentSearchFixture.platform = "android";
  agentSearchFixture.window = { width: 412, height: 915, scale: 2, fontScale: 1 };
  agentSearchFixture.environments = [
    { environmentId: LAPTOP_ENVIRONMENT_ID, label: LAPTOP_LABEL, connectionState: "connected" },
    { environmentId: VIGILIA_ENVIRONMENT_ID, label: VIGILIA_LABEL, connectionState: "connected" },
  ];
  agentSearchFixture.projects = [
    projectShell(LAPTOP_ENVIRONMENT_ID, MESURA_PROJECT_ID, MESURA_PROJECT_TITLE),
    projectShell(VIGILIA_ENVIRONMENT_ID, HQ_PROJECT_ID, HQ_PROJECT_TITLE),
  ];
  agentSearchFixture.threads = defaultThreadShells();
  agentSearchFixture.contentMatches = [];
  agentSearchFixture.archivedThreads = [];
  agentSearchFixture.agentCalls = [];
  agentSearchFixture.commandCalls = [];
  agentSearchFixture.commandReplies = new Map();
  agentSearchFixture.alerts = [];
  agentSearchFixture.navigations = [];
  agentSearchFixture.screenOptions = [];
  agentSearchFixture.archivedRefreshes = [];
  publishFixtureChange();
}

/* ─── React Native host views as DOM ─────────────────────────────────── */

type HostProps = {
  readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  readonly testID?: string;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly accessibilityHint?: string;
  readonly accessibilityState?: {
    readonly selected?: boolean;
    readonly checked?: boolean | "mixed";
    readonly disabled?: boolean;
    readonly expanded?: boolean;
    readonly busy?: boolean;
  };
  readonly accessible?: boolean;
  readonly role?: string;
  readonly "aria-label"?: string;
  readonly "aria-selected"?: boolean;
  readonly "aria-checked"?: boolean;
  readonly "aria-pressed"?: boolean;
  readonly style?: unknown;
  readonly hidden?: boolean;
  readonly [key: string]: unknown;
};

function renderChildren(children: HostProps["children"]): ReactNode {
  return typeof children === "function" ? children({ pressed: false }) : children;
}

function isHiddenStyle(style: unknown): boolean {
  const flat = Array.isArray(style) ? style.flat(Infinity) : [style];
  return flat.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { display?: unknown }).display === "none",
  );
}

function accessibilityAttributes(props: HostProps): Record<string, unknown> {
  const state = props.accessibilityState;
  return {
    "data-testid": props.testID,
    "aria-label": props["aria-label"] ?? props.accessibilityLabel,
    "aria-description": props.accessibilityHint,
    role: props.role ?? props.accessibilityRole,
    "aria-selected": props["aria-selected"] ?? state?.selected,
    "aria-checked": props["aria-checked"] ?? state?.checked,
    "aria-pressed": props["aria-pressed"],
    "aria-busy": state?.busy,
    "aria-expanded": state?.expanded,
    hidden: props.hidden || isHiddenStyle(props.style) ? true : undefined,
  };
}

function HostView(props: HostProps) {
  return createElement(
    "div",
    accessibilityAttributes(props),
    renderChildren(props.children) as ReactNode,
  );
}

function HostText(props: HostProps & { readonly onPress?: () => void }) {
  return createElement(
    "span",
    {
      ...accessibilityAttributes(props),
      onClick: props.onPress,
    },
    renderChildren(props.children) as ReactNode,
  );
}

function HostPressable(
  props: HostProps & {
    readonly onPress?: () => void;
    readonly onLongPress?: () => void;
    readonly disabled?: boolean | null;
  },
) {
  const disabled = props.disabled === true || props.accessibilityState?.disabled === true;
  return createElement(
    "button",
    {
      ...accessibilityAttributes(props),
      type: "button",
      disabled,
      onClick: disabled ? undefined : () => props.onPress?.(),
    },
    renderChildren(props.children) as ReactNode,
  );
}

interface HostTextInputHandle {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  isFocused: () => boolean;
}

// `ref` is taken apart from the other props: the React lint treats every read of
// an object that carries a ref as a ref read during render.
function HostTextInput({
  ref,
  ...props
}: HostProps & {
  readonly ref?: Ref<HostTextInputHandle>;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly editable?: boolean;
  readonly multiline?: boolean;
  readonly onChangeText?: (text: string) => void;
  readonly onSubmitEditing?: (event: { nativeEvent: { text: string } }) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
}) {
  // The host element lives in state, not a ref, so the handle closes over it.
  const [element, setElement] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useImperativeHandle(ref, () => ({
    focus: () => element?.focus(),
    blur: () => element?.blur(),
    clear: () => props.onChangeText?.(""),
    isFocused: () => element !== null && document.activeElement === element,
  }));
  return createElement(props.multiline ? "textarea" : "input", {
    ...accessibilityAttributes(props),
    ref: setElement,
    value: props.value ?? undefined,
    defaultValue: props.value === undefined ? props.defaultValue : undefined,
    placeholder: props.placeholder,
    disabled: props.editable === false,
    onChange: (event: { target: { value: string } }) => props.onChangeText?.(event.target.value),
    onFocus: props.onFocus,
    onBlur: props.onBlur,
    onKeyDown: (event: { key: string; target: { value: string } }) => {
      if (event.key === "Enter") {
        props.onSubmitEditing?.({ nativeEvent: { text: event.target.value } });
      }
    },
  });
}

function renderSlot(slot: unknown): ReactNode {
  if (slot === null || slot === undefined || slot === false) return null;
  if (typeof slot === "function") return createElement(slot as ComponentType);
  return slot as ReactNode;
}

type HostListProps = {
  readonly data?: ReadonlyArray<unknown> | null;
  readonly renderItem?: (info: { item: unknown; index: number }) => ReactNode;
  readonly keyExtractor?: (item: unknown, index: number) => string;
  readonly ListHeaderComponent?: unknown;
  readonly ListEmptyComponent?: unknown;
  readonly ListFooterComponent?: unknown;
  readonly testID?: string;
};

/** FlatList and LegendList render every row; virtualization is a native concern. */
function HostList(props: HostListProps) {
  const data = props.data ?? [];
  return createElement(
    "div",
    { "data-testid": props.testID, role: "list" },
    renderSlot(props.ListHeaderComponent),
    data.length === 0
      ? renderSlot(props.ListEmptyComponent)
      : data.map((item, index) =>
          createElement(
            "div",
            { key: props.keyExtractor?.(item, index) ?? String(index) },
            props.renderItem?.({ item, index }),
          ),
        ),
    renderSlot(props.ListFooterComponent),
  );
}

function HostModal(props: { readonly visible?: boolean; readonly children?: ReactNode }) {
  return props.visible === false ? null : createElement("div", { role: "dialog" }, props.children);
}

function Passthrough(props: { readonly children?: ReactNode }) {
  return createElement("div", null, props.children);
}

const subscription = { remove: () => undefined };

function reactNativeModule() {
  return {
    Platform: {
      get OS() {
        return agentSearchFixture.platform;
      },
      get Version() {
        return agentSearchFixture.platform === "ios" ? "26.0" : 36;
      },
      select: (options: Record<string, unknown>) =>
        agentSearchFixture.platform in options
          ? options[agentSearchFixture.platform]
          : (options.native ?? options.default),
    },
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten: (style: unknown) => style,
      compose: (a: unknown, b: unknown) => [a, b],
      hairlineWidth: 1,
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Alert: {
      alert: (title: string, message?: string, buttons?: RecordedAlert["buttons"]): void => {
        agentSearchFixture.alerts.push({ title, message, buttons: buttons ?? [] });
        publishFixtureChange();
      },
    },
    Keyboard: { dismiss: () => undefined, addListener: () => subscription },
    AppState: { currentState: "active", addEventListener: () => subscription },
    Linking: { openURL: vi.fn(), addEventListener: () => subscription },
    Dimensions: {
      get: () => agentSearchFixture.window,
      addEventListener: () => subscription,
    },
    PixelRatio: { get: () => 2, roundToNearestPixel: (value: number) => value },
    I18nManager: { isRTL: false },
    InteractionManager: {
      runAfterInteractions: (task?: () => void) => {
        task?.();
        return { cancel: () => undefined };
      },
    },
    LayoutAnimation: { configureNext: () => undefined, Presets: {} },
    BackHandler: { addEventListener: () => subscription },
    AccessibilityInfo: {
      announceForAccessibility: () => undefined,
      isReduceMotionEnabled: async () => false,
      addEventListener: () => subscription,
    },
    useWindowDimensions: () => agentSearchFixture.window,
    useColorScheme: () => "dark",
    View: HostView,
    SafeAreaView: HostView,
    KeyboardAvoidingView: HostView,
    ScrollView: HostView,
    Text: HostText,
    Pressable: HostPressable,
    TouchableOpacity: HostPressable,
    TouchableHighlight: HostPressable,
    TextInput: HostTextInput,
    FlatList: HostList,
    SectionList: HostList,
    VirtualizedList: HostList,
    Modal: HostModal,
    ActivityIndicator: () => createElement("span", { role: "progressbar" }),
    Image: () => null,
    Switch: HostPressable,
    RefreshControl: () => null,
    Animated: {
      View: HostView,
      Text: HostText,
      Value: class {
        constructor(public value: number) {}
        setValue(value: number) {
          this.value = value;
        }
        interpolate() {
          return this;
        }
      },
      timing: () => ({ start: (done?: () => void) => done?.() }),
      spring: () => ({ start: (done?: () => void) => done?.() }),
      createAnimatedComponent: <T,>(component: T) => component,
    },
  };
}

vi.mock("react-native", () => reactNativeModule());
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: Passthrough,
  SafeAreaView: HostView,
}));

function sharedValue<T>(initial: T) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(next: T) {
      value = next;
    },
    get: () => value,
    set: (next: T) => {
      value = next;
    },
  };
}

vi.mock("react-native-reanimated", () => {
  const Animated = {
    View: HostView,
    Text: HostText,
    ScrollView: HostView,
    createAnimatedComponent: <T,>(component: T) => component,
  };
  return {
    default: Animated,
    ...Animated,
    useSharedValue: sharedValue,
    useDerivedValue: (compute: () => unknown) => sharedValue(compute()),
    useAnimatedStyle: (compute: () => unknown) => compute(),
    useAnimatedProps: (compute: () => unknown) => compute(),
    useAnimatedReaction: () => undefined,
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => undefined,
    withTiming: <T,>(value: T) => value,
    withSpring: <T,>(value: T) => value,
    withDelay: <T,>(_delay: number, value: T) => value,
    withSequence: <T,>(...values: T[]) => values.at(-1),
    runOnJS:
      <A extends unknown[]>(callback: (...args: A) => unknown) =>
      (...args: A) =>
        callback(...args),
    runOnUI:
      <A extends unknown[]>(callback: (...args: A) => unknown) =>
      (...args: A) =>
        callback(...args),
    scheduleOnRN: <A extends unknown[]>(callback: (...args: A) => unknown, ...args: A) =>
      callback(...args),
    interpolate: () => 0,
    interpolateColor: () => "transparent",
    Easing: { bezier: () => () => 0, out: () => () => 0, inOut: () => () => 0, ease: () => 0 },
    Extrapolation: { CLAMP: "clamp" },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    LinearTransition: { duration: () => ({}) },
    Layout: {},
    ReduceMotion: { System: "system" },
    cancelAnimation: () => undefined,
  };
});

function gestureBuilder(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, key) => (key === "then" ? undefined : () => gestureBuilder()),
    },
  );
}

vi.mock("react-native-gesture-handler", () => ({
  Gesture: gestureBuilder(),
  GestureDetector: Passthrough,
  GestureHandlerRootView: Passthrough,
}));
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({ default: Passthrough }));

vi.mock("@legendapp/list/react-native", () => ({ LegendList: HostList }));

vi.mock("expo-haptics", () => ({
  impactAsync: async () => undefined,
  selectionAsync: async () => undefined,
  notificationAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Error: "error", Warning: "warning" },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { appVariant: "development" } } },
}));

vi.mock("@react-native-menu/menu", () => ({ MenuView: Passthrough }));

/* ─── Navigation ─────────────────────────────────────────────────────── */

function navigationAction(type: string, name?: string, params?: unknown) {
  return { type, payload: { name, params } };
}

function recordAction(action: unknown): void {
  const payload = (action as { type?: string; payload?: { name?: string; params?: unknown } })
    .payload;
  agentSearchFixture.navigations.push({
    kind: (action as { type?: string }).type ?? "action",
    ...(payload?.name === undefined ? {} : { name: payload.name }),
    ...(payload?.params === undefined ? {} : { params: payload.params }),
  });
}

const navigationState = { index: 0, routes: [{ key: "home-route", name: "Home" }] };

export const fixtureNavigation = {
  navigate: (name: unknown, params?: unknown) => {
    if (typeof name === "string") {
      agentSearchFixture.navigations.push({ kind: "NAVIGATE", name, params });
    } else {
      recordAction({ type: "NAVIGATE", payload: name });
    }
  },
  dispatch: (action: unknown) => {
    recordAction(typeof action === "function" ? action(navigationState) : action);
  },
  goBack: () => {
    agentSearchFixture.navigations.push({ kind: "GO_BACK" });
  },
  getState: () => navigationState,
  addListener: () => () => undefined,
  setOptions: () => undefined,
  isFocused: () => true,
  canGoBack: () => false,
};

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => fixtureNavigation,
  useRoute: () => ({ key: "home-route", name: "Home", params: undefined }),
  useIsFocused: () => true,
  useFocusEffect: (effect: () => void | (() => void)) => {
    // Focus effects run on mount, as a focused screen's do.
    useEffect(effect, [effect]);
  },
  useTheme: () => ({ colors: {}, dark: true }),
  NavigationContext: { Provider: Passthrough },
  NavigationRouteContext: { Provider: Passthrough },
  CommonActions: {
    navigate: (name: string, params?: unknown) => navigationAction("NAVIGATE", name, params),
    reset: (state: unknown) => ({ type: "RESET", payload: state }),
    setParams: (params: unknown) => ({ type: "SET_PARAMS", payload: { params } }),
  },
  StackActions: {
    push: (name: string, params?: unknown) => navigationAction("PUSH", name, params),
    replace: (name: string, params?: unknown) => navigationAction("REPLACE", name, params),
    pop: () => ({ type: "POP" }),
  },
}));

/* ─── Native chrome ──────────────────────────────────────────────────── */

function ScreenOptions(props: { readonly options?: Record<string, unknown> }) {
  if (props.options) agentSearchFixture.screenOptions.push(props.options);
  return null;
}

function ToolbarButton(props: {
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly children?: ReactNode;
}) {
  return createElement(
    "button",
    { type: "button", "aria-label": props.accessibilityLabel, onClick: props.onPress },
    props.children,
  );
}

function ToolbarRoot(props: { readonly children?: ReactNode }) {
  return createElement("div", { role: "toolbar" }, props.children);
}

vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: ScreenOptions,
  NativeHeaderToolbar: Object.assign(ToolbarRoot, {
    Button: ToolbarButton,
    Label: () => null,
    Menu: Object.assign(() => null, { Action: () => null }),
    MenuAction: () => null,
    SearchBarSlot: () => null,
    Spacer: () => null,
  }),
  nativeHeaderScrollEdgeEffects: () => ({}),
  nativeTopScrollEdgeEffect: () => ({}),
}));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: false,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET: 56,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../layout/native-glass-header-items", () => ({
  withNativeGlassHeaderItem: <T,>(item: T) => item,
}));
vi.mock("./sidebar-navigation-shell", () => ({ SidebarNavigationShell: Passthrough }));

vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({ AppText: HostText }));
vi.mock("../../components/MesuraWordmark", () => ({ MesuraWordmark: () => null }));
vi.mock("../../components/CompactBrandTitle", () => ({
  CompactBrandTitle: () => createElement("span", null, "Mesura Code"),
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: Passthrough,
  ControlPill: HostPressable,
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#888888" }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    materialYouStyleLayoutActive: false,
    themeVariables: new Proxy({}, { get: () => "#888888" }),
    isReady: true,
  }),
}));
vi.mock("../home/WorkspaceConnectionTitle", () => ({
  WorkspaceConnectionTitle: (props: { readonly brand?: ReactNode }) =>
    createElement("div", null, props.brand),
  getConnectionAwareBrandHeaderOptions: () => ({}),
}));
vi.mock("../updates/app-updates", () => ({
  checkForAppUpdateOnLaunch: async () => undefined,
  startAppUpdateForegroundRecheck: () => undefined,
}));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({
  useHardwareKeyboardCommand: () => undefined,
  parseActiveThreadPath: () => null,
}));
vi.mock("../keyboard/threadKeyboardShortcuts", () => ({ useThreadJumpShortcuts: () => undefined }));

/* ─── Thread rows ────────────────────────────────────────────────────── */

type RowProps = {
  readonly thread: EnvironmentThreadShell;
  readonly onSelectThread?: (thread: EnvironmentThreadShell) => void;
};

/** One button per thread row, named by its title; swipe and menu chrome are native. */
function ThreadRow(props: RowProps) {
  return createElement(
    "button",
    {
      type: "button",
      "data-testid": "thread-row",
      "data-thread-id": String(props.thread.id),
      "data-environment-id": String(props.thread.environmentId),
      onClick: () => props.onSelectThread?.(props.thread),
    },
    props.thread.title,
  );
}

vi.mock("./thread-list-items", () => ({
  THREAD_LIST_COMPACT_INSET: 16,
  ThreadListRow: ThreadRow,
  ThreadListGroupHeader: () => null,
  ThreadListShowMoreRow: () => null,
  PendingTaskListRow: () => null,
}));
vi.mock("./thread-list-v2-items", () => ({
  ThreadListV2Row: ThreadRow,
  ThreadListV2PendingRow: () => null,
  ThreadListV2SectionDivider: () => null,
  ThreadListV2SettledShelfHeader: () => null,
  ThreadListV2SnoozedShelfHeader: () => null,
}));
vi.mock("./sidebar-header-actions", () => ({ SidebarHeaderActions: () => null }));
vi.mock("./sidebar-filter-button", () => ({ SidebarFilterButton: () => null }));

/** Archived rows expose the swipe's primary action as a button. */
vi.mock("../home/thread-swipe-actions", () => ({
  SwipeableScrollGateProvider: Passthrough,
  useSwipeableScrollGate: () => ({ swipeEnabled: true, scrollGateHandlers: {} }),
  ThreadSwipeable: (props: {
    readonly children: () => ReactNode;
    readonly primaryAction?: { readonly accessibilityLabel: string; readonly onPress: () => void };
  }) =>
    createElement(
      "div",
      null,
      props.children(),
      props.primaryAction
        ? createElement(
            "button",
            {
              type: "button",
              "aria-label": props.primaryAction.accessibilityLabel,
              onClick: props.primaryAction.onPress,
            },
            props.primaryAction.accessibilityLabel,
          )
        : null,
    ),
}));

/* ─── Data sources ───────────────────────────────────────────────────── */

vi.mock("../../state/entities", () => ({
  useProjects: () => {
    useFixtureVersion();
    return agentSearchFixture.projects;
  },
  useThreadShells: () => {
    useFixtureVersion();
    return agentSearchFixture.threads;
  },
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) => {
    useFixtureVersion();
    return ref === null
      ? null
      : (agentSearchFixture.threads.find(
          (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
        ) ?? null);
  },
  useServerConfigs: () => new Map(),
  useEnvironmentServerConfig: () => null,
}));

function workspaceEnvironments() {
  return agentSearchFixture.environments.map((environment) => ({
    environmentId: environment.environmentId,
    environmentLabel: environment.label,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled: true,
    connectionState: environment.connectionState,
    connectionError: null,
    connectionErrorTraceId: null,
  }));
}

vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => {
    useFixtureVersion();
    const environments = workspaceEnvironments();
    const connected = environments.some(
      (environment) => environment.connectionState === "connected",
    );
    return {
      environments,
      state: {
        isLoadingConnections: false,
        hasConnections: environments.length > 0,
        hasLoadedShellSnapshot: true,
        hasPendingShellSnapshot: false,
        hasReadyEnvironment: connected,
        hasConnectingEnvironment: false,
        connectingEnvironments: [],
        connectionState: connected ? "connected" : "disconnected",
        connectionError: null,
        shellSnapshotError: null,
        latestCachedSnapshotReceivedAt: null,
        networkStatus: "online",
      },
    };
  },
}));

vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => {
    useFixtureVersion();
    return {
      savedConnectionsById: Object.fromEntries(
        agentSearchFixture.environments.map((environment) => [
          environment.environmentId,
          {
            environmentId: environment.environmentId,
            environmentLabel: environment.label,
            displayUrl: "",
          },
        ]),
      ),
    };
  },
  setPendingConnectionError: () => undefined,
}));

vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: (environmentId: string) => {
    useFixtureVersion();
    const environment = agentSearchFixture.environments.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    return {
      presentation:
        environment === undefined
          ? null
          : {
              environmentId,
              label: environment.label,
              connection: { phase: environment.connectionState, error: null },
            },
    };
  },
}));

vi.mock("../../state/queries", () => ({
  useDebouncedValue: <T,>(value: T) => value,
  useThreadSearch: (environmentIds: ReadonlyArray<string>, query: string) => {
    useFixtureVersion();
    return {
      matches:
        query.trim().length >= 2
          ? agentSearchFixture.contentMatches.filter((match) =>
              environmentIds.includes(match.environmentId),
            )
          : [],
      isPending: false,
    };
  },
}));

const preferencesAtom = Atom.make(AsyncResult.success({} as Record<string, unknown>));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: preferencesAtom,
  updateMobilePreferencesAtom: Atom.fn(() => Effect.void),
}));

vi.mock("../../state/use-pending-new-tasks", () => ({ usePendingNewTasks: () => [] }));
vi.mock("../../state/use-thread-outbox", () => ({
  useQueuedThreadKeys: () => new Set<string>(),
  queuedThreadKeysAtom: Atom.make(new Set<string>()),
  useThreadOutboxMessages: () => ({}),
}));
vi.mock("../../state/thread-order", () => ({
  usePendingThreadOrder: () => null,
  beginPendingThreadOrder: () => undefined,
  getPendingThreadOrder: () => null,
  threadDropBusyAtom: Atom.make(false),
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: Atom.make(new Map()),
}));
vi.mock("../home/usePendingTaskListActions", () => ({
  usePendingTaskListActions: () => ({
    openPendingTask: () => undefined,
    confirmDeletePendingTask: () => undefined,
  }),
}));
vi.mock("./use-thread-list-v2-shelf-preferences", () => ({
  useThreadListV2ShelfPreferences: () => ({
    settledShelfExpanded: false,
    snoozedShelfExpanded: false,
    setSettledShelfExpanded: () => undefined,
    setSnoozedShelfExpanded: () => undefined,
  }),
}));
vi.mock("../home/use-thread-sort-order-persistence", () => ({
  useThreadSortOrderPersistence: () => undefined,
}));

/** The shells stream and thread commands; the command objects carry their labels. */
vi.mock("../../state/threads", () => ({
  environmentThreadShells: Atom.make(new Map()),
  threadEnvironment: new Proxy(
    {},
    {
      get: (_target, key) => ({ label: `environment-data:commands:thread:${String(key)}` }),
    },
  ),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { readonly label?: string }) =>
    async (value: unknown): Promise<CommandResult> => {
      const label = command.label ?? "unlabelled-command";
      agentSearchFixture.commandCalls.push({ label, value });
      const reply = agentSearchFixture.commandReplies.get(label);
      return reply ? reply(value) : commandSuccess();
    },
}));

vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: (environmentId: EnvironmentId) => {
    agentSearchFixture.archivedRefreshes.push(environmentId);
  },
  useArchivedThreadSnapshots: (environmentIds: ReadonlyArray<EnvironmentId>) => {
    useFixtureVersion();
    return {
      snapshots: environmentIds.map((environmentId) => ({
        environmentId,
        snapshot: {
          snapshotSequence: 1,
          projects: agentSearchFixture.projects.filter(
            (project) => project.environmentId === environmentId,
          ),
          threads: agentSearchFixture.archivedThreads.filter(
            (thread) => thread.environmentId === environmentId,
          ),
          updatedAt: NOW,
        },
      })),
      error: null,
      isLoading: false,
      refresh: () => undefined,
    };
  },
}));
/**
 * The shared `orchestrationEnvironment.agentThreadSearch` family with the same
 * shape and cancellation semantics as the real one — an `Atom.fn` per surface
 * key, whose fiber is interrupted by a new write, `Atom.Reset`, or disposal —
 * but whose result each test settles by hand.
 */
const agentThreadSearch = Atom.family((surface: string) =>
  Atom.fn((input: AgentThreadSearchInput) =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<AgentThreadSearchResult>();
      const call: AgentSearchCall = { surface, input, deferred, interrupted: false };
      agentSearchFixture.agentCalls.push(call);
      return yield* Deferred.await(deferred).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            call.interrupted = true;
          }),
        ),
      );
    }),
  ),
);

vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    agentThreadSearch,
    archivedShellSnapshot: Atom.family(() => Atom.make(null)),
  },
}));
