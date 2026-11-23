import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { flushFileSaveSession } from "~/components/files/fileSaveSessions";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { editorKeyLane, editorSessionAttach } from "~/state/editorSession";
import { type EditorSessionState } from "~/state/editorSessionFold";
import { projectEnvironment } from "~/state/projects";

import { useScratchpadStore } from "./scratchpadStore";

/** The key lane bounds itself at its one-minute outage limit; this only stops a hung wait. */
const KEYS_LIMIT_MS = 75_000;
/** The host holds Neovim's text up to a second for a cursor read; a snapshot comes after that. */
const SNAPSHOT_LIMIT_MS = 5_000;

interface AbandonedNote {
  readonly environmentId: EnvironmentId;
  /** The Neovim session the overlay typed into (its tab's scratchpad session). */
  readonly sessionThreadId: string;
  readonly cwd: string;
  readonly relativePath: string;
}

let saving: Promise<void> = Promise.resolve();

function withLimit<A>(promise: Promise<A>, limitMs: number, fallback: A): Promise<A> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), limitMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The buffer's lines from a fresh attachment's snapshot, or null when none names this file. */
function freshBufferLines(note: AbandonedNote): Promise<ReadonlyArray<string> | null> {
  const atom = editorSessionAttach({
    environmentId: note.environmentId,
    input: { threadId: note.sessionThreadId },
  });
  const stateOf = (result: AsyncResult.AsyncResult<EditorSessionState, unknown>) =>
    Option.getOrNull(AsyncResult.value(result));
  const before = stateOf(appAtomRegistry.get(atom));
  let release = () => {};
  const arrived = new Promise<ReadonlyArray<string> | null>((resolve) => {
    const unsubscribe = appAtomRegistry.subscribe(atom, (result) => {
      const state = stateOf(result);
      if (state === null || state === before || state.latestEvent?.type !== "snapshot") return;
      unsubscribe();
      resolve(state.relativePath === note.relativePath ? state.lines : null);
    });
    const unmount = appAtomRegistry.mount(atom);
    release = () => {
      unsubscribe();
      unmount();
    };
    appAtomRegistry.refresh(atom);
  });
  return withLimit(arrived, SNAPSHOT_LIMIT_MS, null).finally(() => release());
}

/**
 * Saves a note whose overlay unmounted before its close could settle: a chat view replaced
 * outright (a keyed draft route) takes the overlay and its editor model along. The tab's Neovim
 * session outlives them on the host and holds every key it took, so once those keys are answered
 * its buffer is written, after the file's own queued saves. Opens wait for this (`settledSaves`).
 */
export function saveAbandonedScratchpadNote(note: AbandonedNote): void {
  const run = async () => {
    const lane = editorKeyLane(appAtomRegistry, {
      environmentId: note.environmentId,
      threadId: note.sessionThreadId,
    });
    await withLimit(lane.whenIdle(), KEYS_LIMIT_MS, undefined);
    const lines = await freshBufferLines(note);
    await flushFileSaveSession({
      environmentId: note.environmentId,
      cwd: note.cwd,
      relativePath: note.relativePath,
    });
    if (lines === null) return;
    await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.writeFile,
      {
        environmentId: note.environmentId,
        input: { cwd: note.cwd, relativePath: note.relativePath, contents: lines.join("\n") },
      },
      { label: "scratchpad abandoned note save" },
    );
    useScratchpadStore.getState().noteSaved();
  };
  saving = saving.then(run).catch(() => {});
}

/** Resolves once every abandoned note handed over so far is saved (or given up). */
export function settledSaves(): Promise<void> {
  return saving;
}
