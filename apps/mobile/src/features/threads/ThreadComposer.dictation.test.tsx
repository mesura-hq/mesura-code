// @vitest-environment happy-dom
// Phase 7 (mobile dictation), criteria 1, 2, 3, 4, 6 and 8 at the composer.
// Entry point: `ThreadComposer`, mounted whole with its real dictation controls
// (`ComposerDictationControl`) and its real dictation hook. Stubbed edges: the
// native editor (a textarea that honours `readOnly`), the recorder (`expo-audio`),
// navigation and the settings sheet, and `finishDictation` (`state/dictation`),
// whose own behaviour (marker, upload, start) is pinned in `state/dictation.test.ts`.
// The Apple transcriber is stubbed as available on iOS, so a spec that sees it used
// fails rather than passes.
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SECRET_SETTING_REDACTION_MARKER,
  ThreadId,
} from "@t3tools/contracts";

const fixture = vi.hoisted(() => ({
  platform: "android" as "android" | "ios",
  appStateListeners: [] as Array<(state: string) => void>,
  durationMillis: 3_000,
  record: vi.fn(),
  recorderStop: vi.fn(async () => undefined),
  /** What the native recorder reports while recording; `false` once it stopped on its own. */
  isRecording: true,
  recorderUri: "file:///tmp/composer-dictation.m4a",
  statusListener: null as null | ((status: Record<string, unknown>) => void),
  permission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  prepare: vi.fn(async () => undefined),
  audioActive: vi.fn(async (_active: boolean) => undefined),
  deleteRecording: vi.fn(),
  prepareAppleTranscriber: vi.fn(async () => ({
    locale: "en-US",
    transcribe: async () => "Apple transcript",
  })),
  finishDictation: vi.fn(async (_input: unknown) => ({ jobId: "job-1", status: "started" })),
  failures: [] as Array<{ jobId: string; draftKey: string; message: string; retryable: boolean }>,
  retryDictationJob: vi.fn(async (_jobId: string) => "started"),
  discardDictationJob: vi.fn((_jobId: string) => undefined),
  onChangeDraftMessage: vi.fn(),
  navigation: {
    navigate: vi.fn(),
    dispatch: vi.fn(),
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
  // Hidden or untouchable content is `hidden`, so a spec sees what the user cannot reach.
  const AnimatedView = ({
    children,
    pointerEvents,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    pointerEvents?: string;
    accessibilityElementsHidden?: boolean;
  }) => (
    <div hidden={pointerEvents === "none" || accessibilityElementsHidden === true}>{children}</div>
  );
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
  StackActions: { push: (name: string) => ({ type: "push", name }) },
  useNavigation: () => fixture.navigation,
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
}));
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: () => fixture.permission(),
  setAudioModeAsync: async () => undefined,
  setIsAudioActiveAsync: (active: boolean) => fixture.audioActive(active),
  useAudioRecorder: (_options: unknown, listener: (status: Record<string, unknown>) => void) => {
    fixture.statusListener = listener;
    return useState(() => ({
      get uri() {
        return fixture.recorderUri;
      },
      prepareToRecordAsync: () => fixture.prepare(),
      record: fixture.record,
      stop: () => fixture.recorderStop(),
      getStatus: () => ({
        isRecording: fixture.isRecording,
        durationMillis: fixture.durationMillis,
        metering: -30,
      }),
    }))[0];
  },
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
vi.mock("../../state/dictation", () => ({
  finishDictation: fixture.finishDictation,
  deliverDictationJobs: vi.fn(),
  readDictationJobFailure: () => null,
  retryDictationJob: fixture.retryDictationJob,
  discardDictationJob: fixture.discardDictationJob,
  useDictationFailures: (draftKey: string | null) =>
    fixture.failures.filter((failure) => failure.draftKey === draftKey),
}));

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
vi.mock("./ThreadSettingsSheet", () => ({
  useExistingThreadSettingsRoutePresentation: () => ({ present: vi.fn(), clear: vi.fn() }),
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
vi.mock("../../state/entities", () => ({ useProject: () => null }));
vi.mock("../../state/use-composer-drafts", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerContextImportsAtom: Atom.make({}).pipe(Atom.keepAlive),
    countComposerDraftAttachmentsAfterSelection: () => 0,
  };
});
vi.mock("../../state/composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}).pipe(Atom.keepAlive),
    composerAttachmentUploadBlockReason: () => null,
    composerAttachmentsStillUploading: () => false,
  };
});

import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";
import {
  armDictationDraft,
  forgetAllDictationDrafts,
  isDictationDraftArmed,
} from "../../state/dictationDrafts";

const environmentId = EnvironmentId.make("composer-dictation-environment");
const threadId = ThreadId.make("composer-dictation-thread");

function serverConfig(openAiApiKey: string) {
  return {
    providers: [],
    usageLimitSources: [],
    environment: { capabilities: {} },
    settings: { providerInstances: {}, dictation: { openAiApiKey, vocabularyHints: [] } },
  } as unknown as ThreadComposerProps["serverConfig"];
}

function props(openAiApiKey: string): ThreadComposerProps {
  return {
    draftMessage: "already typed",
    draftAttachments: [],
    placeholder: "Message",
    connectionState: "connected",
    environmentLabel: "Host",
    selectedThread: {
      id: threadId,
      environmentId,
      projectId: ProjectId.make("composer-dictation-project"),
      title: "Dictation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: null,
    } as unknown as ThreadComposerProps["selectedThread"],
    hasCompactableConversation: false,
    serverConfig: serverConfig(openAiApiKey),
    queueCount: 0,
    environmentId,
    projectCwd: null,
    onChangeDraftMessage: fixture.onChangeDraftMessage,
    onPickDraftMedia: async () => undefined,
    onPickDraftFiles: async () => undefined,
    onNativePasteImages: async () => undefined,
    onNativePasteText: async () => undefined,
    onRemoveDraftImage: () => undefined,
    onStopThread: () => undefined,
    onSendMessage: async () => null,
    onShowUsageLimits: () => undefined,
    onCompactContext: async () => false,
    onUpdateModelSelection: () => undefined,
    onUpdateRuntimeMode: () => undefined,
    onUpdateInteractionMode: () => undefined,
  };
}

import { appAtomRegistry } from "../../state/atom-registry";

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(openAiApiKey = SECRET_SETTING_REDACTION_MARKER) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ThreadComposer {...props(openAiApiKey)} />
      </RegistryContext.Provider>,
    ),
  );
}

const buttons = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`));
const modeButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Dictation mode"]');
async function press(element: HTMLButtonElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
}
async function startRecording() {
  await press(buttons("Start dictation")[0]);
  // Let the permission, audio session and recorder promises settle.
  await act(async () => undefined);
}

beforeEach(() => {
  fixture.platform = "android";
  fixture.appStateListeners = [];
  fixture.durationMillis = 3_000;
  fixture.record.mockClear();
  fixture.recorderStop.mockReset();
  fixture.recorderStop.mockResolvedValue(undefined);
  fixture.isRecording = true;
  fixture.recorderUri = "file:///tmp/composer-dictation.m4a";
  fixture.permission.mockReset();
  fixture.permission.mockResolvedValue({ granted: true, canAskAgain: true });
  fixture.prepare.mockReset();
  fixture.prepare.mockResolvedValue(undefined);
  fixture.audioActive.mockClear();
  fixture.deleteRecording.mockClear();
  fixture.prepareAppleTranscriber.mockClear();
  fixture.finishDictation.mockClear();
  fixture.failures = [];
  fixture.retryDictationJob.mockClear();
  fixture.discardDictationJob.mockClear();
  fixture.onChangeDraftMessage.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("composer server dictation availability", () => {
  it("shows the composer microphone on Android when the host has a dictation key", async () => {
    await mount(SECRET_SETTING_REDACTION_MARKER);
    expect(buttons("Start dictation").length).toBeGreaterThan(0);
  });

  it("hides the composer microphone when the host has no dictation key, even with Apple's transcriber", async () => {
    fixture.platform = "ios";
    await mount("");
    expect(buttons("Start dictation")).toHaveLength(0);
  });
});

describe("composer server dictation recording", () => {
  it("keeps the composer draft editable while recording", async () => {
    await mount();
    await startRecording();
    expect(fixture.record).toHaveBeenCalledOnce();
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    expect(editor.readOnly).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor, "already typed and more");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(fixture.onChangeDraftMessage).toHaveBeenCalledWith("already typed and more");
  });

  it("shows cancel, the elapsed time, a mode button and a round stop in that order", async () => {
    await mount();
    await startRecording();
    const labels = Array.from(container.querySelectorAll("[aria-label]")).map((element) =>
      element.getAttribute("aria-label"),
    );
    const cancel = labels.indexOf("Cancel dictation");
    const mode = labels.findIndex((label) => label?.startsWith("Dictation mode"));
    const stop = labels.indexOf("Stop dictation");
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(mode).toBeGreaterThan(cancel);
    expect(stop).toBeGreaterThan(mode);
    expect(container.textContent).toContain("0:03");
  });

  it("cancels a composer recording without starting a job", async () => {
    await mount();
    await startRecording();
    await press(buttons("Cancel dictation")[0]);
    expect(fixture.finishDictation).not.toHaveBeenCalled();
    expect(buttons("Stop dictation")).toHaveLength(0);
  });
});

describe("composer server dictation mode", () => {
  it("cycles the composer dictation mode from send through save and insert back to send", async () => {
    await mount();
    await startRecording();
    const seen = [modeButton()?.getAttribute("aria-label")];
    for (let step = 0; step < 3; step += 1) {
      await press(modeButton());
      seen.push(modeButton()?.getAttribute("aria-label"));
    }
    expect(seen).toEqual([
      "Dictation mode: Send",
      "Dictation mode: Save",
      "Dictation mode: Insert",
      "Dictation mode: Send",
    ]);
  });
});

describe("composer server dictation stop", () => {
  it("hands the composer recording to the server path with its thread, mode and file", async () => {
    await mount();
    await startRecording();
    await press(modeButton());
    await press(modeButton());
    await press(buttons("Stop dictation")[0]);

    expect(fixture.recorderStop).toHaveBeenCalledOnce();
    expect(fixture.finishDictation).toHaveBeenCalledOnce();
    expect(fixture.finishDictation).toHaveBeenCalledWith({
      owner: {
        environmentId,
        draftKey: scopedThreadKey(environmentId, threadId),
        target: { kind: "thread", environmentId, threadId },
      },
      mode: "inject",
      recording: expect.objectContaining({
        uri: "file:///tmp/composer-dictation.m4a",
        mimeType: "audio/mp4",
        durationMs: 3_000,
      }),
    });
    expect(fixture.deleteRecording).not.toHaveBeenCalled();
    expect(fixture.onChangeDraftMessage).not.toHaveBeenCalled();
  });

  it("stops and transcribes a composer recording when the app goes to the background", async () => {
    await mount();
    await startRecording();
    await act(async () => {
      for (const listener of fixture.appStateListeners) listener("background");
    });
    expect(fixture.finishDictation).toHaveBeenCalledOnce();
    expect(fixture.finishDictation).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "submit",
        recording: expect.objectContaining({ uri: "file:///tmp/composer-dictation.m4a" }),
      }),
    );
    expect(fixture.deleteRecording).not.toHaveBeenCalled();
  });
});

describe("composer server dictation on iOS", () => {
  it("uses the server path on iOS and never prepares Apple's on-device transcriber", async () => {
    fixture.platform = "ios";
    await mount();
    await startRecording();
    await press(buttons("Stop dictation")[0]);
    expect(fixture.finishDictation).toHaveBeenCalledOnce();
    expect(fixture.prepareAppleTranscriber).not.toHaveBeenCalled();
  });

  // Guard: the Apple path stays in the tree, unused by the composers.
  it("keeps the Apple voice input hook in the tree, unreferenced by the three composers", () => {
    const read = (path: string) =>
      NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(path, import.meta.url)), "utf8");
    expect(read("../voice-input/useVoiceInputController.ts")).toContain(
      "export function useVoiceInputController",
    );
    for (const composer of [
      "./ThreadComposer.tsx",
      "./NewTaskDraftScreen.tsx",
      "./PendingUserInputCard.tsx",
    ]) {
      expect(read(composer)).not.toContain("useVoiceInputController");
    }
  });
});

describe("composer server dictation failure banner", () => {
  it("shows a failed composer dictation's reason above the composer with Retry and Discard", async () => {
    fixture.failures = [
      {
        jobId: "job-failed",
        draftKey: scopedThreadKey(environmentId, threadId),
        message: "The server refused the recording (413).",
        retryable: true,
      },
      {
        jobId: "job-elsewhere",
        draftKey: "another-draft",
        message: "Not this composer",
        retryable: true,
      },
    ];
    await mount();
    expect(container.textContent).toContain("The server refused the recording (413).");
    expect(container.textContent).not.toContain("Not this composer");

    await press(buttons("Retry dictation")[0]);
    expect(fixture.retryDictationJob).toHaveBeenCalledWith("job-failed");
    await press(buttons("Discard dictation")[0]);
    expect(fixture.discardDictationJob).toHaveBeenCalledWith("job-failed");
  });

  it("shows no composer dictation banner while nothing failed", async () => {
    await mount();
    expect(buttons("Retry dictation")).toHaveLength(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = () => act(async () => undefined);
const visible = (label: string) => buttons(label).filter((button) => !button.closest("[hidden]"));

describe("composer dictation review regressions", () => {
  it("shows Retry only when an interrupted composer dictation can be retried", async () => {
    fixture.failures = [
      {
        jobId: "job-interrupted",
        draftKey: scopedThreadKey(environmentId, threadId),
        message: "Interrupted",
        retryable: false,
      },
    ];
    await mount();
    expect(container.textContent).toContain("Interrupted");
    expect(buttons("Retry dictation")).toHaveLength(0);
    expect(buttons("Discard dictation")).toHaveLength(1);
  });

  // P1-1: Send is never disabled by a marker; the armed draft shows its banner and Don't send.
  it("keeps composer Send enabled with a pending marker and shows the armed banner with Don't send", async () => {
    forgetAllDictationDrafts();
    const key = scopedThreadKey(environmentId, threadId);
    await mount();
    const send = buttons("Send")[0];
    expect(send?.disabled).toBe(false);
    act(() => armDictationDraft(key));
    expect(container.textContent).toContain("Sends when the transcription finishes");
    await press(buttons("Don't send")[0]);
    expect(isDictationDraftArmed(key)).toBe(false);
    expect(container.textContent).not.toContain("Sends when the transcription finishes");
  });

  // P1-4: Stop shows idle before the native stop returns; a new recording must not change the
  // stopped recording's mode, and cannot start until the stop captured its file.
  it("keeps a stopped composer recording's mode while the native stop is still pending", async () => {
    await mount();
    await startRecording();
    await press(modeButton()); // Save
    await press(modeButton()); // Insert
    const nativeStop = deferred<undefined>();
    fixture.recorderStop.mockReturnValueOnce(nativeStop.promise);
    await press(buttons("Stop dictation")[0]);

    await press(visible("Start dictation")[0]);
    await settle();
    expect(fixture.record).toHaveBeenCalledOnce();

    await act(async () => nativeStop.resolve(undefined));
    expect(fixture.finishDictation).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "inject" }),
    );
    await startRecording();
    expect(fixture.record).toHaveBeenCalledTimes(2);
  });

  // P1-5: cancelled while the permission prompt is open, then granted.
  it("never activates audio for a composer recording cancelled during the permission prompt", async () => {
    const permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
    fixture.permission.mockReturnValueOnce(permission.promise);
    await mount();
    await press(visible("Start dictation")[0]);
    await press(buttons("Cancel dictation")[0]);
    await act(async () => permission.resolve({ granted: true, canAskAgain: true }));
    expect(fixture.audioActive).not.toHaveBeenCalledWith(true);
    expect(fixture.record).not.toHaveBeenCalled();
    expect(visible("Start dictation").length).toBeGreaterThan(0);
  });

  it("releases the audio a composer recording cancelled during prepare acquired", async () => {
    const prepare = deferred<undefined>();
    fixture.prepare.mockReturnValueOnce(prepare.promise);
    await mount();
    await press(visible("Start dictation")[0]);
    await settle();
    expect(fixture.audioActive).toHaveBeenLastCalledWith(true);
    await press(buttons("Cancel dictation")[0]);
    await act(async () => prepare.resolve(undefined));
    expect(fixture.record).not.toHaveBeenCalled();
    expect(fixture.audioActive).toHaveBeenLastCalledWith(false);
  });

  // P1-6: the recorder's own terminal events.
  it("transcribes a composer recording the recorder finished on its own, once", async () => {
    await mount();
    await startRecording();
    await act(async () => {
      fixture.statusListener?.({
        isFinished: true,
        hasError: false,
        error: null,
        url: "file:///done.m4a",
      });
      fixture.statusListener?.({
        isFinished: true,
        hasError: false,
        error: null,
        url: "file:///done.m4a",
      });
    });
    expect(fixture.finishDictation).toHaveBeenCalledOnce();
    expect(fixture.finishDictation).toHaveBeenCalledWith(
      expect.objectContaining({ recording: expect.objectContaining({ uri: "file:///done.m4a" }) }),
    );
    expect(fixture.recorderStop).not.toHaveBeenCalled();
    expect(buttons("Stop dictation")).toHaveLength(0);
    expect(fixture.audioActive).toHaveBeenLastCalledWith(false);
  });

  it.each([
    {
      label: "an encoder error",
      status: { isFinished: false, hasError: true, error: "Encoder failed", url: null },
      message: "Encoder failed",
    },
    {
      label: "a media services reset",
      status: {
        isFinished: false,
        hasError: false,
        error: null,
        url: null,
        mediaServicesDidReset: true,
      },
      message: "Voice recording was interrupted.",
    },
  ])(
    "shows the error and releases audio when a composer recording ends with $label",
    async ({ status, message }) => {
      await mount();
      await startRecording();
      await act(async () => fixture.statusListener?.(status));
      expect(container.textContent).toContain(message);
      expect(fixture.finishDictation).not.toHaveBeenCalled();
      expect(buttons("Stop dictation")).toHaveLength(0);
      expect(fixture.audioActive).toHaveBeenLastCalledWith(false);
    },
  );

  it("transcribes a composer recording whose recorder reports it stopped without an event", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await startRecording();
      fixture.isRecording = false;
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(fixture.finishDictation).toHaveBeenCalledOnce();
      expect(buttons("Stop dictation")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // P1-8: the collapsed microphone opens the draft, which stays reachable while recording.
  it("keeps the draft visible and editable when dictation starts from the collapsed microphone", async () => {
    await mount();
    const editor = () =>
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    expect(editor().closest("[hidden]")).toBeNull();
    await press(visible("Start dictation")[0]);
    await settle();
    expect(fixture.record).toHaveBeenCalledOnce();
    expect(editor().closest("[hidden]")).toBeNull();
    expect(editor().readOnly).toBe(false);
  });
});
