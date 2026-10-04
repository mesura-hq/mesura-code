// @vitest-environment happy-dom
// Phase 7 (mobile dictation), coordinator decisions 3 and 5 at the new-task screen.
// Entry point: `NewTaskDraftScreen`, mounted with its real dictation hook and controls.
// Stubbed edges: the new-task flow provider (`useNewTaskFlow`), the native editor, the
// recorder, navigation, and `state/dictation` (`finishDictation` and the sender registry,
// whose own behaviour is pinned in `state/dictation.test.ts`). The outbox write is stubbed
// so the screen's own send can be observed.
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SECRET_SETTING_REDACTION_MARKER,
} from "@t3tools/contracts";

const fixture = vi.hoisted(() => ({
  platform: "android" as "android" | "ios",
  appStateListeners: [] as Array<(state: string) => void>,
  durationMillis: 2_000,
  record: vi.fn(),
  recorderStop: vi.fn(async () => undefined),
  deleteRecording: vi.fn(),
  prepareAppleTranscriber: vi.fn(),
  finishDictation: vi.fn(async (_input: unknown) => ({ jobId: "job-1", status: "started" })),
  senders: new Map<string, () => void>(),
  clone: null as null | { phase: string },
  reportUnsent: vi.fn(),
  enqueue: vi.fn(async (_message: unknown) => undefined),
  prompt: "",
  setPrompt: vi.fn(),
  onChangeDraftMessage: vi.fn(),
  navigation: {
    navigate: vi.fn(),
    dispatch: vi.fn(),
    goBack: vi.fn(),
    setOptions: vi.fn(),
    getParent: () => undefined,
    isFocused: () => true,
    addListener: () => () => undefined,
  },
}));

vi.mock("react-native", () => {
  const View = ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>;
  const Pressable = ({
    children,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={() => onPress?.()}>
      {children}
    </button>
  );
  return {
    View,
    Pressable,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ActivityIndicator: () => null,
    ScrollView: View,
    Alert: { alert: vi.fn() },
    Keyboard: { dismiss: vi.fn() },
    Linking: { openSettings: vi.fn() },
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
    Platform: {
      get OS() {
        return fixture.platform;
      },
      Version: 34,
      select: (options: Record<string, unknown>) => options[fixture.platform],
    },
    AppState: {
      currentState: "active",
      addEventListener: (_type: string, listener: (state: string) => void) => {
        fixture.appStateListeners.push(listener);
        return {
          remove: () => {
            fixture.appStateListeners = fixture.appStateListeners.filter(
              (entry) => entry !== listener,
            );
          },
        };
      },
    },
  };
});
vi.mock("react-native-reanimated", () => {
  const AnimatedView = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    default: {
      View: AnimatedView,
      createAnimatedComponent: () => AnimatedView,
    },
    Easing: {
      out: () => (value: number) => value,
      inOut: () => (value: number) => value,
      cubic: (value: number) => value,
      quad: (value: number) => value,
    },
    FadeOut: { duration: () => ({}) },
    FadeIn: {
      duration: () => ({}),
      delay: () => ({ duration: () => ({ reduceMotion: () => ({}) }) }),
    },
    LinearTransition: { duration: () => ({ reduceMotion: () => ({}) }) },
    ReduceMotion: { System: "system" },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => useState(() => ({ value }))[0],
    withTiming: (value: unknown) => value,
  };
});
vi.mock("@react-navigation/native", () => ({
  CommonActions: { goBack: () => ({ type: "GO_BACK" }) },
  StackActions: {
    push: (name: string) => ({ type: "push", name }),
    replace: (name: string) => ({ type: "replace", name }),
  },
  useNavigation: () => fixture.navigation,
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  usePreventRemove: () => undefined,
}));
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: async () => undefined,
  setIsAudioActiveAsync: async () => undefined,
  useAudioRecorder: () =>
    useState(() => ({
      uri: "file:///tmp/composer-dictation.m4a",
      prepareToRecordAsync: async () => undefined,
      record: fixture.record,
      stop: fixture.recorderStop,
      getStatus: () => ({
        isRecording: true,
        durationMillis: fixture.durationMillis,
        metering: -30,
      }),
    }))[0],
}));
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {
      fixture.deleteRecording();
    }
  },
  Paths: { document: { uri: "file:///tmp" }, cache: { uri: "file:///tmp" } },
}));
vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () =>
    fixture.platform === "ios" ? { prepare: fixture.prepareAppleTranscriber } : null,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));
vi.mock("../../components/ComposerEditor", () => ({
  ComposerEditor: ({
    value,
    readOnly,
    onChangeText,
    onFocus,
  }: {
    value: string;
    readOnly?: boolean;
    onChangeText: (value: string) => void;
    onFocus?: () => void;
  }) => (
    <textarea
      aria-label="Message"
      value={value}
      readOnly={readOnly}
      onFocus={onFocus}
      onChange={(event) => {
        if (!readOnly) onChangeText(event.target.value);
      }}
    />
  ),
}));
vi.mock("../../components/AppText", async () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/GlassSurface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: () => null,
}));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
  ComposerAttachmentThumbnail: () => null,
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerToolbarRow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ComposerInlineControl: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
    <button aria-label={accessibilityLabel} />
  ),
  ComposerActionButton: ({
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
    disabled?: boolean;
  }) => <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress} />,
}));
vi.mock("./ComposerCommandPopover", () => ({ ComposerCommandPopover: () => null }));
vi.mock("./use-composer-command-menu", () => ({
  useComposerCommandMenu: () => ({
    trigger: null,
    items: [],
    isLoading: false,
    error: null,
    skills: [],
    selection: { start: 0, end: 0 },
    onSelectionChange: vi.fn(),
    onSelect: vi.fn(),
  }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ materialYouStyleLayoutActive: false, themeVariables: {} }),
}));
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#808080" }),
}));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  armAgentAwarenessLiveActivityForLocalWork: vi.fn(),
}));
vi.mock("../../state/composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}).pipe(Atom.keepAlive),
    composerAttachmentUploadBlockReason: () => null,
    composerAttachmentsStillUploading: () => false,
  };
});

vi.mock("../../state/dictation", () => ({
  finishDictation: fixture.finishDictation,
  useDictationFailures: () => [],
  retryDictationJob: vi.fn(),
  discardDictationJob: vi.fn(),
  reportDictatedDraftUnsent: fixture.reportUnsent,
  registerDictationDraftSender: (draftKey: string, send: () => void) => {
    fixture.senders.set(draftKey, send);
    return () => fixture.senders.delete(draftKey);
  },
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: async () => undefined },
  KeyboardStickyView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useKeyboardState: (select: (state: { isVisible: boolean }) => unknown) =>
    select({ isVisible: false }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../native/StackHeader", () => ({
  NativeHeaderToolbar: () => null,
  NativeStackScreenOptions: () => null,
}));
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ProjectCloneBanner", () => ({ ProjectCloneBanner: () => null }));
vi.mock("../../lib/useFontFamily", () => ({ useFontFamily: () => "sans-serif" }));
vi.mock("./ThreadComposer", () => ({
  COMPOSER_LAYOUT_TRANSITION: undefined,
  ComposerSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./use-thread-settings-sheet-presentation", () => ({
  useThreadSettingsSheetPresentation: () => ({
    keepsComposerExpanded: false,
    isActive: false,
    isVisible: false,
    open: vi.fn(),
    onDismissed: vi.fn(),
    onStackTransitionsFinished: vi.fn(),
  }),
}));
vi.mock("../../lib/composerImages", () => ({
  composerStripAttachments: () => [],
  convertPastedImagesToAttachments: vi.fn(),
  createPastedTextComposerAttachment: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
  removePersistedComposerAttachmentFile: vi.fn(),
}));
vi.mock("../../state/use-composer-drafts", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerContextImportsAtom: Atom.make({}).pipe(Atom.keepAlive),
    clearComposerDraftContent: vi.fn(),
    captureComposerDraftInsertion: vi.fn(),
    countComposerDraftAttachmentsAfterSelection: () => 0,
    getComposerDraftSnapshot: () => ({ text: fixture.prompt, attachments: [] }),
    mergeComposerDraftContent: vi.fn(),
    restoreComposerDraftSnapshot: vi.fn(),
    updateComposerDraftSettings: vi.fn(),
    scheduleUnusedComposerAttachmentCleanup: vi.fn(),
    waitForComposerDraftsLoaded: async () => undefined,
  };
});
vi.mock("../../state/entities", () => ({
  useProjects: () => [project],
  useEnvironmentServerConfig: () => serverConfig(hostKey.value),
}));
vi.mock("../../state/projectClones", () => ({ useProjectClone: () => fixture.clone }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { delete: Symbol("delete") } }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    cancelProjectClone: Symbol("cancel"),
    retryProjectClone: Symbol("retry"),
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: fixture.enqueue }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId, connectionState: "connected" }],
  }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({
    consumeShare: vi.fn(),
    getShare: () => null,
    isLoading: false,
    releaseShareReservation: vi.fn(),
    reserveShare: vi.fn(),
    pendingShare: null,
  }),
}));
vi.mock("./new-task-flow-provider", () => ({ useNewTaskFlow: () => flowFixture() }));

const environmentId = EnvironmentId.make("new-task-dictation-environment");
const draftKey = "new-task:dictation-screen";
const hostKey = { value: SECRET_SETTING_REDACTION_MARKER };
const project = {
  id: ProjectId.make("new-task-dictation-project"),
  environmentId,
  title: "Dictation",
  workspaceRoot: "/work/dictation",
  repositoryIdentity: null,
};
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

function serverConfig(openAiApiKey: string) {
  return {
    providers: [],
    usageLimitSources: [],
    environment: { capabilities: {}, platform: { machine: "server" } },
    settings: { providerInstances: {}, dictation: { openAiApiKey, vocabularyHints: [] } },
  };
}

function flowFixture() {
  return {
    appendAttachments: vi.fn(),
    attachments: [],
    availableBranches: [],
    branchesLoading: false,
    buildPendingTaskMessage: () => ({
      environmentId,
      threadId: "new-task-dictation-thread",
      text: fixture.prompt.trim(),
      attachments: [],
    }),
    currentCheckoutBranchName: "main",
    draftKey,
    editingPendingTask: null,
    environments: [],
    finishEditingPendingTask: vi.fn(),
    interactionMode: "default",
    loadBranches: vi.fn(),
    planModeEnabled: false,
    prompt: fixture.prompt,
    removeAttachment: vi.fn(),
    selectedBranchName: "main",
    selectedEnvironmentId: environmentId,
    selectedModel: modelSelection,
    selectedModelOption: { label: "GPT-5", providerDriver: "codex", isUnavailable: false },
    selectedProject: project,
    selectedProviderStatus: null,
    selectedWorktreePath: null,
    setInteractionMode: vi.fn(),
    setPrompt: fixture.setPrompt,
    setSubmitting: vi.fn(),
    setWorkspaceMode: vi.fn(),
    startFromOrigin: false,
    submitting: false,
    workspaceMode: "local",
    projectScopes: [],
    selectedProjectKey: `${environmentId}:${project.id}`,
    setProject: vi.fn(),
  };
}

import {
  forgetDictationDraft,
  isDictationDraftArmed,
  markDictationDraftVoiced,
} from "../../state/dictationDrafts";
import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

import { appAtomRegistry } from "../../state/atom-registry";

let root: Root | null = null;
let container: HTMLDivElement;

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <NewTaskDraftScreen />
      </RegistryContext.Provider>,
    ),
  );
}
async function rerender() {
  await act(async () =>
    root!.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <NewTaskDraftScreen />
      </RegistryContext.Provider>,
    ),
  );
}
const buttons = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`));
async function press(element: HTMLButtonElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.prompt = "";
  fixture.senders.clear();
  fixture.record.mockClear();
  fixture.recorderStop.mockClear();
  fixture.finishDictation.mockClear();
  fixture.enqueue.mockClear();
  fixture.setPrompt.mockClear();
  fixture.clone = null;
  fixture.reportUnsent.mockClear();
  forgetDictationDraft(draftKey);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("new-task screen server dictation", () => {
  it("keeps the new-task draft editable while recording", async () => {
    fixture.prompt = "a task";
    await mount();
    await press(buttons("Start dictation")[0]);
    await act(async () => undefined);
    expect(fixture.record).toHaveBeenCalledOnce();
    expect(buttons("Stop dictation")).toHaveLength(1);
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    expect(editor.readOnly).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor, "a task, edited");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(fixture.setPrompt).toHaveBeenCalledWith("a task, edited");
  });

  it("stops a new-task recording with the draft as the marker's owner", async () => {
    await mount();
    await press(buttons("Start dictation")[0]);
    await act(async () => undefined);
    await press(buttons("Stop dictation")[0]);
    expect(fixture.finishDictation).toHaveBeenCalledWith({
      owner: { environmentId, draftKey, target: { kind: "draft", draftId: draftKey } },
      mode: "submit",
      recording: expect.objectContaining({ uri: "file:///tmp/composer-dictation.m4a" }),
    });
  });

  it("starts an armed new-task draft from its mounted screen once the filled text renders", async () => {
    fixture.prompt = `start ${"[Transcribing](t3-context://v1/dictation/job-9)"}`;
    await mount();
    const send = fixture.senders.get(draftKey);
    expect(send).toBeDefined();
    // The marker is still on screen: the send waits for the render that shows the transcript.
    await act(async () => send!());
    expect(fixture.enqueue).not.toHaveBeenCalled();

    markDictationDraftVoiced(draftKey);
    fixture.prompt = "start a new task";
    await rerender();
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    expect((fixture.enqueue.mock.calls[0]![0] as { text: string }).text).toBe(
      "[voiced] start a new task",
    );
  });
});

const pendingMarker = "[Transcribing](t3-context://v1/dictation/job-pending)";

describe("new-task screen dictation review regressions", () => {
  // P1-1: Start is never disabled by a marker; it arms the draft instead of starting it.
  it("arms instead of starting a new task whose draft holds a pending marker", async () => {
    fixture.prompt = `start ${pendingMarker}`;
    await mount();
    const start = buttons("Start task")[0];
    expect(start?.disabled).toBe(false);
    await press(start);
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(isDictationDraftArmed(draftKey)).toBe(true);
  });

  // P1-7: the automatic start passes the visible Start's check, and says why it refused.
  it("refuses and reports an automatic new-task start while the repository clones", async () => {
    fixture.prompt = `start ${pendingMarker}`;
    fixture.clone = { phase: "running" };
    await mount();
    expect(buttons("Cloning repository")[0]?.disabled).toBe(true);
    const send = fixture.senders.get(draftKey)!;
    await act(async () => send());
    fixture.prompt = "start the task";
    await rerender();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(fixture.reportUnsent).toHaveBeenCalledWith(
      draftKey,
      "The repository is still being cloned. The text is in the draft.",
    );
  });
});
