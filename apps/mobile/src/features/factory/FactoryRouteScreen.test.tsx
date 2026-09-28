// @vitest-environment happy-dom
// Entry point: FactoryRouteScreen, the screen `Stack.tsx` registers as the
// `ThreadFactory` route, mounted with its route params and the real plan
// document, segmented control and MermaidWebView under it. Stubbed: native
// hosts (DOM elements), the thread selection, the stored plan body
// (`factoryEnvironment.factorySnapshot`) and the WebView host.
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
}));

type NativeStyle = { height?: number; display?: string } | ReadonlyArray<unknown> | undefined;
function flattenStyle(style: NativeStyle): { height?: number; display?: string } {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((entry) => flattenStyle(entry as NativeStyle)));
  }
  return (style as { height?: number; display?: string } | undefined) ?? {};
}

vi.mock("react-native", () => {
  const View = ({ children, style }: { children?: ReactNode; style?: NativeStyle }) => {
    const flat = flattenStyle(style);
    return (
      <div data-height={flat.height} hidden={flat.display === "none"}>
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
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => fixture.navigation,
  useRoute: () => ({ key: "factory", name: "ThreadFactory", params: fixture.routeParams }),
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
}));
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
