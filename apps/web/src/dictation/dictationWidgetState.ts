import type { DictationMode } from "@t3tools/contracts";
import { create } from "zustand";

import type { DictationRecordingSession } from "./dictationSessionStore";

/**
 * What the desktop widget draws while another app has focus. The main window's renderer builds
 * it and publishes it through the desktop bridge; the widget window only renders it, so it
 * opens no server connection of its own. Kept free of heavy imports: the widget page reads the
 * types from here.
 */
export interface DictationWidgetSnapshot {
  readonly recording: boolean;
  /** A stopped recording is on its way to the server or still transcribing there. */
  readonly transcribing: boolean;
  /** When the last transcript was delivered; the desktop shows the result for a moment. */
  readonly deliveredAt: number | null;
  /** The dictation keys apply: a recording, or the last stopped job still transcribing. */
  readonly live: boolean;
  readonly session: DictationRecordingSession | null;
  /** Where the transcript goes: the recording's mode, else the last job's. */
  readonly mode: DictationMode | null;
  /** The thread the marker drops into, or the delivered transcript went to. */
  readonly target: string | null;
  readonly transcribingCount: number;
  readonly delivered: DictationDelivery | null;
  /** When this device's last job failed; the desktop keeps it on screen until Mesura has focus. */
  readonly failedAt: number | null;
  readonly failed: DictationFailure | null;
}

export interface DictationFailure {
  readonly jobId: string;
  readonly at: number;
  readonly target: string | null;
}

export interface DictationDelivery {
  readonly at: number;
  readonly mode: DictationMode;
  readonly target: string | null;
}

interface DictationWidgetActivity {
  /** This device's jobs the server reports as transcribing, per environment. */
  readonly transcribing: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly delivered: DictationDelivery | null;
  readonly failed: DictationFailure | null;
}

export const useDictationWidgetActivityStore = create<DictationWidgetActivity>(() => ({
  transcribing: {},
  delivered: null,
  failed: null,
}));

export function setTranscribingDictationJobs(
  environmentId: string,
  jobIds: ReadonlyArray<string>,
): void {
  const current = useDictationWidgetActivityStore.getState().transcribing[environmentId] ?? [];
  if (current.length === jobIds.length && current.every((id, index) => id === jobIds[index])) {
    return;
  }
  useDictationWidgetActivityStore.setState((state) => ({
    transcribing: { ...state.transcribing, [environmentId]: jobIds },
  }));
}

export function recordDictationDelivery(delivery: DictationDelivery | null): void {
  useDictationWidgetActivityStore.setState({ delivered: delivery });
}

export function recordDictationFailure(failure: DictationFailure | null): void {
  useDictationWidgetActivityStore.setState({ failed: failure });
}

export function countTranscribingDictationJobs(activity: DictationWidgetActivity): number {
  return Object.values(activity.transcribing).reduce((total, ids) => total + ids.length, 0);
}

/** The preload's fork-owned bridge; absent outside the desktop app. */
export interface MesuraDictationBridge {
  /** A `--dictation …` command line a second launch of the desktop binary forwarded. */
  readonly onCommandLine: (listener: (command: unknown) => void) => () => void;
  readonly publishWidgetState: (state: DictationWidgetSnapshot) => void;
  /** The widget page rendered the state that asked for it; the desktop shows the window then. */
  readonly acknowledgeWidgetState: (sequence: number) => void;
  /** The widget window's side: the state the main window published. */
  readonly onWidgetState: (listener: (state: unknown) => void) => () => void;
}

declare global {
  interface Window {
    mesuraDictationBridge?: MesuraDictationBridge;
  }
}
