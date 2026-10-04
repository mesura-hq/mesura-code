import { DEFAULT_DICTATION_MODE, nextDictationMode } from "@t3tools/client-runtime/dictation";
import type { VoiceInputState, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import type { DictationMode } from "@t3tools/contracts";
import { useFocusEffect } from "@react-navigation/native";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingOptions,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import { finishDictation, type DictationOwner } from "../../state/dictation";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const METERING_INTERVAL_MS = 80;
/** The recorder writes AAC in an MP4 container on both platforms. */
const DICTATION_MIME_TYPE = "audio/mp4";
const DICTATION_BIT_RATE = 64_000;

/**
 * Speech only needs a mono, 64 kbps AAC `.m4a`: a quarter of the high-quality preset's upload,
 * which matters on a phone connection. The preset already writes AAC in `.m4a` on both platforms.
 */
const DICTATION_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: DICTATION_BIT_RATE,
  isMeteringEnabled: true,
};

// Copied from upstream's `useVoiceInputController.ts`: the two audio-session helpers below and
// the status mapping in `toVoiceRecorderStatus`. They are module-private there, and exporting
// them would edit an upstream file whose only other user is that hook. Keep them in step with it.
async function releaseRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops; this resumes other audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    await releaseRecordingAudio().catch(() => undefined);
    throw error;
  }
}

/** Expo's terminal recorder events, in the shape upstream's controller reads them. */
function toVoiceRecorderStatus(status: RecordingStatus): VoiceRecorderStatus {
  return {
    isFinished: status.isFinished,
    hasError: status.hasError || status.mediaServicesDidReset === true,
    error: status.error,
    url: status.url,
  };
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function deleteRecordingFile(uri: string | null) {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // Already gone.
  }
}

/**
 * Records a dictation for the server path and hands it to `finishDictation` on stop. The draft
 * stays editable while recording: the marker drops at stop, where the caret is then. Moving the
 * app to the background, leaving the screen, or the recorder finishing on its own all stop and
 * transcribe what was said instead of discarding it. Upstream's `useVoiceInputController`
 * (Apple's on-device transcriber) stays in the tree and is not used by the composers.
 *
 * Every start, stop, cancel and terminal event takes a new operation token; an awaited step whose
 * token is no longer current gives back what it acquired and does nothing else. A stop keeps new
 * recordings out until it has captured its file, so the next recording cannot change its mode.
 */
export function useDictationController(input: {
  /** Where the marker goes; `null` while there is nothing to dictate into. */
  readonly owner: DictationOwner | null;
  /** The host has a dictation key. */
  readonly available: boolean;
  readonly disabled?: boolean;
}) {
  const [state, setStateValue] = useState<VoiceInputState>(IDLE);
  const [mode, setModeValue] = useState<DictationMode>(DEFAULT_DICTATION_MODE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  // Read synchronously by handlers and native events, ahead of the next render.
  const stateRef = useRef(state);
  const modeRef = useRef(mode);
  const latestRef = useRef(input);
  latestRef.current = input;
  const operationRef = useRef(0);
  /** The operation that holds the audio session, so a stale one never releases a newer one's. */
  const sessionOwnerRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  const recorderStatusRef = useRef<(status: VoiceRecorderStatus) => void>(() => undefined);
  const recorder = useAudioRecorder(DICTATION_RECORDING_OPTIONS, (status) =>
    recorderStatusRef.current(toVoiceRecorderStatus(status)),
  );

  const setState = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);
  const setMode = useCallback((next: DictationMode) => {
    modeRef.current = next;
    setModeValue(next);
  }, []);

  const releaseAudioFor = useCallback(async (operation: number) => {
    if (sessionOwnerRef.current !== operation) return;
    sessionOwnerRef.current = null;
    await releaseRecordingAudio().catch(() => undefined);
  }, []);

  const resetMeter = useCallback(() => {
    audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
    audioLevels.value = audioLevelsRef.current;
    setElapsedSeconds(0);
  }, [audioLevels]);

  const start = useCallback(async () => {
    const { owner, available, disabled } = latestRef.current;
    if (!owner || !available || disabled || stoppingRef.current) return;
    const { phase } = stateRef.current;
    if (phase === "preparing" || phase === "recording") return;
    const operation = ++operationRef.current;
    const current = () => operation === operationRef.current;
    setMode(DEFAULT_DICTATION_MODE);
    resetMeter();
    setState({ phase: "preparing", error: null, errorAction: null });
    let prepared = false;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) {
        setState({
          phase: "error",
          error: "Microphone access is off.",
          errorAction: permission.canAskAgain ? "retry" : "settings",
        });
        return;
      }
      sessionOwnerRef.current = operation;
      await configureRecordingAudio();
      if (!current()) {
        await releaseAudioFor(operation);
        return;
      }
      await recorder.prepareToRecordAsync();
      prepared = true;
      if (!current()) {
        await recorder.stop().catch(() => undefined);
        deleteRecordingFile(recorder.uri);
        await releaseAudioFor(operation);
        return;
      }
      recorder.record();
      setState({ phase: "recording", error: null, errorAction: null });
    } catch (cause) {
      if (prepared) deleteRecordingFile(recorder.uri);
      await releaseAudioFor(operation);
      if (!current()) return;
      setState({ phase: "error", error: errorMessage(cause), errorAction: "retry" });
    }
  }, [recorder, releaseAudioFor, resetMeter, setMode, setState]);

  /** Hands a finished file to the server path, once; `alreadyStopped` when the recorder ended. */
  const complete = useCallback(
    async (alreadyStopped: boolean, finishedUri: string | null) => {
      const owner = latestRef.current.owner;
      if (stateRef.current.phase !== "recording" || stoppingRef.current || !owner) return;
      // Everything the job needs is read now, before any await: a recording started after this
      // stop must not change this one's mode.
      const mode = modeRef.current;
      const durationMs = Math.max(0, Math.round(recorder.getStatus().durationMillis));
      ++operationRef.current;
      const sessionOperation = sessionOwnerRef.current;
      stoppingRef.current = true;
      setState(IDLE);
      let uri = finishedUri;
      try {
        if (!alreadyStopped) await recorder.stop().catch(() => undefined);
        uri ??= recorder.uri;
      } finally {
        stoppingRef.current = false;
        if (sessionOperation !== null) await releaseAudioFor(sessionOperation);
      }
      if (!uri) return;
      await finishDictation({
        owner,
        mode,
        recording: { uri, durationMs, mimeType: DICTATION_MIME_TYPE },
      });
    },
    [recorder, releaseAudioFor, setState],
  );

  const stop = useCallback(() => complete(false, null), [complete]);

  const cancel = useCallback(async () => {
    const phase = stateRef.current.phase;
    const sessionOperation = sessionOwnerRef.current;
    ++operationRef.current;
    setState(IDLE);
    // A preparing operation gives back what it acquired itself when it next wakes.
    if (phase !== "recording") return;
    try {
      await recorder.stop();
      deleteRecordingFile(recorder.uri);
    } catch {
      // Nothing was recorded, or the file is already gone.
    } finally {
      if (sessionOperation !== null) await releaseAudioFor(sessionOperation);
    }
  }, [recorder, releaseAudioFor, setState]);

  /** The recorder ended without a stop: transcribe a finished file once, else show the error. */
  const fail = useCallback(
    async (message: string, uri: string | null) => {
      if (stateRef.current.phase !== "recording") return;
      const sessionOperation = sessionOwnerRef.current;
      ++operationRef.current;
      setState({ phase: "error", error: message, errorAction: "retry" });
      deleteRecordingFile(uri ?? recorder.uri);
      if (sessionOperation !== null) await releaseAudioFor(sessionOperation);
    },
    [recorder, releaseAudioFor, setState],
  );
  recorderStatusRef.current = (status) => {
    if (stateRef.current.phase !== "recording") return;
    if (status.hasError) {
      void fail(status.error ?? "Voice recording was interrupted.", status.url);
    } else if (status.isFinished) {
      if (status.url) void complete(true, status.url);
      else void fail("The recording ended without audio.", null);
    }
  };

  const cycleMode = useCallback(() => setMode(nextDictationMode(modeRef.current)), [setMode]);

  // A different draft or answer took focus: this recording belongs to the one it started in.
  const ownerKey = input.owner
    ? JSON.stringify([input.owner.draftKey, input.owner.question ?? null])
    : null;
  const previousOwnerKeyRef = useRef(ownerKey);
  useEffect(() => {
    if (previousOwnerKeyRef.current === ownerKey) return;
    previousOwnerKeyRef.current = ownerKey;
    void cancel();
  }, [cancel, ownerKey]);

  // Leaving the screen keeps what was said: it is transcribed like a stop.
  useFocusEffect(
    useCallback(
      () => () => {
        if (stateRef.current.phase === "recording") void stop();
        else void cancel();
      },
      [cancel, stop],
    ),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      // iOS reports `inactive` while its permission dialog is open; only `background` counts.
      if (next !== "background") return;
      if (stateRef.current.phase === "recording") void stop();
      else if (stateRef.current.phase === "preparing") void cancel();
    });
    return () => subscription.remove();
  }, [cancel, stop]);

  useEffect(() => {
    if (state.phase !== "recording") return;
    let seenRecording = false;
    const sample = () => {
      const status = recorder.getStatus();
      // The recorder stopped on its own (a call, a route change) without a terminal event: what
      // was recorded so far is transcribed, as a stop would. Only after it was seen recording,
      // since a recorder can still report idle in the moment after `record()`.
      if (!status.isRecording) {
        if (seenRecording) void complete(true, null);
        return;
      }
      seenRecording = true;
      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((value) => value !== 0)) {
        audioLevelsRef.current = [...history.slice(1), level];
        audioLevels.value = audioLevelsRef.current;
      }
      setElapsedSeconds(Math.max(0, Math.floor(status.durationMillis / 1_000)));
    };
    sample();
    const interval = setInterval(sample, METERING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [audioLevels, complete, recorder, state.phase]);

  const busy = state.phase === "preparing" || state.phase === "recording";
  return {
    isAvailable: input.available,
    state,
    mode,
    audioLevels,
    elapsedSeconds,
    isBusy: busy,
    blocksSubmission: busy,
    start: useCallback(() => void start(), [start]),
    stop: useCallback(() => void stop(), [stop]),
    cancel: useCallback(() => void cancel(), [cancel]),
    cycleMode,
  };
}

export type DictationController = ReturnType<typeof useDictationController>;
