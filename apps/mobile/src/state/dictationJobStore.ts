import type { DictationMode, DictationTarget, EnvironmentId } from "@t3tools/contracts";

import { writeFileAtomically } from "../lib/atomic-file";

/**
 * This phone's dictation jobs, on disk beside the composer drafts (`composer-drafts/`), so a job
 * whose marker is already in a persisted draft survives the app being killed between the stop
 * and the server registering it. Written before the upload starts; removed once the transcript
 * is delivered or the marker discarded.
 */
export interface DictationJobRecord {
  readonly jobId: string;
  readonly owner: {
    readonly environmentId: EnvironmentId;
    readonly draftKey: string;
    readonly target: Exclude<DictationTarget, null>;
    readonly question?: { readonly requestKey: string; readonly questionId: string };
  };
  readonly mode: DictationMode;
  readonly recording: {
    readonly uri: string;
    readonly durationMs: number;
    readonly mimeType: string;
  } | null;
  /** `uploading` until the server accepted the start, then `started`. */
  readonly upload: "uploading" | "started";
  /** The draft generation the marker dropped in. */
  readonly generation: number;
}

const DIRECTORY = "composer-drafts";
const FILE_NAME = "dictation-jobs.json";
const SCHEMA_VERSION = 1;

async function jobsFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, FILE_NAME);
}

/** The records the last process wrote; an unreadable file reads as none. */
export async function loadDictationJobRecords(): Promise<ReadonlyArray<DictationJobRecord>> {
  try {
    const file = await jobsFile();
    if (!file.exists) return [];
    const parsed = JSON.parse(await file.text()) as {
      readonly schemaVersion?: number;
      readonly jobs?: ReadonlyArray<DictationJobRecord>;
    };
    return parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

let writeQueue: Promise<void> = Promise.resolve();

/** Replaces the records on disk; writes land in call order. */
export function saveDictationJobRecords(records: ReadonlyArray<DictationJobRecord>): Promise<void> {
  const contents = JSON.stringify({ schemaVersion: SCHEMA_VERSION, jobs: records });
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => writeFileAtomically(await jobsFile(), contents));
  return writeQueue;
}

/** Whether a kept recording can still be uploaded again. */
export async function recordingFileExists(uri: string): Promise<boolean> {
  try {
    const { File } = await import("expo-file-system");
    return new File(uri).exists;
  } catch {
    return false;
  }
}
