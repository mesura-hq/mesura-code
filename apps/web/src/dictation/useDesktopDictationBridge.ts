import { DICTATION_KEYBINDING_COMMANDS, type DictationKeybindingCommand } from "@t3tools/contracts";
import { useEffect } from "react";

import { currentDictationTarget, runDictationKeybindingCommand } from "./dictationController";
import { useDictationSessionStore, useOwnDictationJobsStore } from "./dictationSessionStore";
import { dictationTargetLabel } from "./dictationTargetLabel";
import {
  countTranscribingDictationJobs,
  type DictationWidgetSnapshot,
  useDictationWidgetActivityStore,
} from "./dictationWidgetState";

const COMMANDS: ReadonlySet<string> = new Set(DICTATION_KEYBINDING_COMMANDS);

function isDictationCommand(value: unknown): value is DictationKeybindingCommand {
  return typeof value === "string" && COMMANDS.has(value);
}

export function buildDictationWidgetSnapshot(): DictationWidgetSnapshot {
  const { session, lastJob } = useDictationSessionStore.getState();
  const activity = useDictationWidgetActivityStore.getState();
  const transcribingCount = countTranscribingDictationJobs(activity);
  const lastOwn = lastJob ? useOwnDictationJobsStore.getState().jobs[lastJob.jobId] : undefined;
  const target = session ? currentDictationTarget() : (lastOwn?.target ?? null);
  return {
    recording: session !== null,
    transcribing: lastJob !== null || transcribingCount > 0,
    deliveredAt: activity.delivered?.at ?? null,
    live: session !== null || lastJob !== null,
    session,
    mode: session?.mode ?? lastOwn?.mode ?? null,
    target: dictationTargetLabel(target),
    transcribingCount: Math.max(transcribingCount, lastJob ? 1 : 0),
    delivered: activity.delivered,
    failedAt: activity.failed?.at ?? null,
    failed: activity.failed,
  };
}

/**
 * The desktop side of Mesura's dictation: runs the `--dictation …` command lines the desktop
 * forwards, as the in-window keys would, and publishes what the floating widget shows. When
 * another app has focus a recording stops into the last composer shown, as it does here.
 */
/** The snapshot without its microphone samples: what the binds and the visibility depend on. */
function lifecycleOf(snapshot: DictationWidgetSnapshot): string {
  const { session } = snapshot;
  return JSON.stringify({
    ...snapshot,
    session: session === null ? null : { ...session, level: 0, sampledAt: 0 },
  });
}

/**
 * Whether this snapshot is worth sending. Lifecycle changes always are: the desktop binds the
 * keys and decides visibility from them. The level samples (about ten a second while recording)
 * only feed the widget's waveform, and the widget is never on screen while this window has
 * focus, so they wait until it does not.
 */
export function shouldPublishDictationSnapshot(input: {
  readonly snapshot: DictationWidgetSnapshot;
  readonly lastPublished: DictationWidgetSnapshot | null;
  readonly documentFocused: boolean;
}): boolean {
  const { snapshot, lastPublished } = input;
  if (lastPublished === null) return true;
  if (lifecycleOf(snapshot) !== lifecycleOf(lastPublished)) return true;
  return !input.documentFocused && JSON.stringify(snapshot) !== JSON.stringify(lastPublished);
}

export function useDesktopDictationBridge(): void {
  useEffect(() => {
    const bridge = window.mesuraDictationBridge;
    if (!bridge) return;
    const stopCommands = bridge.onCommandLine((command) => {
      if (isDictationCommand(command)) runDictationKeybindingCommand(command);
    });
    let lastPublished: DictationWidgetSnapshot | null = null;
    let scheduled = false;
    let active = true;
    const publishNow = () => {
      scheduled = false;
      if (!active) return;
      const snapshot = buildDictationWidgetSnapshot();
      if (
        !shouldPublishDictationSnapshot({
          snapshot,
          lastPublished,
          documentFocused: document.hasFocus(),
        })
      ) {
        return;
      }
      lastPublished = snapshot;
      bridge.publishWidgetState(snapshot);
    };
    // One snapshot per synchronous burst: a stop clears the recording and then records the job
    // in separate store updates, and publishing between them would read as nothing in progress,
    // hiding the widget for an instant before it shows the transcription.
    const publish = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(publishNow);
    };
    publishNow();
    // Leaving the window: the widget may show, so it gets the current samples at once.
    window.addEventListener("blur", publish);
    const unsubscribes = [
      useDictationSessionStore.subscribe(publish),
      useDictationWidgetActivityStore.subscribe(publish),
      useOwnDictationJobsStore.subscribe(publish),
    ];
    return () => {
      active = false;
      window.removeEventListener("blur", publish);
      stopCommands();
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);
}
