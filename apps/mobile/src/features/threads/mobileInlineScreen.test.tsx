// @vitest-environment happy-dom
// Entry point: ThreadDetailScreen with real ThreadFeed, PendingUserInputCard,
// QuestionAttachments, request state, attachment strip, and thread-work-log.
// Native hosts use DOM controls. Geometry tests cover keyboard ownership and
// scroll routing; physical keyboard occlusion still requires device verification.
import { act, useState, useImperativeHandle, useRef, type Ref } from "react";
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
vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: ({
    ref,
    data,
    renderItem,
    ListHeaderComponent,
  }: {
    ref?: Ref<unknown>;
    data: ReadonlyArray<{ id: string }>;
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
              {renderItem({ item, index })}
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
  useNavigation: () => ({ navigate: vi.fn() }),
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
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#333333" }),
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
vi.mock("../review/ReviewCommentCard", () => ({
  ReviewCommentCard: () => null,
  useReviewCommentColors: () => ({}),
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
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToUserInput: "respond", dismissUserInput: "dismiss" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "respond" ? fixture.respond : fixture.dismiss),
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
  latestTurn: null,
  latestUserMessageAt: null,
};
function ScreenHarness() {
  const requests = useSelectedThreadRequests();
  const [draftMessage, setDraftMessage] = useState("");
  const props = {
    ...requests,
    selectedThread: {
      ...selectedThread,
      id: ThreadId.make(fixture.selectedThread.id),
      environmentId: EnvironmentId.make(fixture.selectedThread.environmentId),
    },
    environmentId: EnvironmentId.make(fixture.selectedThread.environmentId),
    selectedThreadFeed: buildThreadFeed({
      messages: fixture.messages,
      activities: fixture.activities,
    }),
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
    queuedMessages: [],
    dispatchingMessageId: null,
    selectedThreadQueueCount: 0,
    serverConfig: null,
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
  await press("Finish dictation");
  expect(answerInputs()[0]!.value).toContain("Typed detail");
  expect(answerInputs()[0]!.value).toContain("Dictated detail");
  expect(fixture.respond).not.toHaveBeenCalled();
  const note = answerInputs()[0]!.value;
  await type(answerInputs()[1]!, "API only");
  await press("Submit answers");
  expect(submittedAnswers()).toEqual({ runtime: [" go ", note], scope: "API only" });
});
it.each(["question", "thread", "request", "environment"])(
  "mobile phase3 AC5 never delivers late transcription to another %s target",
  async (switchTarget) => {
    const transcript = deferred<string>();
    const entered = deferred<void>();
    fixture.transcribe.mockImplementation(async () => {
      entered.resolve();
      return transcript.promise;
    });
    await mount();
    await type(answerInputs()[0]!, "Original draft");
    await focusQuestion(0);
    expect(container.querySelectorAll('[aria-label="Start dictation"]')).toHaveLength(1);
    await press("Start dictation");
    expect(fixture.record).toHaveBeenCalledOnce();
    await press("Finish dictation");
    await entered.promise;
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
    await act(async () => {
      transcript.resolve("Late transcript");
      await transcript.promise;
    });
    expect(destinationValues()).toEqual(destinationBefore);
    expect(fixture.respond).not.toHaveBeenCalled();
  },
);

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
    if (phase === "transcribing") await press("Finish dictation");
    await act(async () => answerInputs()[2]!.focus());
    expect(container.textContent?.match(/Voice answer:/g)).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Start dictation"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Finish dictation"]')).toBeNull();
    if (phase === "transcribing") await act(async () => transcript.resolve("Late first answer"));
    expect(answerInputs().map((input) => input.value)).toEqual(["", "", "", ""]);
    await press("Start dictation");
    expect(button("Finish dictation")).toBeDefined();
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
