// @vitest-environment happy-dom
// Entry point: ThreadDetailScreen with real ThreadFeed, PendingUserInputCard,
// QuestionAttachments, request state, attachment strip, and thread-work-log.
// The Factory plan card specs mount the same entry point; only the stored plan
// body (`factoryEnvironment.factorySnapshot`), navigation and the thread outbox
// (`enqueueThreadOutboxMessage`, where Approve sends its message) are stubbed.
// Native hosts use DOM controls. Geometry tests cover keyboard ownership and
// scroll routing; physical keyboard occlusion still requires device verification.
import { act, memo, useMemo, useState, useImperativeHandle, useRef, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";

const fixture = vi.hoisted(() => ({
  feedRowRenders: vi.fn(),
  feedRenders: vi.fn(),
  usageReport: null as { createdAt: string } | null,
  platform: "android",
  keyboardHeight: 0,
  geometry: false,
  composerInset: 0,
  inputY: 470,
  scrollOffset: 200,
  scrollToOffset: vi.fn(),
  keyboardShown: undefined as (() => void) | undefined,
  selectedThread: { environmentId: "inline-screen-environment", id: "inline-screen-thread" },
  activities: [] as import("@t3tools/contracts").OrchestrationThreadActivity[],
  messages: [] as import("@t3tools/contracts").OrchestrationMessage[],
  respond: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  dismiss: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  send: vi.fn(async () => null),
  transcribe: vi.fn(async (_uri: string, _options: { signal: AbortSignal }) => "Dictated detail"),
  record: vi.fn(),
  uploads: {} as Record<string, { status: string; progress?: number; reason?: string }>,
  configs: new Map(),
  navigation: {
    navigate: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
    dispatch: vi.fn(),
    goBack: vi.fn(),
  },
  factorySnapshots: {} as Record<string, string>,
  factorySnapshotAtoms: new Map<string, unknown>(),
  /** The `subscribeFactoryRun` item every run's stream answers with; null stays loading. A report card must never ask for it. */
  factoryRunItem: null as unknown,
  factoryRunAtoms: new Map<string, unknown>(),
  serverConfig: null as unknown,
  enqueue: vi.fn(async (_message: unknown) => undefined),
  queuedMessages: [] as unknown[],
  finishDictation: vi.fn(async (_input: unknown) => ({ jobId: "job-1", status: "started" })),
}));
vi.mock("react-native", () => {
  const View = ({
    children,
    style,
    className,
  }: {
    children?: ReactNode;
    style?: { display?: string };
    className?: string;
  }) => (
    <div className={className} hidden={style?.display === "none"}>
      {children}
    </div>
  );
  const TextInput = ({
    ref,
    value,
    editable,
    onChangeText,
    onFocus,
    onBlur,
    onSelectionChange,
    placeholder,
    accessibilityLabel,
  }: {
    ref?: Ref<unknown>;
    value?: string;
    editable?: boolean;
    onChangeText?: (text: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onSelectionChange?: (event: {
      nativeEvent: { selection: { start: number; end: number } };
    }) => void;
    placeholder?: string;
    accessibilityLabel?: string;
  }) => {
    const element = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      isFocused: () => document.activeElement === element.current,
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
        callback(20, fixture.inputY, 340, 60),
    }));
    return (
      <textarea
        ref={element}
        value={value ?? ""}
        disabled={editable === false}
        onChange={(event) => onChangeText?.(event.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onSelect={(event) =>
          onSelectionChange?.({
            nativeEvent: {
              selection: {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              },
            },
          })
        }
        placeholder={placeholder}
        aria-label={accessibilityLabel}
      />
    );
  };
  return {
    Platform: {
      get OS() {
        return fixture.platform;
      },
      select: (values: Record<string, unknown>) => values[fixture.platform] ?? values.default,
    },
    View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput,
    Pressable: ({
      children,
      disabled,
      onPress,
      accessibilityLabel,
      accessibilityRole,
      className,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      className?: string;
    }) => (
      <button
        className={className}
        disabled={disabled}
        onClick={onPress}
        aria-label={accessibilityLabel}
        data-native-role={accessibilityRole}
      >
        {children}
      </button>
    ),
    ScrollView: ({ children, horizontal }: { children?: ReactNode; horizontal?: boolean }) => (
      <div data-native-scroll={horizontal ? "horizontal" : "vertical"}>{children}</div>
    ),
    Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) =>
      visible === false ? null : <div data-native-modal="true">{children}</div>,
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
    Keyboard: {
      dismiss: () => undefined,
      metrics: () =>
        fixture.keyboardHeight ? { screenY: 800 - fixture.keyboardHeight } : undefined,
      addListener: (event: string, callback: () => void) => {
        if (event === "keyboardDidShow") fixture.keyboardShown = callback;
        return { remove: () => undefined };
      },
    },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
    useWindowDimensions: () => ({ height: 800, width: 390, fontScale: 1, scale: 1 }),
  };
});
// Legend List 3.3.5 memoizes a mounted row on its item and `extraData`
// (`getRenderedItem` in `useMemo([itemKey, data, extraData])`): a new
// `renderItem` alone never reaches it. The mock keeps that rule, so state a
// row reads has to travel in its item or in `extraData`, as on the phone.
const LegendListRow = memo(
  function LegendListRow(props: {
    item: unknown;
    index: number;
    extraData: unknown;
    renderItem: (input: { item: unknown; index: number }) => ReactNode;
  }) {
    return <>{props.renderItem({ item: props.item, index: props.index })}</>;
  },
  (previous, next) =>
    previous.item === next.item &&
    previous.index === next.index &&
    previous.extraData === next.extraData,
);
vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: ({
    ref,
    data,
    extraData,
    renderItem,
    ListHeaderComponent,
  }: {
    ref?: Ref<unknown>;
    data: ReadonlyArray<{ id: string }>;
    extraData?: unknown;
    renderItem: (input: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => {
    useImperativeHandle(fixture.geometry ? ref : undefined, () => ({
      getState: () => ({ scroll: fixture.scrollOffset }),
      scrollToOffset: fixture.scrollToOffset,
      reportContentInset: ({ bottom }: { bottom: number }) => {
        fixture.composerInset = bottom;
      },
    }));
    fixture.feedRenders();
    return (
      <section aria-label="Conversation" data-keyboard-aware="true">
        {ListHeaderComponent}
        {data.map((item, index) => {
          fixture.feedRowRenders(item.id);
          return (
            <div data-feed-row={item.id} key={item.id}>
              <LegendListRow
                item={item}
                index={index}
                extraData={extraData}
                renderItem={renderItem}
              />
            </div>
          );
        })}
      </section>
    );
  },
  useKeyboardChatComposerInset: () => ({
    contentInsetEndAdjustment: { value: 0 },
    onComposerLayout: () => undefined,
  }),
  useKeyboardScrollToEnd: () => ({
    freeze: { set: () => undefined },
    scrollMessageToEnd: async () => undefined,
  }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: (select: (state: { isVisible: boolean; height: number }) => unknown) =>
    select({ isVisible: fixture.keyboardHeight > 0, height: fixture.keyboardHeight }),
  KeyboardStickyView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  KeyboardController: { dismiss: async () => undefined },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  Easing: {
    out: () => (value: number) => value,
    inOut: () => (value: number) => value,
    cubic: (value: number) => value,
    quad: (value: number) => value,
  },
  FadeInDown: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  FadeIn: { duration: () => ({}), delay: () => ({ duration: () => ({}) }) },
  FadeInUp: { duration: () => ({ easing: () => ({}) }) },
  FadeOutDown: { duration: () => ({ easing: () => ({}) }) },
  LinearTransition: { duration: () => ({ reduceMotion: () => ({}) }) },
  ReduceMotion: { System: "system" },
  useAnimatedReaction: () => undefined,
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) =>
    useState(() => ({
      value,
      set(next: unknown) {
        this.value = next;
      },
    }))[0],
  cancelAnimation: () => undefined,
  withDelay: (_delay: unknown, value: unknown) => value,
  withRepeat: (value: unknown) => value,
  withSequence: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext(0),
}));
vi.mock("expo-blur", () => ({
  BlurTargetView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-haptics", () => ({
  impactAsync: () => undefined,
  selectionAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../../lib/glassBlurTarget", async () => ({
  GlassBlurTargetContext: (await import("react")).createContext(null),
}));
vi.mock("../layout/workspace-content-width", () => ({ useWorkspaceContentWidth: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 14 }, themeAppearance: "dark" }),
}));
vi.mock("./PendingApprovalCard", () => ({ PendingApprovalCard: () => null }));
vi.mock("./ComposerFeedback", () => ({ ComposerFeedback: () => null }));
vi.mock("@t3tools/shared/usageLimits", () => ({
  collectProviderUsageLimits: () => fixture.usageReport,
}));
vi.mock("./ComposerUsageLimits", () => ({
  ComposerUsageLimits: () => <div>Usage limits report</div>,
}));
vi.mock("./ThreadCreationFailedCard", () => ({ ThreadCreationFailedCard: () => null }));
vi.mock("./floating-working-control", () => ({
  FLOATING_WORKING_CONTROL_COVERAGE: 0,
  FloatingWorkingControl: () => null,
}));
vi.mock("./floating-working-status", () => ({ connectionFloatingStatus: () => null }));
vi.mock("../../state/edit-pending-thread-message", () => ({
  editPendingThreadMessage: () => undefined,
}));
vi.mock("../../components/AppText", async () => ({
  AppText: (await import("react-native")).Text,
  AppTextInput: (await import("react-native")).TextInput,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("./ThreadComposer", () => ({
  COMPOSER_COLLAPSED_CHROME: 50,
  COMPOSER_EXPANDED_CHROME: 100,
  COMPOSER_LAYOUT_TRANSITION: {},
  COMPOSER_TRANSITION_DURATION_MS: 100,
  ThreadComposer: ({
    draftMessage,
    onChangeDraftMessage,
    onSendMessage,
    onShowUsageLimits,
  }: {
    draftMessage: string;
    onChangeDraftMessage: (value: string) => void;
    onSendMessage: () => void;
    onShowUsageLimits: (report: { createdAt: string } | null) => void;
  }) => (
    <div aria-label="Message composer">
      <textarea
        aria-label="Message"
        value={draftMessage}
        onChange={(event) => onChangeDraftMessage(event.target.value)}
      />
      <button onClick={onSendMessage}>Send message</button>
      <button onClick={() => onShowUsageLimits(fixture.usageReport)}>Show usage limits</button>
    </div>
  ),
}));

import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => fixture.navigation,
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
}));
vi.mock("@legendapp/list/react-native", () => ({ useViewabilityAmount: () => 1 }));
vi.mock("@legendapp/list/reanimated", () => ({ AnimatedLegendList: () => null }));
vi.mock("@expo/ui/community/masked-view", () => ({
  MaskedView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
// One theme object, as the app's theme hook returns while the theme holds:
// the feed's `extraData` is derived from it.
const stableTheme = vi.hoisted(() => new Proxy({}, { get: () => "#333333" }));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => stableTheme,
}));
vi.mock("../../lib/useFontFamily", () => ({ useFontFamily: () => "sans-serif" }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  hasNativeSelectableMarkdownText: () => false,
  SelectableMarkdownText: () => null,
}));
vi.mock("../../components/NativePresentation", () => ({
  PresentationSource: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./useFileChipShare", () => ({ useFileChipShare: () => vi.fn() }));
vi.mock("./markdownCodeHighlightState", () => ({ useMarkdownCodeHighlight: () => null }));
// Stable across renders, as the real hook's memoized colors are: the feed's
// `extraData` holds them, and a fresh object would re-render every row.
const stableReviewCommentColors = vi.hoisted(() => ({}));
vi.mock("../review/ReviewCommentCard", () => ({
  ReviewCommentCard: () => null,
  useReviewCommentColors: () => stableReviewCommentColors,
}));
vi.mock("./ThreadMarkdownImage", async () => ({
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
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/session", () => ({ usePreparedConnection: () => null }));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: fixture.selectedThread }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadDetail: () => ({ activities: fixture.activities }),
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => fixture.configs }));
// The plan body a `factory.plan` activity names by digest, as the server's
// factoryReadSnapshot RPC would answer it; an unknown digest stays loading.
vi.mock("../../state/factory", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  return {
    factoryEnvironment: {
      factorySnapshot: ({ input }: { input: { digest: string } }) => {
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
      factoryRun: ({ input }: { input: { threadId: string; runId: string } }) => {
        const key = `${input.threadId}:${input.runId}:${fixture.factoryRunItem === null ? "loading" : "ready"}`;
        let atom = fixture.factoryRunAtoms.get(key);
        if (atom === undefined) {
          atom = Atom.make(
            fixture.factoryRunItem === null
              ? AsyncResult.initial(true)
              : AsyncResult.success(fixture.factoryRunItem),
          );
          fixture.factoryRunAtoms.set(key, atom);
        }
        return atom;
      },
    },
  };
});
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToUserInput: "respond", dismissUserInput: "dismiss" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "respond" ? fixture.respond : fixture.dismiss),
}));
// Approve's message ids come from `makeQueuedMessageMetadata`, which reads
// expo-crypto; its native module does not load under happy-dom.
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../../state/thread-outbox", async () => ({
  ...(await import("../../state/thread-outbox-model")),
  enqueueThreadOutboxMessage: fixture.enqueue,
}));
vi.mock("../../lib/useNativePaste", () => ({ useNativePaste: () => vi.fn() }));
vi.mock("expo-paste-input", () => ({
  TextInputWrapper: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../lib/composerImages", () => ({
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
  convertPastedImagesToAttachments: vi.fn(),
  isFileBackedComposerAttachment: () => true,
}));
vi.mock("../../lib/composerAttachmentFiles", () => ({
  resolveOwnedComposerAttachmentFileUri: async (uri: string) => uri,
}));
vi.mock("../../state/use-composer-drafts", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerDraftsAtom: Atom.make({}).pipe(Atom.keepAlive),
    clearComposerDraft: vi.fn(),
    appendComposerDraftAttachments: vi.fn(),
    removeComposerDraftAttachment: vi.fn(),
    releaseUnusedComposerAttachmentFiles: vi.fn(),
  };
});
vi.mock("../../state/composer-attachment-uploads", async () => {
  const actual = await import("../../lib/composerAttachmentUploadQueue");
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    ...actual,
    composerAttachmentUploadsAtom: Atom.make({}).pipe(Atom.keepAlive),
    useComposerAttachmentUploadState: (_environment: unknown, id: string) =>
      fixture.uploads[id] ?? null,
    retryComposerAttachmentUpload: vi.fn(),
  };
});
vi.mock("../../components/ComposerContextSheet", () => ({ ComposerContextSheet: () => null }));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/VideoAttachmentTile", () => ({ VideoAttachmentTile: () => null }));
vi.mock("../../components/MediaVideoPlayer", () => ({ MediaVideoPlayer: () => null }));
vi.mock("../../components/CopyTextButton", () => ({ CopyTextButton: () => null }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/MesuraWordmark", () => ({ MesuraWordmark: () => null }));
vi.mock("../../components/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: () => null,
}));
vi.mock("../../lib/composerContextClipboard", () => ({ writeComposerContextClipboard: vi.fn() }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../lib/attachmentDownload", () => ({ downloadAndShareAttachment: vi.fn() }));

import { RegistryContext } from "@effect/atom-react";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { appAtomRegistry } from "../../state/atom-registry";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { composerDraftsAtom } from "../../state/use-composer-drafts";
import { questionAttachmentDraftKey } from "../../state/question-attachments";
import { composerAttachmentUploadsAtom } from "../../state/composer-attachment-uploads";
import { buildThreadFeed } from "../../lib/threadActivity";

const environmentId = EnvironmentId.make("inline-screen-environment");
const threadId = ThreadId.make("inline-screen-thread");
const requestId = ApprovalRequestId.make("inline-screen-request");
const questions = [
  {
    id: "runtime",
    header: "Runtime",
    question: "Which runtime?",
    options: [{ label: "Go", description: "Portable executable", value: " go " }],
    multiSelect: false,
  },
  { id: "scope", header: "Scope", question: "What scope?", options: [], multiSelect: false },
];
function requestActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("inline-screen-requested"),
    kind: "user-input.requested",
    createdAt: "2026-09-23T10:00:00.000Z",
    summary: "Questions",
    tone: "info",
    turnId: null,
    payload: { requestId, responseMode: "message", questions },
  };
}
const selectedThread = {
  id: threadId,
  environmentId,
  projectId: ProjectId.make("inline-screen-project"),
  title: "Inline fence",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  latestTurn: null,
  latestUserMessageAt: null,
};
function ScreenHarness() {
  const requests = useSelectedThreadRequests();
  const [draftMessage, setDraftMessage] = useState("");
  // Memoized as the route screen's feed is: a render that changes neither the
  // messages nor the activities hands the list the same entries.
  const { messages, activities } = fixture;
  const feed = useMemo(() => buildThreadFeed({ messages, activities }), [messages, activities]);
  const props = {
    ...requests,
    selectedThread: {
      ...selectedThread,
      id: ThreadId.make(fixture.selectedThread.id),
      environmentId: EnvironmentId.make(fixture.selectedThread.environmentId),
    },
    environmentId: EnvironmentId.make(fixture.selectedThread.environmentId),
    selectedThreadFeed: feed,
    contentPresentation: { kind: "ready" },
    screenTone: "neutral",
    connectionStateLabel: "connected",
    connectionError: null,
    environmentLabel: null,
    feedbackSubmissions: [],
    creationState: null,
    activeWorkStartedAt: null,
    isCompacting: false,
    draftMessage,
    draftAttachments: [],
    queuedMessages: fixture.queuedMessages,
    dispatchingMessageId: null,
    selectedThreadQueueCount: 0,
    serverConfig: fixture.serverConfig,
    projectWorkspaceRoot: null,
    threadCwd: null,
    onChangeDraftMessage: setDraftMessage,
    onSendMessage: fixture.send,
  } as unknown as ThreadDetailScreenProps;
  return <ThreadDetailScreen {...props} />;
}
let root: Root;
let container: HTMLDivElement;
async function mount() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ScreenHarness />
      </RegistryContext.Provider>,
    ),
  );
}
function conversation() {
  return container.querySelector<HTMLElement>('section[aria-label="Conversation"]')!;
}
function button(text: string) {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent?.trim() === text || node.getAttribute("aria-label") === text,
  );
  expect(match, `Expected button: ${text}`).toBeDefined();
  return match!;
}
function answerInputs() {
  return Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea")).filter(
    (node) => node.getAttribute("aria-label") !== "Message",
  );
}
async function type(input: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("select", { bubbles: true }));
  });
}
async function press(text: string) {
  await act(async () => button(text).click());
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.feedRowRenders.mockClear();
  fixture.feedRenders.mockClear();
  fixture.usageReport = null;
  fixture.platform = "android";
  fixture.keyboardHeight = 0;
  fixture.geometry = false;
  fixture.inputY = 470;
  fixture.scrollOffset = 200;
  fixture.scrollToOffset.mockClear();
  fixture.keyboardShown = undefined;
  fixture.selectedThread = { environmentId, id: threadId };
  fixture.activities = [requestActivity()];
  fixture.messages = [];
  fixture.uploads = {};
  fixture.record.mockClear();
  fixture.transcribe.mockReset();
  fixture.transcribe.mockResolvedValue("Dictated detail");
  fixture.respond.mockClear();
  fixture.respond.mockResolvedValue({ _tag: "Success", value: undefined });
  fixture.dismiss.mockClear();
  fixture.send.mockClear();
  for (const method of Object.values(fixture.navigation)) method.mockClear();
  fixture.factorySnapshots = {};
  fixture.factorySnapshotAtoms.clear();
  fixture.factoryRunItem = null;
  fixture.factoryRunAtoms.clear();
  fixture.serverConfig = null;
  fixture.enqueue.mockReset();
  fixture.enqueue.mockResolvedValue(undefined);
  fixture.finishDictation.mockClear();
  fixture.queuedMessages = [];
  fixture.configs = new Map([
    [
      environmentId,
      {
        environment: {
          capabilities: {
            questionAttachments: true,
            attachmentUploads: true,
            fileAttachments: { maxUploadBytes: 1048576 },
          },
        },
        // The host has a dictation key, so the question card offers server dictation.
        settings: {
          providerInstances: {},
          dictation: { openAiApiKey: "\u2022\u2022\u2022\u2022\u2022\u2022" },
        },
      },
    ],
  ]);
  appAtomRegistry.reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("mobile phase3 AC1 renders every request question inside the real feed beside the message composer", async () => {
  fixture.activities.push({
    ...requestActivity(),
    id: EventId.make("inline-screen-second-requested"),
    createdAt: "2026-09-23T10:00:01.000Z",
    payload: {
      requestId: "inline-screen-second-request",
      responseMode: "message",
      questions: [{ ...questions[1], id: "other", question: "Which release?" }],
    },
  });
  await mount();
  expect(conversation().querySelectorAll("textarea")).toHaveLength(3);
  const fields = conversation().querySelectorAll("textarea");
  expect(fields[0]!.closest("[data-feed-row]")).toBe(fields[1]!.closest("[data-feed-row]"));
  expect(fields[2]!.closest("[data-feed-row]")).not.toBe(fields[0]!.closest("[data-feed-row]"));
  expect(
    Array.from(conversation().querySelectorAll("button")).filter(
      (node) => node.textContent === "Submit answers",
    ),
  ).toHaveLength(2);
  expect(conversation().textContent).toContain("Which runtime?");
  expect(conversation().textContent).toContain("What scope?");
  expect(
    container.querySelector('[aria-label="Message composer"]')?.closest("[hidden]"),
  ).toBeNull();
  await type(container.querySelector('[aria-label="Message"]')!, "Separate follow-up");
  await press("Send message");
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.respond).not.toHaveBeenCalled();
});
it("mobile phase3 guard keeps normal message entry available without pending questions", async () => {
  fixture.activities = [];
  await mount();
  expect(
    container.querySelector('[aria-label="Message composer"]')?.closest("[hidden]"),
  ).toBeNull();
  await type(container.querySelector('[aria-label="Message"]')!, "Normal message");
  await press("Send message");
  expect(fixture.send).toHaveBeenCalledOnce();
});

async function chooseGo() {
  const option = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((node) =>
    node.textContent?.includes("Portable executable"),
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}
function submittedAnswers() {
  const lastCall = fixture.respond.mock.calls.at(-1);
  expect(lastCall, "Expected a request-wide answer command").toBeDefined();
  return (lastCall![0] as { input: { answers: unknown } }).input.answers;
}
it("mobile phase3 guard AC2 retains the opaque selection and typed note through submission", async () => {
  await mount();
  await chooseGo();
  await type(answerInputs()[0]!, "Keep it portable");
  await type(answerInputs()[1]!, "API only");
  expect(fixture.respond).not.toHaveBeenCalled();
  await press("Submit answers");
  expect(submittedAnswers()).toEqual({ runtime: [" go ", "Keep it portable"], scope: "API only" });
});
it("mobile phase3 guard AC3 submits one complete request and preserves the draft for retry after failure", async () => {
  await mount();
  expect(button("Submit answers").disabled).toBe(true);
  await chooseGo();
  expect(button("Submit answers").disabled).toBe(true);
  await press("Submit answers");
  expect(fixture.respond).not.toHaveBeenCalled();
  await type(answerInputs()[1]!, "API only");
  const failedResponse = deferred<{ _tag: string; value: undefined }>();
  fixture.respond.mockReturnValueOnce(failedResponse.promise);
  await press("Submit answers");
  await press("Submit answers");
  expect(fixture.respond).toHaveBeenCalledOnce();
  await act(async () => failedResponse.resolve({ _tag: "Failure", value: undefined }));
  expect(answerInputs()[1]!.value).toBe("API only");
  expect(button("Submit answers").disabled).toBe(false);
  await press("Submit answers");
  expect(fixture.respond).toHaveBeenCalledTimes(2);
  expect(fixture.respond.mock.calls[1]).toEqual(fixture.respond.mock.calls[0]);
});
it.each(["android", "ios"])(
  "mobile phase3 AC4 routes focused long-card fields through the %s keyboard-aware conversation without vertical nesting",
  async (platform) => {
    fixture.platform = platform;
    fixture.keyboardHeight = 320;
    fixture.activities = [
      {
        ...requestActivity(),
        payload: {
          requestId,
          responseMode: "message",
          questions: Array.from({ length: 12 }, (_, index) => ({
            ...questions[1],
            id: `long-${index}`,
            question: `Long question ${index}`,
          })),
        },
      },
    ];
    await mount();
    const last = answerInputs().at(-1)!;
    expect(last).toBeDefined();
    await act(async () => last.focus());
    expect(document.activeElement).toBe(last);
    expect(last.closest('[data-keyboard-aware="true"]')).toBe(conversation());
    expect(last.closest('[data-native-scroll="vertical"]')).toBeNull();
    await type(last, "Answer above the keyboard");
    expect(last.value).toBe("Answer above the keyboard");
  },
);
it("mobile phase3 guard AC7 dismisses message-mode questions using the request command", async () => {
  await mount();
  await press("Dismiss without answering");
  expect(fixture.dismiss).toHaveBeenCalledWith({ environmentId, input: { threadId, requestId } });
  expect(fixture.respond).not.toHaveBeenCalled();
});
it("mobile phase3 AC7 shows a disabled field and explains the listed-choice limit", async () => {
  fixture.activities = [
    {
      ...requestActivity(),
      payload: { requestId, questions: [{ ...questions[0], allowCustomAnswer: false }] },
    },
  ];
  await mount();
  expect(answerInputs()).toHaveLength(1);
  expect(answerInputs()[0]!.disabled).toBe(true);
  expect(container.textContent).toMatch(/only[^.]*choice|choice[^.]*only/i);
  expect(container.textContent).not.toContain("Dismiss without answering");
});
function seedAttachment(question: string, status: "uploading" | "failed" | "ready") {
  const key = questionAttachmentDraftKey(environmentId, threadId, requestId, question);
  const attachment = {
    type: "file" as const,
    id: `${question}-file`,
    name: `${question}.txt`,
    mimeType: "text/plain",
    sizeBytes: 4,
    fileUri: `file:///tmp/${question}.txt`,
    uploadedAttachmentId: `${question}-uploaded`,
    uploadEnvironmentId: environmentId,
  };
  const current = appAtomRegistry.get(composerDraftsAtom);
  appAtomRegistry.set(composerDraftsAtom, {
    ...current,
    [key]: { text: "", attachments: [attachment] },
  });
  const upload: import("../../lib/composerAttachmentUploadQueue").ComposerAttachmentUploadState =
    status === "uploading"
      ? { status, progress: 0.5 }
      : status === "failed"
        ? { status, reason: "Offline" }
        : { status };
  fixture.uploads[attachment.id] = upload;
  appAtomRegistry.set(composerAttachmentUploadsAtom, {
    ...appAtomRegistry.get(composerAttachmentUploadsAtom),
    [`${environmentId}:${attachment.id}`]: upload,
  });
}
it("mobile phase3 guard AC6 keeps per-question attachment chips and blocks unfinished uploads", async () => {
  seedAttachment("runtime", "uploading");
  seedAttachment("scope", "ready");
  await mount();
  expect(container.querySelector('[aria-label="Open runtime.txt"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Open scope.txt"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Uploading runtime.txt, 50%"]')).not.toBeNull();
  expect(button("Submit answers").disabled).toBe(true);
  await act(async () => seedAttachment("runtime", "failed"));
  await mount();
  expect(container.querySelector('[aria-label="Retry uploading runtime.txt"]')).not.toBeNull();
  expect(button("Submit answers").disabled).toBe(true);
});
it("mobile phase3 AC6 renders question attachment chips and upload state in their inline feed row", async () => {
  seedAttachment("runtime", "uploading");
  await mount();
  expect(conversation().querySelector('[aria-label="Open runtime.txt"]')).not.toBeNull();
  expect(conversation().querySelector('[aria-label="Uploading runtime.txt, 50%"]')).not.toBeNull();
});
it("mobile phase3 guard AC6 opens submitted answer history with its original attachment", async () => {
  fixture.activities = [
    {
      ...requestActivity(),
      id: EventId.make("inline-screen-submitted"),
      kind: "user-input.answer-submitted",
      payload: {
        requestId,
        answers: { runtime: [" go ", "Keep it portable"] },
        questionTextById: { runtime: "Which runtime?" },
        attachmentsByQuestionId: {
          runtime: [
            {
              type: "file",
              id: "history-file",
              name: "history.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
            },
          ],
        },
      },
    },
  ];
  await mount();
  const history = conversation().querySelector<HTMLButtonElement>("button");
  expect(history).not.toBeNull();
  await act(async () => history!.click());
  expect(conversation().textContent).toContain("Keep it portable");
  expect(conversation().textContent).toContain("history.txt");
});

vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: async () => undefined,
  setIsAudioActiveAsync: async () => undefined,
  useAudioRecorder: () =>
    useState(() => ({
      uri: "file:///tmp/inline-recording.m4a",
      prepareToRecordAsync: async () => undefined,
      record: fixture.record,
      stop: async () => undefined,
      getStatus: () => ({ isRecording: false, durationMillis: 0 }),
    }))[0],
}));
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {}
  },
  Paths: { document: { uri: "file:///tmp" } },
}));
vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () => ({
    prepare: async () => ({ locale: "en-US", transcribe: fixture.transcribe }),
  }),
}));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));
vi.mock("../../state/dictation", () => ({
  finishDictation: fixture.finishDictation,
  deliverDictationJobs: vi.fn(),
  readDictationJobFailure: () => null,
  retryDictationJob: vi.fn(),
}));
const questionDictationOwner = (questionId: string) =>
  expect.objectContaining({
    owner: expect.objectContaining({
      environmentId,
      target: { kind: "thread", environmentId, threadId },
      question: { requestKey: JSON.stringify([environmentId, threadId, requestId]), questionId },
    }),
  });
async function focusQuestion(index: number) {
  await act(async () => answerInputs()[index]!.focus());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("mobile phase3 AC2 appends dictation to the selected question note without submitting or losing its option", async () => {
  await mount();
  await chooseGo();
  await type(answerInputs()[0]!, "Typed detail");
  await focusQuestion(0);
  expect(container.querySelectorAll('[aria-label="Start dictation"]')).toHaveLength(1);
  await press("Start dictation");
  await press("Stop dictation");
  // Phase 7: the recording goes to the server path, owned by the focused answer;
  // its marker and transcript land through `state/dictation`, pinned there.
  expect(fixture.finishDictation).toHaveBeenCalledOnce();
  expect(fixture.finishDictation).toHaveBeenCalledWith(questionDictationOwner("runtime"));
  expect(fixture.transcribe).not.toHaveBeenCalled();
  expect(answerInputs()[0]!.value).toContain("Typed detail");
  expect(fixture.respond).not.toHaveBeenCalled();
  const note = answerInputs()[0]!.value;
  await type(answerInputs()[1]!, "API only");
  await press("Submit answers");
  expect(submittedAnswers()).toEqual({ runtime: [" go ", note], scope: "API only" });
});
it.each(["question", "thread", "request", "environment"])(
  "mobile phase3 AC5 never delivers late transcription to another %s target",
  async (switchTarget) => {
    // Phase 7: a stopped recording is owned by the answer focused at stop time; switching
    // afterwards changes neither that owner nor the answers now on screen.
    await mount();
    await type(answerInputs()[0]!, "Original draft");
    await focusQuestion(0);
    expect(container.querySelectorAll('[aria-label="Start dictation"]')).toHaveLength(1);
    await press("Start dictation");
    expect(fixture.record).toHaveBeenCalledOnce();
    await press("Stop dictation");
    if (switchTarget === "question") {
      await focusQuestion(1);
    } else {
      fixture.selectedThread = {
        environmentId: switchTarget === "environment" ? "other-environment" : environmentId,
        id: switchTarget === "thread" ? "inline-screen-other-thread" : threadId,
      };
      fixture.activities = [
        {
          ...requestActivity(),
          payload: {
            requestId: switchTarget === "request" ? "other-request" : requestId,
            responseMode: "message",
            questions,
          },
        },
      ];
      await mount();
      await focusQuestion(0);
    }
    const destinationValues = () =>
      (switchTarget === "question" ? answerInputs().slice(1) : answerInputs()).map(
        (input) => input.value,
      );
    const destinationBefore = destinationValues();
    await act(async () => undefined);
    expect(fixture.finishDictation).toHaveBeenCalledOnce();
    expect(fixture.finishDictation).toHaveBeenCalledWith(questionDictationOwner("runtime"));
    expect(destinationValues()).toEqual(destinationBefore);
    expect(fixture.respond).not.toHaveBeenCalled();
  },
);
it("mobile phase7 refuses to submit question answers while a transcription is pending", async () => {
  await mount();
  await chooseGo();
  await type(answerInputs()[0]!, "Typed [Transcribing](t3-context://v1/dictation/job-pending)");
  await type(answerInputs()[1]!, "API only");
  await press("Submit answers");
  expect(fixture.respond).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Waiting for the transcription");

  await type(answerInputs()[0]!, "Typed and transcribed");
  expect(container.textContent).not.toContain("Waiting for the transcription");
  await press("Submit answers");
  expect(fixture.respond).toHaveBeenCalledOnce();
});
it("mobile phase7 hides question dictation when the host has no dictation key", async () => {
  fixture.configs.set(environmentId, {
    ...(fixture.configs.get(environmentId) as object),
    settings: { providerInstances: {}, dictation: { openAiApiKey: "" } },
  });
  await mount();
  await focusQuestion(0);
  expect(container.querySelectorAll('[aria-label="Start dictation"]')).toHaveLength(0);
});

import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { ComposerDictationPrimaryAction } from "../voice-input/ComposerDictationControl";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
function ExistingVoiceHookProbe() {
  const [text, setText] = useState("Existing draft");
  const [selection, setSelection] = useState({ start: text.length, end: text.length });
  const voice = useVoiceInputController({
    ownerKey: "existing-composer",
    draftMessage: text,
    selection,
    onChangeDraftMessage: setText,
    onChangeSelection: setSelection,
  });
  return (
    <>
      <output>{text}</output>
      <ComposerDictationPrimaryAction
        state={voice.state}
        presentation={resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds)}
        isAvailable={voice.isAvailable}
        onStart={voice.start}
        onConfirm={voice.stop}
        onCancel={voice.cancel}
      />
    </>
  );
}
it("mobile phase3 guard preserves the existing native voice hook and shared recording controls", async () => {
  await act(async () => root.render(<ExistingVoiceHookProbe />));
  await press("Start dictation");
  expect(fixture.record).toHaveBeenCalledOnce();
  await press("Finish dictation");
  expect(container.querySelector("output")?.textContent).toBe("Existing draft Dictated detail");
});

it("mobile phase3 independently submits a later request while an earlier request remains incomplete", async () => {
  const secondRequestId = ApprovalRequestId.make("inline-screen-second-submit");
  fixture.activities = [
    requestActivity(),
    {
      ...requestActivity(),
      id: EventId.make("inline-screen-second-submit-activity"),
      createdAt: "2026-09-23T10:00:01.000Z",
      payload: { requestId: secondRequestId, responseMode: "message", questions },
    },
  ];
  await mount();
  await type(answerInputs()[0]!, "First draft");
  await type(answerInputs()[2]!, "Second runtime");
  await type(answerInputs()[3]!, "Second scope");
  const submits = Array.from(conversation().querySelectorAll<HTMLButtonElement>("button")).filter(
    (node) => node.textContent === "Submit answers",
  );
  expect(submits[0]!.disabled).toBe(true);
  expect(submits[1]!.disabled).toBe(false);
  await act(async () => submits[1]!.click());
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      threadId,
      requestId: secondRequestId,
      answers: { runtime: "Second runtime", scope: "Second scope" },
    },
  });
  expect(answerInputs()[0]!.value).toBe("First draft");
});

it.each(["thread", "environment"])(
  "mobile phase3 preserves separate answer drafts when the same request ID appears in another %s",
  async (scope) => {
    await mount();
    await chooseGo();
    await type(answerInputs()[0]!, "Original note");
    const original = fixture.selectedThread;
    fixture.selectedThread =
      scope === "thread"
        ? { ...original, id: "other-draft-thread" }
        : { ...original, environmentId: "other-draft-environment" };
    await mount();
    expect(answerInputs()[0]!.value).toBe("");
    await type(answerInputs()[0]!, "Other note");
    fixture.selectedThread = original;
    await mount();
    expect(answerInputs()[0]!.value).toBe("Original note");
    await type(answerInputs()[1]!, "Original scope");
    await press("Submit answers");
    expect(submittedAnswers()).toEqual({
      runtime: [" go ", "Original note"],
      scope: "Original scope",
    });
  },
);

it.each([false, true])(
  "mobile phase3 P1-1 keeps feed rows unchanged on unrelated composer and upload writes with pending=%s",
  async (pending) => {
    if (!pending) fixture.activities = [];
    fixture.messages = [
      {
        id: MessageId.make("regression-existing-message"),
        turnId: null,
        role: "user",
        text: "Existing conversation row",
        streaming: false,
        createdAt: "2026-09-23T09:00:00.000Z",
        updatedAt: "2026-09-23T09:00:00.000Z",
      },
    ];
    await mount();
    expect(conversation().textContent).toContain("Existing conversation row");
    const renders = fixture.feedRowRenders.mock.calls.length;
    const listRenders = fixture.feedRenders.mock.calls.length;
    expect(renders).toBeGreaterThan(0);
    expect(listRenders).toBeGreaterThan(0);
    for (const text of ["a", "ab", "abc"]) {
      await act(async () =>
        appAtomRegistry.set(composerDraftsAtom, {
          ...appAtomRegistry.get(composerDraftsAtom),
          ordinaryComposer: { text, attachments: [] },
        }),
      );
      await act(async () =>
        appAtomRegistry.set(composerAttachmentUploadsAtom, {
          unrelated: { status: "uploading", progress: text.length / 4 },
        }),
      );
    }
    expect(fixture.feedRowRenders.mock.calls.length).toBe(renders);
    expect(fixture.feedRenders.mock.calls.length).toBe(listRenders);
    if (pending) {
      await type(answerInputs()[0]!, "Card-local note");
      expect(answerInputs()[0]!.value).toBe("Card-local note");
      expect(fixture.feedRowRenders.mock.calls.length).toBe(renders);
    }
  },
);

it.each(["idle", "recording", "transcribing"])(
  "mobile phase3 P2-1 transfers the only visible voice target between requests while %s",
  async (phase) => {
    fixture.activities = [
      requestActivity(),
      {
        ...requestActivity(),
        id: EventId.make("voice-second-activity"),
        createdAt: "2026-09-23T10:00:01.000Z",
        payload: { requestId: "voice-second-request", responseMode: "message", questions },
      },
    ];
    const transcript = deferred<string>();
    fixture.transcribe.mockReturnValue(transcript.promise);
    await mount();
    await act(async () => answerInputs()[0]!.focus());
    if (phase !== "idle") await press("Start dictation");
    // Phase 7: the server path's round stop is labelled "Stop dictation".
    if (phase === "transcribing") await press("Stop dictation");
    await act(async () => answerInputs()[2]!.focus());
    expect(container.textContent?.match(/Voice answer:/g)).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Start dictation"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Stop dictation"]')).toBeNull();
    if (phase === "transcribing") await act(async () => transcript.resolve("Late first answer"));
    expect(answerInputs().map((input) => input.value)).toEqual(["", "", "", ""]);
    await press("Start dictation");
    expect(button("Stop dictation")).toBeDefined();
    await press("Cancel dictation");
  },
);

it("mobile phase3 P3-2 opens usage limits from the separate composer while questions are pending", async () => {
  await mount();
  fixture.usageReport = { createdAt: "2026-09-23T10:00:00.000Z" };
  await press("Show usage limits");
  expect(container.textContent).toContain("Usage limits report");
  expect(conversation().textContent).toContain("Which runtime?");
});

it("mobile phase3 regression submits question attachments under their original IDs and retains them after failure", async () => {
  seedAttachment("runtime", "ready");
  seedAttachment("scope", "ready");
  await mount();
  expect(button("Submit answers").disabled).toBe(false);
  const response = deferred<{ _tag: string; value: undefined }>();
  fixture.respond.mockReturnValueOnce(response.promise);
  await press("Submit answers");
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: expect.objectContaining({
      threadId,
      requestId,
      attachmentsByQuestionId: {
        runtime: [
          {
            type: "file",
            id: "runtime-uploaded",
            name: "runtime.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ],
        scope: [
          {
            type: "file",
            id: "scope-uploaded",
            name: "scope.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ],
      },
    }),
  });
  await act(async () => response.resolve({ _tag: "Failure", value: undefined }));
  expect(container.querySelector('[aria-label="Open runtime.txt"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Open scope.txt"]')).not.toBeNull();
  expect(button("Submit answers").disabled).toBe(false);
  await press("Submit answers");
  expect(fixture.respond.mock.calls[1]).toEqual(fixture.respond.mock.calls[0]);
});

it("mobile phase3 repair AC4 reveals the measured answer above keyboard and composer without resetting list offset", async () => {
  fixture.geometry = true;
  await mount();
  await act(async () => answerInputs()[0]!.focus());
  expect(fixture.scrollToOffset).not.toHaveBeenCalled();
  fixture.keyboardHeight = 320;
  await act(async () => fixture.keyboardShown?.());
  // The screen supplies its real composer reserve to the list.
  const call = fixture.scrollToOffset.mock.calls.at(-1)![0];
  expect(call.animated).toBe(false);
  expect(fixture.composerInset).toBeGreaterThan(0);
  expect(call.offset).toBe(262 + fixture.composerInset);
  const visibleInputBottom = fixture.inputY + 60 - (call.offset - fixture.scrollOffset);
  expect(visibleInputBottom).toBe(468 - fixture.composerInset);
  fixture.scrollToOffset.mockClear();
  fixture.inputY = 100;
  await act(async () => fixture.keyboardShown?.());
  expect(fixture.scrollToOffset).not.toHaveBeenCalled();
  await act(async () => answerInputs()[0]!.blur());
  fixture.inputY = 470;
  await act(async () => fixture.keyboardShown?.());
  expect(fixture.scrollToOffset).not.toHaveBeenCalled();
});

// Factory plan card (phase 3 of factory-in-chat). The emulator alone shows the
// card's look and that Back restores the feed's scroll position; these pin the
// card's content, its Open action and that opening it leaves the feed alone.
import {
  FACTORY_PLAN_DIGEST,
  makeFactoryPlanActivity,
  readFactoryPlanFixture,
} from "../factory/factoryPlan.test-support";

const factoryPlanId = "factory-plan:plan-md";
function showFactoryPlan() {
  fixture.activities = [
    makeFactoryPlanActivity({ id: factoryPlanId, createdAt: "2026-09-23T10:00:00.000Z" }),
  ];
  fixture.factorySnapshots = { [FACTORY_PLAN_DIGEST]: readFactoryPlanFixture() };
}
function factoryPlanCard() {
  const row = conversation().querySelector<HTMLElement>(`[data-feed-row="${factoryPlanId}"]`);
  expect(row, "Expected the plan's own feed row").not.toBeNull();
  return row!;
}
function factoryPlanOpenButton() {
  const open = Array.from(factoryPlanCard().querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent?.trim() === "Open" || node.getAttribute("aria-label") === "Open",
  );
  expect(open, "Expected the plan card's Open button").toBeDefined();
  return open!;
}

it("factory plan card shows the title, the Context section and one line per phase in the Android feed", async () => {
  showFactoryPlan();
  await mount();
  const text = factoryPlanCard().textContent ?? "";
  expect(text).toContain("Plan: the Software Factory inside Mesura Code");
  expect(text).toContain(
    "Mesura Code is the app the developer uses every day to direct coding agents",
  );
  expect(text).toContain("Snapshot a plan and present it to the thread · 8 criteria");
  expect(text).toContain("Render the plan card and the Factory pane on the web · 1 criterion");
  // Only the Context section renders inline: not the next section's body.
  expect(text).not.toContain("The planning skill writes three files");
  // Never a work-log row: the activity's summary is not shown anywhere.
  expect(conversation().textContent).not.toContain("Presented a plan");
});

it("factory plan card Open navigates to the thread's Factory screen for that plan", async () => {
  showFactoryPlan();
  await mount();
  await act(async () => factoryPlanOpenButton().click());
  expect(fixture.navigation.navigate).toHaveBeenCalledExactlyOnceWith("ThreadFactory", {
    environmentId: "inline-screen-environment",
    threadId: "inline-screen-thread",
    planId: factoryPlanId,
  });
});

it("factory plan card Open pushes the Factory screen above the feed without moving or replacing it", async () => {
  fixture.geometry = true;
  showFactoryPlan();
  await mount();
  await act(async () => factoryPlanOpenButton().click());
  expect(fixture.navigation.navigate).toHaveBeenCalledOnce();
  for (const method of ["push", "replace", "reset", "dispatch", "goBack"] as const) {
    expect(fixture.navigation[method], method).not.toHaveBeenCalled();
  }
  expect(fixture.scrollToOffset).not.toHaveBeenCalled();
  expect(factoryPlanCard().textContent).toContain("Plan: the Software Factory inside Mesura Code");
});

// Routes and Approve on the plan card (phase 4 of factory-in-chat). The
// provider model lists arrive as the screen's `serverConfig`; Approve queues
// one message through the thread outbox. The emulator alone shows the lists'
// look and the budget field's keyboard.
import {
  FACTORY_DEFAULT_TEST_ROUTES,
  FACTORY_OTHER_PLAN_DIGEST,
  FACTORY_REVISED_PLAN_DIGEST,
  makeFactoryRouteProviders,
  readFactoryApprovalMessage,
  writeFactoryApprovalMessage,
} from "@t3tools/client-runtime/factory/testing";
import type { ServerProvider } from "@t3tools/contracts";
import { makeFactoryPlanPayload } from "../factory/factoryPlan.test-support";

const factoryPlan = makeFactoryPlanPayload();
const ROUTE_ROLES = ["Implementer", "Reviewer", "Verifier"] as const;
const LEVEL_LABELS = new Set(["Low", "Medium", "High", "Extra High", "Max"]);

function showFactoryPlanWithProviders(
  providers: ReadonlyArray<ServerProvider> = makeFactoryRouteProviders(),
) {
  showFactoryPlan();
  fixture.serverConfig = {
    environment: {
      capabilities: {
        questionAttachments: true,
        attachmentUploads: true,
        fileAttachments: { maxUploadBytes: 1048576 },
      },
    },
    providers,
    usageLimitSources: [],
  };
  fixture.configs.set(environmentId, fixture.serverConfig);
}
function showApprovals(texts: ReadonlyArray<string>) {
  fixture.messages = texts.map((text, index) => ({
    id: MessageId.make(`factory-approval-${index}`),
    role: "user" as const,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-09-23T10:00:01.000Z",
    updatedAt: "2026-09-23T10:00:01.000Z",
  }));
}
function cardButton(label: string): HTMLButtonElement | undefined {
  return Array.from(factoryPlanCard().querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
}
function requireCardButton(label: string): HTMLButtonElement {
  const match = cardButton(label);
  expect(match, `Expected ${label}; card: ${factoryPlanCard().textContent}`).toBeDefined();
  return match!;
}
const isRouteControl = (node: Element) =>
  /^(Implementer|Reviewer|Verifier) (model|reasoning)$/.test(node.getAttribute("aria-label") ?? "");
/** The choices an open list shows: model names or level labels, outside the row controls. */
function listedChoices(kind: "model" | "level"): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((node) => {
    if (isRouteControl(node)) return false;
    const text = node.textContent?.trim() ?? "";
    return kind === "model" ? /^(Claude|GPT)/.test(text) : LEVEL_LABELS.has(text);
  });
}
async function openChoices(label: string, kind: "model" | "level") {
  await act(async () => requireCardButton(label).click());
  return listedChoices(kind).map((node) => node.textContent?.trim() ?? "");
}
async function chooseRoute(label: string, choice: string) {
  await act(async () => requireCardButton(label).click());
  const option = listedChoices(label.endsWith(" model") ? "model" : "level").find(
    (node) => node.textContent?.trim() === choice,
  );
  expect(option, `Expected ${label} to list ${choice}`).toBeDefined();
  await act(async () => option!.click());
}
function budgetField() {
  return factoryPlanCard().querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Implementer budget"]',
  );
}
async function approveOnPhone() {
  const approveControl = requireCardButton("Approve");
  expect(approveControl.disabled).toBe(false);
  await act(async () => approveControl.click());
  expect(fixture.enqueue).toHaveBeenCalledOnce();
  return fixture.enqueue.mock.calls[0]![0] as {
    environmentId: string;
    threadId: string;
    text: string;
    modelSelection?: unknown;
    runtimeMode?: string;
  };
}

it("mobile phase4 AC1 ends the plan card with implementer, reviewer and verifier rows showing the defaults", async () => {
  showFactoryPlanWithProviders();
  await mount();
  const card = factoryPlanCard();
  const lastPhase = Array.from(card.querySelectorAll("span")).find(
    (node) =>
      node.textContent === "Render the plan card and the Factory pane on the web · 1 criterion",
  );
  expect(lastPhase).toBeDefined();
  let previous: Element = lastPhase!;
  for (const role of ROUTE_ROLES) {
    const model = requireCardButton(`${role} model`);
    const level = requireCardButton(`${role} reasoning`);
    expect(previous.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toContain(role);
    previous = level;
  }
  // Criterion 2 through the card: newest Opus at high, Sol at high, Luna at max.
  expect(requireCardButton("Implementer model").textContent).toContain("Claude Opus 5.5");
  expect(requireCardButton("Reviewer model").textContent).toContain("GPT-6 Sol");
  expect(requireCardButton("Verifier model").textContent).toContain("GPT-6 Luna");
  expect(requireCardButton("Implementer reasoning").textContent).toContain("High");
  expect(requireCardButton("Reviewer reasoning").textContent).toContain("High");
  expect(requireCardButton("Verifier reasoning").textContent).toContain("Max");
  expect(requireCardButton("Approve").disabled).toBe(false);
});

it("mobile phase4 AC3 gives a Claude implementer an editable 25 dollar budget and queues the edited amount", async () => {
  showFactoryPlanWithProviders();
  await mount();
  expect(budgetField()?.value).toBe("25");
  await type(budgetField()!, "40");
  const queued = await approveOnPhone();
  expect(readFactoryApprovalMessage(queued.text).routes).toEqual({
    ...FACTORY_DEFAULT_TEST_ROUTES,
    implementer: { ...FACTORY_DEFAULT_TEST_ROUTES.implementer, budgetUsd: 40 },
  });
});

it("mobile phase4 AC4 lists only Codex models for the verifier and the other family for the reviewer", async () => {
  showFactoryPlanWithProviders();
  await mount();
  const verifier = await openChoices("Verifier model", "model");
  expect(verifier.length).toBeGreaterThan(0);
  expect(
    verifier.every((name) => name.startsWith("GPT")),
    verifier.join(", "),
  ).toBe(true);
  await chooseRoute("Implementer model", "GPT-6 Sol");
  expect(requireCardButton("Reviewer model").textContent).toContain("Claude Opus 5.5");
  expect(budgetField()).toBeNull();
  const reviewer = await openChoices("Reviewer model", "model");
  expect(reviewer.length).toBeGreaterThan(0);
  expect(
    reviewer.every((name) => name.startsWith("Claude")),
    reviewer.join(", "),
  ).toBe(true);
});

it("mobile phase4 AC5 shows a role without a model as unavailable with the reason and keeps Approve disabled", async () => {
  showFactoryPlanWithProviders(
    makeFactoryRouteProviders({ codex: [{ slug: "gpt-6-sol", name: "GPT-6 Sol" }] }),
  );
  await mount();
  const text = factoryPlanCard().textContent ?? "";
  expect(text).toMatch(/unavailable/i);
  expect(text).toMatch(/luna/i);
  const approveControl = requireCardButton("Approve");
  expect(approveControl.disabled).toBe(true);
  await act(async () => approveControl.click());
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("mobile phase4 AC6 queues one approval message with the digest line, the routes block and the thread's model", async () => {
  showFactoryPlanWithProviders();
  await mount();
  await chooseRoute("Verifier reasoning", "Extra High");
  const queued = await approveOnPhone();
  expect(queued.environmentId).toBe(environmentId);
  expect(queued.threadId).toBe(threadId);
  const message = readFactoryApprovalMessage(queued.text);
  expect(message.firstLine).toBe(`Approve plan sha256:${FACTORY_PLAN_DIGEST}`);
  expect(queued.text).toContain(`Plan: ${factoryPlan.planPath}`);
  expect(queued.text).toContain(`Intent: ${factoryPlan.intentPath}`);
  expect(message.routes).toEqual({
    ...FACTORY_DEFAULT_TEST_ROUTES,
    verifier: { ...FACTORY_DEFAULT_TEST_ROUTES.verifier, effort: "xhigh" },
  });
  expect(queued.modelSelection).toEqual(selectedThread.modelSelection);
  expect(queued.runtimeMode).toBe("full-access");
  expect(fixture.send).not.toHaveBeenCalled();
});

const phoneApprovedRoutes = {
  ...FACTORY_DEFAULT_TEST_ROUTES,
  reviewer: { harness: "codex" as const, model: "gpt-6-astra", effort: "xhigh" },
};

it("mobile phase4 AC7 shows the approved routes read-only and hides Approve for the approved digest", async () => {
  showFactoryPlanWithProviders();
  showApprovals([
    writeFactoryApprovalMessage({
      digest: FACTORY_PLAN_DIGEST,
      planPath: factoryPlan.planPath,
      intentPath: factoryPlan.intentPath,
      routes: phoneApprovedRoutes,
    }),
  ]);
  await mount();
  expect(cardButton("Approve")).toBeUndefined();
  for (const role of ROUTE_ROLES) {
    expect(cardButton(`${role} model`), role).toBeUndefined();
    expect(cardButton(`${role} reasoning`), role).toBeUndefined();
  }
  expect(budgetField()).toBeNull();
  const text = factoryPlanCard().textContent ?? "";
  expect(text).toMatch(/GPT-6 Astra|gpt-6-astra/);
  expect(text).toMatch(/Extra High|xhigh/i);
  expect(text).not.toContain("Changed since approval");
});

it("mobile phase4 AC7 reads Changed since approval with editable rows when the plan changed after approval", async () => {
  showFactoryPlanWithProviders();
  showApprovals([
    writeFactoryApprovalMessage({
      digest: FACTORY_REVISED_PLAN_DIGEST,
      planPath: factoryPlan.planPath,
      intentPath: factoryPlan.intentPath,
      routes: phoneApprovedRoutes,
    }),
  ]);
  await mount();
  expect(factoryPlanCard().textContent).toContain("Changed since approval");
  expect(requireCardButton("Implementer model")).toBeDefined();
  expect(requireCardButton("Approve").disabled).toBe(false);
});

it("mobile phase4 AC7 ignores an approval of another plan file", async () => {
  showFactoryPlanWithProviders();
  showApprovals([
    writeFactoryApprovalMessage({
      digest: FACTORY_OTHER_PLAN_DIGEST,
      planPath: "/home/dev/plans/another-feature/plan.md",
      intentPath: "/home/dev/plans/another-feature/intent.md",
      routes: phoneApprovedRoutes,
    }),
  ]);
  await mount();
  expect(factoryPlanCard().textContent).not.toContain("Changed since approval");
  expect(requireCardButton("Approve").disabled).toBe(false);
});

it("mobile phase4 guard sends the composer's own message beside a plan card without queueing an approval", async () => {
  showFactoryPlanWithProviders();
  await mount();
  await type(container.querySelector('[aria-label="Message"]')!, "A normal follow-up");
  await press("Send message");
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(factoryPlanCard().textContent).toContain("Plan: the Software Factory inside Mesura Code");
});

it("mobile phase4 decision 4 shows an approval without routes as approved with sf-team choosing them", async () => {
  showFactoryPlanWithProviders();
  showApprovals([
    `Approve plan sha256:${FACTORY_PLAN_DIGEST}\nPlan: ${factoryPlan.planPath}\nBuild it with sf-team.`,
  ]);
  await mount();
  expect(cardButton("Approve")).toBeUndefined();
  expect(cardButton("Implementer model")).toBeUndefined();
  expect(factoryPlanCard().textContent).toMatch(/routes chosen by sf-team/i);
});

it("mobile phase4 decision 5 keeps Approve disabled while the message is queued", async () => {
  let release: () => void = () => undefined;
  fixture.enqueue.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  showFactoryPlanWithProviders();
  await mount();
  await act(async () => requireCardButton("Approve").click());
  expect(fixture.enqueue).toHaveBeenCalledOnce();
  expect(requireCardButton("Approve").disabled).toBe(true);
  await act(async () => requireCardButton("Approve").click());
  expect(fixture.enqueue).toHaveBeenCalledOnce();
  await act(async () => release());
  expect(requireCardButton("Approve").disabled).toBe(true);
});

it("mobile phase4 decision 5 enables Approve again when the outbox refuses the message", async () => {
  fixture.enqueue.mockRejectedValueOnce(new Error("disk full"));
  showFactoryPlanWithProviders();
  await mount();
  await act(async () => requireCardButton("Approve").click());
  await vi.waitFor(() => expect(requireCardButton("Approve").disabled).toBe(false));
  expect(fixture.enqueue).toHaveBeenCalledOnce();
});

it("mobile phase4 decision 5 reads an Approve waiting in the outbox as approved", async () => {
  showFactoryPlanWithProviders();
  fixture.queuedMessages = [
    {
      environmentId,
      threadId,
      messageId: MessageId.make("queued-approval"),
      commandId: "queued-approval-command",
      text: writeFactoryApprovalMessage({
        digest: FACTORY_PLAN_DIGEST,
        planPath: factoryPlan.planPath,
        intentPath: factoryPlan.intentPath,
        routes: phoneApprovedRoutes,
      }),
      attachments: [],
      createdAt: "2026-09-23T10:00:02.000Z",
    },
  ];
  await mount();
  expect(cardButton("Approve")).toBeUndefined();
  expect(factoryPlanCard().textContent).toMatch(/GPT-6 Astra/);
});

it("mobile phase4 P1-1 disables Approve when an edited route's provider is turned off", async () => {
  showFactoryPlanWithProviders();
  await mount();
  await chooseRoute("Reviewer model", "GPT-6 Astra");
  expect(requireCardButton("Approve").disabled).toBe(false);
  showFactoryPlanWithProviders(makeFactoryRouteProviders({ codexProvider: { enabled: false } }));
  await mount();
  expect(factoryPlanCard().textContent).toMatch(/Codex is turned off/);
  expect(requireCardButton("Approve").disabled).toBe(true);
  await act(async () => requireCardButton("Approve").click());
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("mobile phase4 P1-4 says an approval's unreadable routes block could not be read", async () => {
  showFactoryPlanWithProviders();
  showApprovals([
    [
      `Approve plan sha256:${FACTORY_PLAN_DIGEST}`,
      `Plan: ${factoryPlan.planPath}`,
      "Build it with sf-team in this thread, with these routes:",
      "```json",
      "{ not json",
      "```",
    ].join("\n"),
  ]);
  await mount();
  expect(cardButton("Approve")).toBeUndefined();
  expect(factoryPlanCard().textContent).toContain("The approval's routes block could not be read.");
});

it("mobile phase4 verify2 re-validates a mounted card's edited route when only the provider list changes", async () => {
  showFactoryPlanWithProviders();
  await mount();
  await chooseRoute("Reviewer model", "GPT-6 Astra");
  expect(requireCardButton("Approve").disabled).toBe(false);
  // Only the server config changes, as when Codex is turned off in Settings:
  // the feed's entries stay the same objects.
  fixture.serverConfig = {
    ...(fixture.serverConfig as object),
    providers: makeFactoryRouteProviders({ codexProvider: { enabled: false } }),
  };
  await mount();
  expect(factoryPlanCard().textContent).toMatch(/Codex is turned off/);
  expect(requireCardButton("Approve").disabled).toBe(true);
  // And back: turning Codex on again restores the edited route.
  fixture.serverConfig = {
    ...(fixture.serverConfig as object),
    providers: makeFactoryRouteProviders(),
  };
  await mount();
  expect(requireCardButton("Reviewer model").textContent).toContain("GPT-6 Astra");
  expect(requireCardButton("Approve").disabled).toBe(false);
});

// Run card (phase 8 of factory-in-chat): acceptance criteria 3, 5 and 6 on
// Android, through the same ThreadDetailScreen entry point. A new activity
// with the run's id replaces the old one, as the server's run tracker does.
// The emulator alone shows the tones' colours and the phase marks' shapes.
import { factoryRunActivityId } from "@t3tools/contracts";
import {
  makeFactoryRunActivityAt,
  type FactoryRunFixturePoint,
} from "../factory/factoryRun.test-support";

const factoryRunRowId = factoryRunActivityId(threadId, "invoice-csv-export");
function showFactoryRunAt(point: FactoryRunFixturePoint) {
  fixture.messages = [
    {
      id: MessageId.make("factory-run-approve"),
      role: "user" as const,
      text: "Build the approved plan",
      turnId: null,
      streaming: false,
      createdAt: "2026-09-28T08:58:00.000Z",
      updatedAt: "2026-09-28T08:58:00.000Z",
    },
  ] as typeof fixture.messages;
  fixture.activities = [
    {
      id: EventId.make("factory-run-coordinator-command"),
      kind: "tool.completed",
      tone: "tool",
      summary: "Ran command",
      createdAt: "2026-09-28T09:30:00.000Z",
      turnId: null,
      payload: { title: "Ran command", itemType: "command_execution", status: "completed" },
    },
    makeFactoryRunActivityAt({ threadId, point }),
  ];
}
function factoryRunCard() {
  const row = conversation().querySelector<HTMLElement>(`[data-feed-row="${factoryRunRowId}"]`);
  expect(
    row,
    `Expected the run's own feed row; feed: ${conversation().textContent}`,
  ).not.toBeNull();
  return row!;
}

it("phase8 android AC5 renders the run card in the feed with its request, status, phase, node, returns and cost", async () => {
  showFactoryRunAt("verify");
  await mount();
  const text = factoryRunCard().textContent ?? "";

  expect(text).toContain("Let accountants export the invoice list as a CSV file");
  expect(text).toContain("phase 1/2 · Verify ①");
  expect(text).toContain("Serialize the filtered invoice list as CSV");
  expect(text).toContain("1/5 returns");
  expect(text).toContain("$10.03");
  // Live: the last row of the feed, below the coordinator's newest command.
  const rows = Array.from(conversation().querySelectorAll<HTMLElement>("[data-feed-row]"));
  expect(rows.at(-1)).toBe(factoryRunCard());
  // Never a work-log row: the activity's summary is not shown anywhere.
  expect(conversation().textContent).not.toContain("Software Factory run");
});

it("phase8 android AC3 shows the stop question on the run card and reads waiting", async () => {
  showFactoryRunAt("waiting");
  await mount();
  const text = factoryRunCard().textContent ?? "";

  expect(text).toContain("waiting");
  expect(text).toContain("Name the file after the filter range or after the export date?");
});

it("phase8 android AC6 updates the run card in place as events arrive without remounting its feed row", async () => {
  showFactoryRunAt("verify");
  await mount();
  const row = factoryRunCard();
  const card = row.firstElementChild;
  expect(card).not.toBeNull();

  fixture.activities = [
    ...fixture.activities.filter((activity) => activity.id !== factoryRunRowId),
    makeFactoryRunActivityAt({ threadId, point: "review" }),
  ];
  await mount();
  expect(factoryRunCard()).toBe(row);
  expect(row.firstElementChild).toBe(card);
  expect(row.textContent).toContain("phase 1/2 · Review");

  fixture.activities = [
    ...fixture.activities.filter((activity) => activity.id !== factoryRunRowId),
    makeFactoryRunActivityAt({ threadId, point: "waiting" }),
  ];
  await mount();
  expect(factoryRunCard()).toBe(row);
  expect(row.firstElementChild).toBe(card);
  expect(row.textContent).toContain(
    "Name the file after the filter range or after the export date?",
  );
});

it("phase8 android run card of a summary without phase marks renders without marks", async () => {
  showFactoryRunAt("verify");
  fixture.activities = [
    ...fixture.activities.filter((activity) => activity.id !== factoryRunRowId),
    makeFactoryRunActivityAt({ threadId, point: "verify", withoutMarks: true }),
  ];
  await mount();
  const text = factoryRunCard().textContent ?? "";

  expect(text).toContain("phase 1/2 · Verify ①");
  expect(text).toContain("Let accountants export the invoice list as a CSV file");
  expect(text).not.toContain("✓1");
  // With marks, the same run shows one mark per phase.
  showFactoryRunAt("answered");
  await mount();
  expect(factoryRunCard().textContent).toContain("✓1");
});

// Run card Open (phase 10 of factory-in-chat, criterion 1): the card opens the
// thread's Factory screen on its Run tab, for this run, above the feed. The
// screen it opens is mounted in `FactoryRouteScreen.test.tsx`.
function factoryRunOpenButton() {
  const open = Array.from(factoryRunCard().querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent?.trim() === "Open" || node.getAttribute("aria-label") === "Open",
  );
  expect(
    open,
    `Expected the run card's Open button; card: ${factoryRunCard().textContent}`,
  ).toBeDefined();
  return open!;
}

it("phase10 android AC1 run card Open navigates to the Run tab of the thread's Factory screen for that run", async () => {
  showFactoryRunAt("verify");
  await mount();
  await act(async () => factoryRunOpenButton().click());
  expect(fixture.navigation.navigate).toHaveBeenCalledExactlyOnceWith("ThreadFactory", {
    environmentId: "inline-screen-environment",
    threadId: "inline-screen-thread",
    tab: "run",
    runId: "invoice-csv-export",
  });
});

it("phase10 android AC1 run card Open pushes the Factory screen above the feed without moving or replacing it", async () => {
  fixture.geometry = true;
  showFactoryRunAt("verify");
  await mount();
  await act(async () => factoryRunOpenButton().click());
  expect(fixture.navigation.navigate).toHaveBeenCalledOnce();
  for (const method of ["push", "replace", "reset", "dispatch", "goBack"] as const) {
    expect(fixture.navigation[method], method).not.toHaveBeenCalled();
  }
  expect(fixture.scrollToOffset).not.toHaveBeenCalled();
  expect(factoryRunCard().textContent).toContain("phase 1/2 · Verify ①");
});

// Report card (phase 11 of factory-in-chat, criteria 1 and 6 on Android):
// the report a run wrote is a card in the feed with its Context, its What was
// built bullets, the coverage and the degraded count, and Open lands on the
// Factory screen's Report tab. The body is the `factoryReadSnapshot` answer
// for the activity's digest; the numbers come from the run stream's state.
// The screen it opens is mounted in `FactoryRouteScreen.test.tsx`.
import {
  FACTORY_REPORT_DIGEST,
  makeFactoryReportActivity,
  makeFactoryRunState,
} from "@t3tools/client-runtime/factory/testing";
import { factoryReportActivityId } from "@t3tools/contracts";

import {
  readFactoryReportFixture,
  readFactoryRunEventsFixture,
} from "../factory/factoryRun.test-support";

const factoryReportRowId = factoryReportActivityId(threadId, "invoice-csv-export");
function showFactoryReport(
  point: FactoryRunFixturePoint = "degraded",
  markdown: string = readFactoryReportFixture(),
) {
  showFactoryRunAt(point);
  fixture.activities = [...fixture.activities, makeFactoryReportActivity({ threadId })];
  fixture.factorySnapshots = { [FACTORY_REPORT_DIGEST]: markdown };
  // The stream would answer, but a card must not ask: its numbers are the run's activity.
  fixture.factoryRunItem = {
    state: makeFactoryRunState(readFactoryRunEventsFixture(), point),
    roles: [],
  };
}
/** Run streams the feed opened: a card on screen must open none. */
const openedRunStreams = () => fixture.factoryRunAtoms.size;
function factoryReportCard() {
  const row = conversation().querySelector<HTMLElement>(`[data-feed-row="${factoryReportRowId}"]`);
  expect(
    row,
    `Expected the report's own feed row; feed: ${conversation().textContent}`,
  ).not.toBeNull();
  return row!;
}

it("phase11 android AC1 renders the report card in the feed with its Context, What was built bullets, coverage and degraded count", async () => {
  showFactoryReport();
  await mount();
  const text = factoryReportCard().textContent ?? "";

  expect(text).toContain("Accountants close each month from the invoice list");
  expect(text).toContain("Export the invoices the current filter shows as a CSV file.");
  expect(text).toContain("Keep every amount with two decimals and its invoice currency.");
  expect(text).toContain(
    "Download the file from an Export button on the invoices page, named after the export date.",
  );
  expect(text).toContain("4/5 criteria passed");
  expect(text).toContain("1 degraded phase");
  expect(text).not.toContain("The export is one endpoint beside the list endpoint");
  expect(factoryReportCard()).not.toBe(factoryRunCard());
  expect(openedRunStreams()).toBe(0);
});

it("phase11 android AC6 report card reads coverage and degraded count from the run state, not from report.md", async () => {
  showFactoryReport(
    "done",
    readFactoryReportFixture().replace(
      "Accountants close each month from the invoice list",
      "Every one of the 5 criteria passed and 2 phases degraded. Accountants close each month from the invoice list",
    ),
  );
  await mount();
  const text = factoryReportCard().textContent ?? "";

  expect(text).toContain("4/5 criteria passed");
  expect(text).toContain("0 degraded phases");
  expect(openedRunStreams()).toBe(0);
});

it("phase11 android AC1 report card Open navigates to the Report tab of the thread's Factory screen for that run", async () => {
  showFactoryReport();
  await mount();
  const open = Array.from(factoryReportCard().querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent?.trim() === "Open" || node.getAttribute("aria-label") === "Open",
  );
  expect(
    open,
    `Expected the report card's Open; card: ${factoryReportCard().textContent}`,
  ).toBeDefined();
  await act(async () => open!.click());
  expect(fixture.navigation.navigate).toHaveBeenCalledExactlyOnceWith("ThreadFactory", {
    environmentId: "inline-screen-environment",
    threadId: "inline-screen-thread",
    tab: "report",
    runId: "invoice-csv-export",
  });
});

it("phase11 android review P1-1 report card keeps its degraded count when the run's summary lost its phase marks", async () => {
  showFactoryReport();
  fixture.activities = [
    ...fixture.activities.filter((activity) => activity.id !== factoryRunRowId),
    makeFactoryRunActivityAt({ threadId, point: "degraded", withoutMarks: true }),
  ];
  await mount();
  const text = factoryReportCard().textContent ?? "";

  expect(text).toContain("1 degraded phase");
  expect(text).toContain("4/5 criteria passed");
  expect(openedRunStreams()).toBe(0);
});
