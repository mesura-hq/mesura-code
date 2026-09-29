// @vitest-environment happy-dom
// Entry point: FactoryRouteScreen, the screen `Stack.tsx` registers as the
// `ThreadFactory` route, mounted with its route params and the real plan
// document, segmented control and MermaidWebView under it. Stubbed: native
// hosts (DOM elements), the thread selection, the stored plan body
// (`factoryEnvironment.factorySnapshot`), the run stream
// (`factoryEnvironment.factoryRun`), the screen's focus as React Navigation
// reports it, and the WebView host.
//
// Only the Android emulator can show: the WebView actually drawing the diagram
// with Mermaid from the network, the drawn height matching the measurement,
// the offline page failing and reporting it, and Back from this screen
// restoring the thread feed's scroll position.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  routeParams: {} as Record<string, string | undefined>,
  activities: [] as import("@t3tools/contracts").OrchestrationThreadActivity[],
  factorySnapshots: {} as Record<string, string>,
  factorySnapshotAtoms: new Map<string, unknown>(),
  /** A query result to serve as is, such as a failure that keeps its previous success. */
  factorySnapshotResults: {} as Record<string, unknown>,
  webViews: [] as Array<Record<string, unknown>>,
  navigation: { navigate: vi.fn(), goBack: vi.fn(), setOptions: vi.fn() },
  /** Whether React Navigation reports the screen focused; `setFocused` notifies. */
  focused: true,
  focusListeners: new Set<() => void>(),
  /** The `subscribeFactoryRun` stream per run id: the atom a test writes new items to. */
  runStreams: new Map<string, unknown>(),
  runStreamViews: new Map<string, unknown>(),
  runRequests: [] as Array<{ environmentId: string; input: { threadId: string; runId: string } }>,
  /** Run streams mounted right now: a subscription the server is tailing for. */
  runSubscriptions: 0,
  /** The stream atom of a run, created kept alive so a test can write to it before a read. */
  runStream: null as null | ((runId: string) => unknown),
}));

type NativeStyle = { height?: number; display?: string } | ReadonlyArray<unknown> | undefined;
function flattenStyle(style: NativeStyle): { height?: number; display?: string } {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((entry) => flattenStyle(entry as NativeStyle)));
  }
  return (style as { height?: number; display?: string } | undefined) ?? {};
}

vi.mock("react-native", () => {
  const View = ({
    children,
    style,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: NativeStyle;
    accessibilityLabel?: string;
  }) => {
    const flat = flattenStyle(style);
    return (
      <div
        data-height={flat.height}
        hidden={flat.display === "none"}
        aria-label={accessibilityLabel}
      >
        {children}
      </div>
    );
  };
  const Text = ({ children }: { children?: ReactNode }) => <span>{children}</span>;
  return {
    Platform: { OS: "android", select: (values: Record<string, unknown>) => values.android },
    View,
    Text,
    TextInput: () => null,
    Pressable: ({
      children,
      disabled,
      onPress,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
    }: {
      children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
      disabled?: boolean;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean; expanded?: boolean };
    }) => (
      <button
        disabled={disabled === true || accessibilityState?.disabled === true}
        onClick={onPress}
        aria-label={accessibilityLabel}
        aria-selected={accessibilityState?.selected}
        aria-expanded={accessibilityState?.expanded}
        data-native-role={accessibilityRole}
      >
        {typeof children === "function" ? children({ pressed: false }) : children}
      </button>
    ),
    ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Image: () => null,
    ActivityIndicator: () => null,
    StyleSheet: {
      create: (styles: unknown) => styles,
      absoluteFill: {},
      hairlineWidth: 1,
      flatten: (style: unknown) => style,
    },
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove: () => undefined }),
    },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
    useWindowDimensions: () => ({ height: 800, width: 390, fontScale: 1, scale: 1 }),
    useColorScheme: () => "dark",
  };
});
vi.mock("react-native-webview", () => {
  const WebView = (props: Record<string, unknown> & { style?: NativeStyle }) => {
    fixture.webViews.push(props);
    return <div data-webview="true" data-height={flattenStyle(props.style).height} />;
  };
  return { default: WebView, WebView };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  Easing: {
    out: () => (value: number) => value,
    inOut: () => (value: number) => value,
    cubic: (value: number) => value,
    quad: (value: number) => value,
  },
  FadeIn: { duration: () => ({}), delay: () => ({ duration: () => ({}) }) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: {
    duration: () => ({ easing: () => ({ reduceMotion: () => ({}) }), reduceMotion: () => ({}) }),
  },
  ReduceMotion: { System: "system" },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value, set: () => undefined }),
  withTiming: (value: unknown) => value,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
// Focus as React Navigation reports it: `useIsFocused` re-renders on a change,
// `useFocusEffect` runs its effect on focus and its cleanup on blur.
vi.mock("@react-navigation/native", async () => {
  const React = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.focusListeners.add(listener);
    return () => fixture.focusListeners.delete(listener);
  };
  const useIsFocused = () => React.useSyncExternalStore(subscribe, () => fixture.focused);
  return {
    useNavigation: () => fixture.navigation,
    useRoute: () => ({ key: "factory", name: "ThreadFactory", params: fixture.routeParams }),
    useIsFocused,
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = useIsFocused();
      React.useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
  };
});
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext(0),
  useHeaderHeight: () => 0,
}));
vi.mock("expo-haptics", () => ({
  impactAsync: () => undefined,
  selectionAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("react-native-nitro-markdown", () => ({
  Markdown: ({ markdown, children }: { markdown?: string; children?: ReactNode }) => (
    <span>{markdown ?? children}</span>
  ),
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#333333" }),
}));
vi.mock("../../lib/useFontFamily", () => ({ useFontFamily: () => "sans-serif" }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  hasNativeSelectableMarkdownText: () => false,
  SelectableMarkdownText: () => null,
}));
vi.mock("../../components/AppText", async () => ({
  AppText: (await import("react-native")).Text,
  AppTextInput: (await import("react-native")).TextInput,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/NativePresentation", () => ({
  PresentationSource: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 14 }, themeAppearance: "dark" }),
}));
vi.mock("../threads/useFileChipShare", () => ({ useFileChipShare: () => vi.fn() }));
vi.mock("../threads/markdownCodeHighlightState", () => ({ useMarkdownCodeHighlight: () => null }));
vi.mock("../threads/ThreadMarkdownImage", async () => ({
  MarkdownImageAvailableWidthContext: (await import("react")).createContext(0),
  ThreadMarkdownImage: () => null,
  ThreadMarkdownImageUnavailable: () => null,
  ThreadMarkdownImageView: () => null,
}));
vi.mock("../../state/assets", () => ({
  useAssetUrl: () => null,
  useAssetUrlState: () => ({}),
  useRefreshAssetUrl: () => vi.fn(),
  assetEnvironment: {},
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../components/CopyTextButton", () => ({ CopyTextButton: () => null }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../layout/workspace-content-width", () => ({ useWorkspaceContentWidth: () => null }));
vi.mock("../../state/use-thread-selection", async () => {
  const Option = await import("effect/Option");
  return {
    useThreadSelection: () => ({
      selectedThread: {
        environmentId: fixture.routeParams.environmentId,
        id: fixture.routeParams.threadId,
        title: "Factory thread",
      },
      selectedThreadProject: null,
      selectedThreadDetailState: {
        data: Option.some({ activities: fixture.activities }),
      },
    }),
  };
});
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadDetail: () => ({ activities: fixture.activities }),
  useThreadDetail: () => ({ activities: fixture.activities }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/home/dev/repo" }),
}));
// The plan body a `factory.plan` activity names by digest, as the server's
// factoryReadSnapshot RPC would answer it; an unknown digest stays loading.
vi.mock("../../state/factory", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  fixture.runStream = (runId) => {
    let stream = fixture.runStreams.get(runId);
    if (stream === undefined) {
      stream = Atom.keepAlive(Atom.make(AsyncResult.initial(true)));
      fixture.runStreams.set(runId, stream);
    }
    return stream;
  };
  return {
    factoryEnvironment: {
      factorySnapshot: ({ input }: { input: { digest: string } }) => {
        const served = fixture.factorySnapshotResults[input.digest];
        if (served !== undefined) {
          let atom = fixture.factorySnapshotAtoms.get(`${input.digest}:served`);
          if (atom === undefined) {
            atom = Atom.make(served);
            fixture.factorySnapshotAtoms.set(`${input.digest}:served`, atom);
          }
          return atom;
        }
        const markdown = fixture.factorySnapshots[input.digest];
        const key = `${input.digest}:${markdown === undefined ? "loading" : "ready"}`;
        let atom = fixture.factorySnapshotAtoms.get(key);
        if (atom === undefined) {
          atom = Atom.make(
            markdown === undefined
              ? AsyncResult.initial(true)
              : AsyncResult.success({ digest: input.digest, markdown }),
          );
          fixture.factorySnapshotAtoms.set(key, atom);
        }
        return atom;
      },
      // One stream per run, as `subscribeFactoryRun` answers it. The atom the
      // screen reads counts itself mounted until the registry disposes it.
      factoryRun: (request: {
        environmentId: string;
        input: { threadId: string; runId: string };
      }) => {
        fixture.runRequests.push(request);
        const { runId } = request.input;
        const stream = fixture.runStream!(runId);
        let view = fixture.runStreamViews.get(runId);
        if (view === undefined) {
          const source = stream as Atom.Atom<unknown>;
          view = Atom.make((get) => {
            fixture.runSubscriptions += 1;
            get.addFinalizer(() => {
              fixture.runSubscriptions -= 1;
            });
            return get(source);
          });
          fixture.runStreamViews.set(runId, view);
        }
        return view;
      },
    },
  };
});

import { RegistryContext } from "@effect/atom-react";
import { readFactoryPhases, splitFactoryDocument } from "@t3tools/shared/factoryDocument";

import { appAtomRegistry } from "../../state/atom-registry";
import { FactoryRouteScreen } from "./FactoryRouteScreen";
import {
  FACTORY_OTHER_PLAN_DIGEST,
  FACTORY_PLAN_DIGEST,
  makeFactoryPlanActivity,
  makeFactoryPlanPayload,
  readFactoryPlanFixture,
} from "./factoryPlan.test-support";

const environmentId = "factory-screen-environment";
const threadId = "factory-screen-thread";
const planId = "factory-plan:plan-md";
const MERMAID_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.min.js";
const planMarkdown = readFactoryPlanFixture();
const planSections = splitFactoryDocument(planMarkdown).sections;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.routeParams = { environmentId, threadId, planId };
  fixture.activities = [
    makeFactoryPlanActivity({ id: planId, createdAt: "2026-09-28T10:00:05.000Z" }),
  ];
  fixture.factorySnapshots = { [FACTORY_PLAN_DIGEST]: planMarkdown };
  fixture.factorySnapshotAtoms.clear();
  fixture.factorySnapshotResults = {};
  fixture.webViews = [];
  fixture.focused = true;
  fixture.focusListeners.clear();
  fixture.runStreams.clear();
  fixture.runStreamViews.clear();
  fixture.runRequests = [];
  fixture.runSubscriptions = 0;
  for (const method of Object.values(fixture.navigation)) method.mockClear();
  appAtomRegistry.reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount() {
  const route = { key: "factory", name: "ThreadFactory", params: fixture.routeParams };
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <FactoryRouteScreen
          {...({ route } as unknown as Parameters<typeof FactoryRouteScreen>[0])}
        />
      </RegistryContext.Provider>,
    ),
  );
}

/** Text a reader sees: folded content that is mounted but hidden does not count. */
function visibleText(): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const hidden of Array.from(clone.querySelectorAll("[hidden]"))) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ");
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
}
function buttonsLabelled(label: string): HTMLButtonElement[] {
  return buttons().filter(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
}
async function press(node: HTMLElement) {
  await act(async () => node.click());
}

/** First element whose whole text is exactly `text`, in document order. */
function elementWithText(text: string): Element | undefined {
  return Array.from(container.querySelectorAll("*")).find(
    (node) => node.textContent?.replace(/\s+/g, " ").trim() === text,
  );
}

function latestWebView() {
  const props = fixture.webViews.at(-1);
  expect(props, "Expected the Architecture diagram's WebView").toBeDefined();
  return props as {
    source: { html: string; baseUrl?: string };
    onMessage?: (event: { nativeEvent: { data: string } }) => void;
  };
}
async function postFromPage(message: unknown) {
  const { onMessage } = latestWebView();
  expect(onMessage, "Expected the WebView to listen to its page").toBeTypeOf("function");
  await act(async () => onMessage!({ nativeEvent: { data: JSON.stringify(message) } }));
}

function planWithDiagram(diagram: string): string {
  return [
    "# Plan: a hostile diagram",
    "",
    "## Context",
    "",
    "A plan whose diagram carries markup.",
    "",
    "## Architecture",
    "",
    "```mermaid",
    diagram,
    "```",
    "",
    "The reading paragraph.",
    "",
  ].join("\n");
}

// Criterion 2: every section in order, the section count.
it("Factory screen shows every plan section in document order with the section count", async () => {
  await mount();
  const text = visibleText();
  expect(text).toContain("Plan: the Software Factory inside Mesura Code");
  expect(text).toContain(`${planSections.length} sections`);

  const headings = planSections.map((section) => section.heading);
  const headingElements = headings.map((heading) => {
    const element = elementWithText(heading);
    expect(element, `Expected the section heading "${heading}"`).toBeDefined();
    return element!;
  });
  const inDocumentOrder = headingElements
    .map((element, index) => ({ element, heading: headings[index]! }))
    .sort((left, right) =>
      left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    )
    .map((entry) => entry.heading);
  expect(inDocumentOrder).toEqual(headings);
  // An unfolded section shows its body.
  expect(text).toContain("The planning skill writes three files");
});

// Criterion 2: phase cards with numbered acceptance criteria and folded detail.
it("Factory screen draws each phase as a card with numbered acceptance criteria and its detail folded", async () => {
  const phasesResult = readFactoryPhases(planSections);
  expect(phasesResult.ok).toBe(true);
  const phases = phasesResult.ok ? phasesResult.phases : [];
  await mount();

  for (const phase of phases) expect(visibleText()).toContain(phase.title);

  const firstPhase = phases[0]!;
  firstPhase.acceptance.forEach((criterion, index) => {
    const numbered = Array.from(container.querySelectorAll("*")).find((node) => {
      const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return (
        new RegExp(`^${index + 1}\\.\\s?`).test(text) &&
        text.includes(criterion.slice(0, 40)) &&
        !text.includes(firstPhase.acceptance[index + 1]?.slice(0, 40) ?? "\u0000")
      );
    });
    expect(numbered, `Expected criterion ${index + 1} numbered on its own row`).toBeDefined();
  });

  const detailSnippet = (phase: (typeof phases)[number]) =>
    phase
      .detail!.split("\n")
      .find((line) => line.trim().length > 30)!
      .trim()
      .slice(0, 40);
  for (const phase of phases) {
    expect(phase.detail, `Fixture phase "${phase.title}" has detail`).toBeDefined();
    expect(visibleText()).not.toContain(detailSnippet(phase));
  }
  const detailFolds = buttonsLabelled("How, in detail");
  expect(detailFolds).toHaveLength(phases.length);
  await press(detailFolds[0]!);
  expect(visibleText()).toContain(detailSnippet(firstPhase));
  expect(visibleText()).not.toContain(detailSnippet(phases[1]!));
});

// Criterion 2: long settled sections and decision arguments fold like the web pane.
it("Factory screen folds the agreed design and each decision's argument until opened", async () => {
  await mount();
  const designSnippet = "The shape that won: the run directory is the source of truth";
  const argumentSnippet = "The coordinator used to edit `ledger.md` by hand.";
  expect(visibleText()).not.toContain(designSnippet);
  expect(visibleText()).not.toContain(argumentSnippet);
  expect(visibleText()).toContain(
    "The events file is the run's only record, and `ledger.md` is generated from it.",
  );

  const designFold = buttonsLabelled("The design we agreed");
  expect(designFold).toHaveLength(1);
  await press(designFold[0]!);
  expect(visibleText()).toContain(designSnippet);

  const whyFolds = buttonsLabelled("Why");
  expect(whyFolds.length).toBeGreaterThan(0);
  await press(whyFolds[0]!);
  expect(visibleText()).toContain(argumentSnippet);
});

// Criterion 2: the screen is for one thread's plan; the param picks it, else the latest.
it("Factory screen shows the named plan, and the thread's latest plan when none is named", async () => {
  const olderPlanId = "factory-plan:older-md";
  fixture.activities = [
    makeFactoryPlanActivity({
      id: olderPlanId,
      createdAt: "2026-09-28T09:00:00.000Z",
      payload: makeFactoryPlanPayload({
        digest: FACTORY_OTHER_PLAN_DIGEST,
        planPath: "/home/dev/plans/older/plan.md",
        title: "Plan: an older file",
      }),
    }),
    makeFactoryPlanActivity({ id: planId, createdAt: "2026-09-28T10:00:05.000Z" }),
  ];
  fixture.factorySnapshots[FACTORY_OTHER_PLAN_DIGEST] =
    "# Plan: an older file\n\n## Context\n\nThe older plan's context.\n";

  fixture.routeParams = { environmentId, threadId };
  await mount();
  expect(visibleText()).toContain("Plan: the Software Factory inside Mesura Code");
  expect(visibleText()).not.toContain("The older plan's context.");

  await act(async () => root.unmount());
  root = createRoot(container);
  fixture.routeParams = { environmentId, threadId, planId: olderPlanId };
  await mount();
  expect(visibleText()).toContain("The older plan's context.");
  expect(visibleText()).not.toContain("Plan: the Software Factory inside Mesura Code");
});

// Criterion 2: Plan, Run and Report; only Plan does anything in this phase.
it("Factory screen offers Plan, Run and Report tabs and stays on the plan when another is pressed", async () => {
  await mount();
  const tabs = buttons().filter((node) => node.dataset.nativeRole === "tab");
  expect(tabs.map((node) => node.textContent?.trim())).toEqual(["Plan", "Run", "Report"]);
  expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");

  for (const tab of tabs.slice(1)) {
    await press(tab);
    expect(visibleText()).toContain(`${planSections.length} sections`);
    const planTab = buttons().find((node) => node.dataset.nativeRole === "tab");
    expect(planTab!.getAttribute("aria-selected")).toBe("true");
  }
});

// Criterion 3: the Architecture diagram in a WebView with the pinned Mermaid.
it("Factory diagram hands the Architecture source to a WebView page that loads Mermaid 11.12.0", async () => {
  await mount();
  const webView = latestWebView();
  expect(typeof webView.source.baseUrl).toBe("string");
  const page = new DOMParser().parseFromString(webView.source.html, "text/html");
  const scriptSources = Array.from(page.querySelectorAll("script"))
    .map((script) => script.getAttribute("src"))
    .filter((src): src is string => src !== null);
  expect(scriptSources).toEqual([MERMAID_SCRIPT_URL]);
  expect(webView.source.html).toContain("flowchart LR");
  expect(webView.source.html).toContain("subgraph Skills");
  expect(webView.source.html).toContain("window.ReactNativeWebView.postMessage");
});

// Criterion 3: the source travels as data, never as markup of the page.
it("Factory diagram keeps a diagram source that contains markup as data inside the page", async () => {
  fixture.factorySnapshots[FACTORY_PLAN_DIGEST] = planWithDiagram(
    'flowchart LR\n  A["</script><img src=x onerror=alert(1)>"] --> B',
  );
  await mount();
  const { html } = latestWebView().source;
  expect(html).not.toContain("</script><img");
  const page = new DOMParser().parseFromString(html, "text/html");
  expect(page.querySelectorAll("img")).toHaveLength(0);
  const scriptSources = Array.from(page.querySelectorAll("script"))
    .map((script) => script.getAttribute("src"))
    .filter((src): src is string => src !== null);
  expect(scriptSources).toEqual([MERMAID_SCRIPT_URL]);
});

// Criterion 3: the page measures the drawn diagram; the view takes that height.
it("Factory diagram takes its natural height from the height the page reports", async () => {
  await mount();
  expect(container.querySelector('[data-height="437"]')).toBeNull();
  await postFromPage({ type: "height", height: 437 });
  const sized = container.querySelector('[data-height="437"]');
  expect(sized, "Expected the diagram view sized to the reported height").not.toBeNull();
  const holdsWebView =
    sized!.matches('[data-webview="true"]') || sized!.querySelector('[data-webview="true"]');
  expect(holdsWebView, "Expected the sized view to be or hold the WebView").toBeTruthy();
});

// Criterion 3: offline, the page cannot load Mermaid; the screen shows the source and why.
it("Factory diagram without network shows its source and says diagrams need a network connection", async () => {
  await mount();
  expect(visibleText()).not.toContain("Diagrams need a network connection");
  await postFromPage({ type: "error", message: "Mermaid failed to load" });
  const text = visibleText();
  expect(text).toContain("Diagrams need a network connection");
  expect(text).toContain("flowchart LR");
  expect(text).toContain("SP[sf-plan]:::changed");
});

// Review P2-1: Run and Report show, but cannot be chosen until their views exist.
it("Factory screen disables the Run and Report tabs until their views exist", async () => {
  await mount();
  const tabs = buttons().filter((node) => node.dataset.nativeRole === "tab");
  expect(tabs.map((node) => [node.textContent?.trim(), node.disabled])).toEqual([
    ["Plan", false],
    ["Run", true],
    ["Report", true],
  ]);
});

// Review P2-2: a failed load is not the end of the screen visit.
it("Factory diagram draws again after Try again following a network failure", async () => {
  await mount();
  await postFromPage({ type: "error" });
  expect(visibleText()).toContain("Diagrams need a network connection");
  const mountedBefore = fixture.webViews.length;

  const retry = buttonsLabelled("Try again");
  expect(retry).toHaveLength(1);
  await press(retry[0]!);
  expect(visibleText()).not.toContain("Diagrams need a network connection");
  expect(container.querySelector('[data-webview="true"]')).not.toBeNull();
  expect(fixture.webViews.length).toBeGreaterThan(mountedBefore);

  await postFromPage({ type: "height", height: 512 });
  expect(container.querySelector('[data-height="512"]')).not.toBeNull();
});

// Review P2-2: a revised plan draws its new diagram instead of keeping the old failure.
it("Factory diagram starts a fresh page when the plan's diagram is revised after a failure", async () => {
  await mount();
  await postFromPage({ type: "error" });
  expect(visibleText()).toContain("Diagrams need a network connection");

  fixture.factorySnapshots[FACTORY_OTHER_PLAN_DIGEST] = planWithDiagram(
    "flowchart TD\n  Revised --> Diagram",
  );
  fixture.activities = [
    makeFactoryPlanActivity({
      id: planId,
      createdAt: "2026-09-28T11:00:00.000Z",
      payload: makeFactoryPlanPayload({ digest: FACTORY_OTHER_PLAN_DIGEST }),
    }),
  ];
  await mount();
  expect(visibleText()).not.toContain("Diagrams need a network connection");
  // `>` reaches the page escaped, as data; the node names arrive as written.
  expect(latestWebView().source.html).toContain("flowchart TD");
  expect(latestWebView().source.html).toContain("Revised");
});

// Repair of criterion 3, offline: the device drops its network after the plan
// was read. The connection supervisor reports the environment `offline`, so
// the snapshot query fails, keeping its previous success; the CDN is out of
// reach too. Only the emulator shows the real network drop and the CDN load.
it("Factory screen keeps an already loaded plan offline and shows the diagram's source with Try again", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  const Cause = await import("effect/Cause");
  const Option = await import("effect/Option");
  const loaded = AsyncResult.success({ digest: FACTORY_PLAN_DIGEST, markdown: planMarkdown });
  fixture.factorySnapshotResults[FACTORY_PLAN_DIGEST] = AsyncResult.failureWithPrevious(
    Cause.fail(new Error("Environment factory-screen-environment is offline.")),
    { previous: Option.some(loaded) },
  );
  await mount();
  expect(visibleText()).not.toContain("The plan's text could not be loaded.");
  expect(visibleText()).toContain(`${planSections.length} sections`);

  await postFromPage({ type: "error", message: "Mermaid did not load" });
  expect(visibleText()).toContain("Diagrams need a network connection");
  expect(visibleText()).toContain("flowchart LR");
  expect(buttonsLabelled("Try again")).toHaveLength(1);
});

it("Factory screen says the plan's text could not be loaded when it was never read before the network dropped", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  const Cause = await import("effect/Cause");
  fixture.factorySnapshotResults[FACTORY_PLAN_DIGEST] = AsyncResult.failure(
    Cause.fail(new Error("Environment factory-screen-environment is offline.")),
  );
  await mount();
  expect(visibleText()).toContain("The plan's text could not be loaded.");
});

// The Run tab (phase 10 of factory-in-chat): criteria 1, 2, 3 and 5 on
// Android, through the same route screen. The run stream answers with the
// state the server's run tracker folds from the recorder's fixture
// (`packages/shared/src/fixtures/factory-events.v1.jsonl`). Only the emulator
// shows the layout on a narrow screen, the tones' colours, and the server
// actually ending its tail when the subscription ends.
import type { FactoryRoleProgress } from "@t3tools/contracts";
import {
  foldFactoryRunTestLines,
  makeFactoryRunState,
} from "@t3tools/client-runtime/factory/testing";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";

import {
  makeFactoryRunActivityAt,
  readFactoryRunEventsFixture,
  type FactoryRunFixturePoint,
} from "./factoryRun.test-support";

const runId = "invoice-csv-export";
const runEvents = readFactoryRunEventsFixture();
const runEventLines = runEvents.split("\n").filter((line) => line.trim().length > 0);
const RUN_PHASE_1 = "Serialize the filtered invoice list as CSV";
const RUN_PHASE_2 = "Add the Export button to the invoices page";

/** The thread holds its plan and the run's `factory.run` activity at `point`. */
function showRunAt(point: FactoryRunFixturePoint) {
  fixture.activities = [
    makeFactoryPlanActivity({ id: planId, createdAt: "2026-09-28T10:00:05.000Z" }),
    makeFactoryRunActivityAt({ threadId, point }),
  ];
}

/** The next item of the run's stream, as `subscribeFactoryRun` delivers it. */
async function streamRun(
  state: import("@t3tools/contracts").FactoryRunState,
  roles: ReadonlyArray<FactoryRoleProgress> = [],
) {
  const stream = fixture.runStream!(runId) as Atom.Writable<unknown>;
  await act(async () => appAtomRegistry.set(stream, AsyncResult.success({ state, roles })));
}
const streamRunAt = (point: FactoryRunFixturePoint) =>
  streamRun(makeFactoryRunState(runEvents, point));

async function openRunTab(point: FactoryRunFixturePoint) {
  showRunAt(point);
  fixture.routeParams = { environmentId, threadId, tab: "run", runId };
  await streamRunAt(point);
  await mount();
}

/** React Navigation focusing or blurring the screen; disposal settles after it. */
async function setFocused(focused: boolean) {
  await act(async () => {
    fixture.focused = focused;
    for (const listener of fixture.focusListeners) listener();
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Accessibility labels a reader can reach: folded content does not count. */
function visibleLabels(): string[] {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const hidden of Array.from(clone.querySelectorAll("[hidden]"))) hidden.remove();
  return Array.from(clone.querySelectorAll("[aria-label]")).map(
    (node) => node.getAttribute("aria-label") ?? "",
  );
}

function phaseHeaders(): HTMLButtonElement[] {
  return buttons().filter((node) => /^Phase \d+: /.test(node.getAttribute("aria-label") ?? ""));
}
function phaseHeader(index: number): HTMLButtonElement {
  const header = phaseHeaders().find((node) =>
    node.getAttribute("aria-label")?.startsWith(`Phase ${index}: `),
  );
  expect(header, `Expected phase ${index}'s header; screen: ${visibleText()}`).toBeDefined();
  return header!;
}

it("phase10 android AC1 Factory screen enables the Run tab when the thread has a run and keeps Report disabled", async () => {
  showRunAt("verify");
  await mount();
  const tabs = buttons().filter((node) => node.dataset.nativeRole === "tab");
  expect(tabs.map((node) => [node.textContent?.trim(), node.disabled])).toEqual([
    ["Plan", false],
    ["Run", false],
    ["Report", true],
  ]);
  expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  expect(fixture.runSubscriptions).toBe(0);

  await streamRunAt("verify");
  await press(tabs[1]!);
  expect(
    buttons()
      .find((node) => node.dataset.nativeRole === "tab" && node.textContent?.trim() === "Run")!
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(phaseHeaders()).toHaveLength(2);
});

it("phase10 android AC1 Factory screen opened on the Run tab lists the run's phases in order with their state", async () => {
  await openRunTab("verify");
  const runTab = buttons().find(
    (node) => node.dataset.nativeRole === "tab" && node.textContent?.trim() === "Run",
  );
  expect(runTab?.getAttribute("aria-selected")).toBe("true");
  expect(visibleText()).not.toContain(`${planSections.length} sections`);

  expect(phaseHeaders().map((node) => node.getAttribute("aria-label"))).toEqual([
    `Phase 1: running — ${RUN_PHASE_1}`,
    `Phase 2: pending — ${RUN_PHASE_2}`,
  ]);
  expect(fixture.runRequests.length).toBeGreaterThan(0);
  for (const request of fixture.runRequests) {
    expect(request).toEqual({ environmentId, input: { threadId, runId } });
  }
});

it("phase10 android AC1 Factory screen Run tab follows the thread's latest run when the route names none", async () => {
  showRunAt("degraded");
  fixture.routeParams = { environmentId, threadId, tab: "run" };
  await streamRunAt("degraded");
  await mount();

  expect(fixture.runRequests.map((request) => request.input.runId)).toContain(runId);
  expect(phaseHeaders().map((node) => node.getAttribute("aria-label"))).toEqual([
    `Phase 1: clean — ${RUN_PHASE_1}`,
    `Phase 2: degraded — ${RUN_PHASE_2}`,
  ]);
});

it("phase10 android AC2 Run tab opens the running phase with its node in flight and keeps the other phases folded", async () => {
  await openRunTab("verify");
  expect(phaseHeader(1).getAttribute("aria-expanded")).toBe("true");
  expect(phaseHeader(2).getAttribute("aria-expanded")).toBe("false");

  const labels = visibleLabels();
  expect(labels).toEqual(
    expect.arrayContaining([
      "Fence: done",
      "Implement: done",
      "Build checks: done",
      "Verify ①: current",
      "Review: pending",
      "Commit: pending",
    ]),
  );
  // Only the open phase shows a spine: one node in flight, none of phase 2's.
  expect(labels.filter((label) => label === "Verify ①: current")).toHaveLength(1);
  expect(labels.filter((label) => label === "Fence: pending")).toHaveLength(0);
});

it("phase10 android AC2 tapping a phase expands its returns, role sessions, verdicts, findings, checks and commit, and folds it again", async () => {
  await openRunTab("degraded");
  expect(phaseHeader(1).getAttribute("aria-expanded")).toBe("false");
  expect(visibleText()).not.toContain("4a7d1e9");

  await press(phaseHeader(1));
  expect(phaseHeader(1).getAttribute("aria-expanded")).toBe("true");
  const text = visibleText();
  // Returns, each with its signal.
  expect(text).toContain(
    "repair 1/5 — Build checks: pnpm lint failed on an unused import in the CSV serializer; the import was removed",
  );
  expect(text).toContain(
    "rework 2/5 — Review: P1-1 repaired: rows stream through a cursor; P3-1 rejected",
  );
  // Role sessions.
  expect(text).toContain("claude-opus-5-5");
  expect(text).toContain("$16.58");
  expect(text).toContain("gpt-6-luna");
  expect(text).toContain("4,381,030 tokens");
  expect(text).toContain("gpt-6-sol");
  // Verdicts with their deciding line.
  expect(text).toContain("WORKS");
  expect(text).toContain(
    'curl "/invoices/export.csv?status=overdue" returned 14 rows, the same 14 the page lists',
  );
  // Findings with severity and disposition.
  expect(text).toContain("P1-1");
  expect(text).toContain(
    "The export loads every invoice into memory before it writes the first row",
  );
  expect(text).toContain("repaired");
  expect(text).toContain("P3-1");
  expect(text).toContain("rejected");
  // Checks with exit codes, and the commit.
  expect(text).toContain("pnpm lint");
  expect(text).toMatch(/exit\s*1/);
  expect(text).toContain("4a7d1e9");
  expect(text).toContain("feat(invoices): export the filtered invoice list as CSV");

  await press(phaseHeader(1));
  expect(phaseHeader(1).getAttribute("aria-expanded")).toBe("false");
  expect(visibleText()).not.toContain("4a7d1e9");
});

it("phase10 android AC2 Run tab shows a running role session's live tool calls and last tool", async () => {
  showRunAt("verify");
  fixture.routeParams = { environmentId, threadId, tab: "run", runId };
  // Phase 1 at Verify ①, with the verifier's first turn dispatched and running.
  await streamRun(foldFactoryRunTestLines(runEventLines.slice(0, 20)), [
    {
      phase: 1,
      role: "verifier",
      turn: 1,
      status: "running",
      toolCalls: 14,
      lastTool: "exec_command",
      lastActivityAt: "2026-09-28T10:24:00.000Z",
    },
  ]);
  await mount();

  const text = visibleText();
  expect(text).toContain("14 tool calls");
  expect(text).toContain("exec_command");
});

it("phase10 android AC2 Run tab opens a role turn's prompt file in the file screen", async () => {
  await openRunTab("degraded");
  await press(phaseHeader(1));

  const chip = buttons().find(
    (node) =>
      node.textContent?.includes("verifier-prompt-1.md") ||
      node.getAttribute("aria-label")?.includes("verifier-prompt-1.md"),
  );
  expect(chip, "Expected the verifier's first prompt as a file chip").toBeDefined();
  await press(chip!);
  expect(fixture.navigation.navigate).toHaveBeenCalledExactlyOnceWith("ThreadFile", {
    environmentId,
    threadId,
    path: ["", "srv", "factory-runs", "invoice-csv-export", "phase-1", "verifier-prompt-1.md"],
  });
});

it("phase10 android AC3 Run tab redraws as the run's stream delivers new state while the screen is focused", async () => {
  await openRunTab("verify");
  const header = phaseHeader(1);
  expect(visibleLabels()).toContain("Verify ①: current");

  await streamRunAt("review");
  expect(phaseHeader(1)).toBe(header);
  expect(visibleLabels()).toEqual(expect.arrayContaining(["Verify ①: done", "Review: current"]));
});

it("phase10 android AC3 Run tab ends the run stream when the screen loses focus and resumes it on focus", async () => {
  await openRunTab("verify");
  expect(fixture.runSubscriptions).toBe(1);

  await setFocused(false);
  expect(fixture.runSubscriptions).toBe(0);

  await streamRunAt("review");
  await setFocused(true);
  expect(fixture.runSubscriptions).toBe(1);
  expect(visibleLabels()).toContain("Review: current");
});

it("phase10 android AC3 Factory screen holds no run stream while the Plan tab shows", async () => {
  await openRunTab("verify");
  expect(fixture.runSubscriptions).toBe(1);

  const planTab = buttons().find(
    (node) => node.dataset.nativeRole === "tab" && node.textContent?.trim() === "Plan",
  );
  await press(planTab!);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(fixture.runSubscriptions).toBe(0);
});

it("phase10 android AC5 Run tab totals read a finished run's elapsed, waiting and cost with the floor mark", async () => {
  await openRunTab("degraded");
  const text = visibleText();
  expect(text).toMatch(/elapsed\s*4h 49m/i);
  expect(text).toMatch(/waiting\s*25m/i);
  expect(text).toContain("$23.94 + 8,429,560 tokens");
  expect(text).toMatch(/floor/i);
});

it("phase10 android AC5 Run tab totals close a live run's wait with the phone's clock and read dollars alone without the floor mark", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-28T12:43:00.000Z"));
    await openRunTab("waiting");
    const waiting = visibleText();
    expect(waiting).toMatch(/elapsed\s*3h 43m/i);
    expect(waiting).toMatch(/waiting\s*10m/i);

    await act(async () => root.unmount());
    root = createRoot(container);
    await openRunTab("verify");
    const verify = visibleText();
    expect(verify).toContain("$10.03");
    expect(verify).not.toMatch(/floor/i);
  } finally {
    vi.useRealTimers();
  }
});

// Review P1-1: a deviation names a path in the run's repository; its chip
// opens it there, not in the thread's workspace.
it("phase10 android P1-1 Run tab opens a deviation's file from the run's repository", async () => {
  await openRunTab("degraded");
  await press(phaseHeader(2));

  const chip = buttons().find(
    (node) =>
      node.textContent?.trim() === "Toolbar.tsx" ||
      node.getAttribute("aria-label")?.includes("src/components/Toolbar.tsx"),
  );
  expect(chip, "Expected the deviation's path as a file chip").toBeDefined();
  expect(visibleText()).toContain(
    "widened — The Export button sits in the shared toolbar, which needed a slot for page actions",
  );
  await press(chip!);
  expect(fixture.navigation.navigate).toHaveBeenCalledExactlyOnceWith("ThreadFile", {
    environmentId,
    threadId,
    path: ["", "srv", "repos", "billing-web", "src", "components", "Toolbar.tsx"],
  });
});

// The Report tab (phase 11 of factory-in-chat): criteria 2 to 6 on Android,
// through the same route screen. The body is the `factoryReadSnapshot` answer
// for the `factory.report` activity's digest; the frame is the run stream's
// state. Only the emulator shows the error tone of a degraded phase and a
// failed result, the drawn diagram, and the layout on a narrow screen.
import {
  FACTORY_REPORT_DIGEST,
  makeFactoryReportActivity,
} from "@t3tools/client-runtime/factory/testing";

import { readFactoryReportFixture } from "./factoryRun.test-support";

const reportMarkdown = readFactoryReportFixture();
const REPORT_STEP_LINE = "pnpm lint failed on an unused import in the CSV serializer";
const REPORT_HEADINGS = [
  "Context",
  "What was built",
  "How it was built",
  "Where this differs from the plan",
  "How it was verified",
  "Architecture",
  "What is unresolved",
  "The run, step by step",
];

/** The thread after `report.written`: its plan, its run and its report, the body stored by digest. */
function showReportAt(point: FactoryRunFixturePoint, markdown: string = reportMarkdown) {
  fixture.activities = [
    makeFactoryPlanActivity({ id: planId, createdAt: "2026-09-28T10:00:05.000Z" }),
    makeFactoryRunActivityAt({ threadId, point }),
    makeFactoryReportActivity({ threadId }),
  ];
  fixture.factorySnapshots[FACTORY_REPORT_DIGEST] = markdown;
}

async function openReportTab(point: FactoryRunFixturePoint = "degraded", markdown?: string) {
  showReportAt(point, markdown);
  fixture.routeParams = { environmentId, threadId, tab: "report", runId };
  await streamRunAt(point);
  await mount();
}

function reportTab(): HTMLButtonElement {
  const tab = buttons().find(
    (node) => node.dataset.nativeRole === "tab" && node.textContent?.trim() === "Report",
  );
  expect(tab, "Expected the Report tab").toBeDefined();
  return tab!;
}

const follows = (left: Node, right: Node) =>
  (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

function requireText(text: string): Element {
  const element = elementWithText(text);
  expect(element, `Expected "${text}" on the screen; screen: ${visibleText()}`).toBeDefined();
  return element!;
}

it("phase11 android AC2 Factory screen enables the Report tab when the thread has a report and shows it when pressed", async () => {
  showReportAt("degraded");
  await streamRunAt("degraded");
  await mount();
  expect(reportTab().disabled).toBe(false);
  expect(reportTab().getAttribute("aria-selected")).not.toBe("true");

  await press(reportTab());
  expect(reportTab().getAttribute("aria-selected")).toBe("true");
  expect(visibleText()).toContain("The export is one endpoint beside the list endpoint");
  expect(visibleText()).not.toContain(`${planSections.length} sections`);
});

it("phase11 android AC2 Report tab shows the clock band, then the authored sections in the contract's order, then the step record", async () => {
  await openReportTab();
  expect(reportTab().getAttribute("aria-selected")).toBe("true");

  const text = visibleText();
  expect(text).toMatch(/elapsed\s*4h 49m/i);
  expect(text).toMatch(/machine\s*4h 24m/i);
  expect(text).toMatch(/waiting\s*25m/i);
  expect(text).toContain("Accountants close each month from the invoice list");

  const headings = REPORT_HEADINGS.map(requireText);
  for (let index = 1; index < headings.length; index += 1) {
    expect(
      follows(headings[index - 1]!, headings[index]!),
      `"${REPORT_HEADINGS[index - 1]}" before "${REPORT_HEADINGS[index]}"`,
    ).toBe(true);
  }
  expect(text.search(/elapsed\s*4h 49m/i)).toBeLessThan(
    text.indexOf("Accountants close each month"),
  );
});

it("phase11 android AC2 AC3 Report tab draws one verification block per phase inside How it was verified, marking results and authored-tests-only", async () => {
  await openReportTab();
  const verified = requireText("How it was verified");
  const architecture = requireText("Architecture");
  const criterionLabel = (phase: number, n: number) => {
    const node = Array.from(container.querySelectorAll("[aria-label]")).find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith(`Phase ${phase}, criterion ${n}:`),
    );
    expect(
      node,
      `Expected phase ${phase} criterion ${n}; labels: ${visibleLabels()}`,
    ).toBeDefined();
    expect(follows(verified, node!), "inside How it was verified").toBe(true);
    expect(follows(node!, architecture), "before Architecture").toBe(true);
    return node!.getAttribute("aria-label") ?? "";
  };

  expect(criterionLabel(1, 1)).toMatch(/pass/i);
  expect(criterionLabel(1, 1)).not.toMatch(/authored tests only/i);
  expect(criterionLabel(1, 3)).toMatch(/pass/i);
  expect(criterionLabel(1, 3)).toMatch(/authored tests only/i);
  expect(criterionLabel(2, 1)).toMatch(/not exercised/i);
  expect(criterionLabel(2, 2)).toMatch(/pass/i);
  const text = visibleText();
  expect(text).toContain("A field that contains a comma or a quote is quoted per RFC 4180");
  expect(text).toContain("The Export button downloads invoices-<date>.csv");
  // The derived blocks come first, then the authored comment.
  expect(text.indexOf("The Export button downloads invoices-<date>.csv")).toBeLessThan(
    text.indexOf("The quoting of commas and quotes rests on authored tests only"),
  );
});

it("phase11 android AC4 Report tab draws the Architecture diagram with its reading and legend and folds the step record per phase", async () => {
  await openReportTab();
  expect(latestWebView().source.html).toContain("EX[Export endpoint]");
  const text = visibleText();
  expect(text).toContain("The page asks the endpoint for the file with its own filter");
  expect(text).toContain("the invoices page, which owns the filter.");
  expect(text).not.toContain("```mermaid");

  const stepRecord = requireText("The run, step by step");
  const folds = buttons().filter(
    (node) =>
      node.getAttribute("aria-expanded") !== null &&
      follows(stepRecord, node) &&
      (node.textContent?.includes(RUN_PHASE_1) || node.textContent?.includes(RUN_PHASE_2)),
  );
  expect(folds, "Expected one fold per phase under the step record").toHaveLength(2);
  expect(folds.map((node) => node.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  expect(visibleText()).not.toContain(REPORT_STEP_LINE);

  await press(folds[0]!);
  expect(visibleText()).toContain(REPORT_STEP_LINE);
});

it("phase11 android AC5 Report tab renders an unknown heading as a plain section and names a missing section", async () => {
  const withoutDifferences = reportMarkdown.replace(
    /## Where this differs from the plan\n[\s\S]*?(?=## How it was verified)/,
    "",
  );
  await openReportTab(
    "degraded",
    withoutDifferences.replace(
      "## How it was built",
      "## Screenshots\n\nTwo screenshots of the Export button, before and after.\n\n## How it was built",
    ),
  );

  expect(follows(requireText("What was built"), requireText("Screenshots"))).toBe(true);
  const text = visibleText();
  expect(text).toContain("Two screenshots of the Export button, before and after.");
  expect(text).toContain("Missing from report.md: Where this differs from the plan");
});

it("phase11 android AC6 Report tab reads the same clock and results as the web from the shared view model", async () => {
  await openReportTab(
    "degraded",
    reportMarkdown.replace(
      "Accountants close each month from the invoice list",
      "It took 1h of machine time and every criterion passed. Accountants close each month from the invoice list",
    ),
  );
  const text = visibleText();
  expect(text).toMatch(/elapsed\s*4h 49m/i);
  expect(text).toMatch(/machine\s*4h 24m/i);
  expect(text).toMatch(/waiting\s*25m/i);
});

it("phase11 android review P2-1 Report tab keeps the verification blocks at their contract place when report.md leaves the section out", async () => {
  await openReportTab(
    "degraded",
    reportMarkdown.replace(/## How it was verified\n[\s\S]*?(?=## Architecture)/, ""),
  );
  const heading = requireText("How it was verified");
  const criterion = Array.from(container.querySelectorAll("[aria-label]")).find((node) =>
    node.getAttribute("aria-label")?.startsWith("Phase 1, criterion 1:"),
  );
  expect(criterion, "Expected phase 1 criterion 1").toBeDefined();
  expect(follows(requireText("Where this differs from the plan"), heading)).toBe(true);
  expect(follows(heading, criterion!)).toBe(true);
  expect(follows(criterion!, requireText("Architecture"))).toBe(true);
  expect(visibleText()).toContain("Missing from report.md: How it was verified");
});
