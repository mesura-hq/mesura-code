import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EditorTextEdit, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveShortcutCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  editorSessionAttach,
  editorSessionInput,
  editorSessionOpen,
  editorSessionReplaceText,
  editorSessionSetCursor,
  editorSessionViewport,
  EMPTY_EDITOR_SESSION_STATE,
  type EditorSessionState,
} from "~/state/editorSession";
import { fallbackFromCause, isSessionMissing, type NvimFallback } from "./nvimFallback.ts";
import { useNvimDriver, type NvimDriverResult } from "./useNvimDriver.ts";
import { APP_SHORTCUTS_THAT_OUTRANK_NEOVIM } from "./appShortcutsThatOutrankNeovim";

/**
 * Binds the thread's editor session to a Monaco editor.
 *
 * The split is deliberate: everything that talks to the wire lives here, and
 * everything that talks to Monaco lives in `useNvimDriver`. The driver is the
 * part with the awkward reasoning — the key race, the undo stack, composition
 * — and keeping the subscription out of it is what lets that reasoning be
 * read without an atom runtime in the way.
 */

/**
 * How many times in a row a lost session is reopened without one working in
 * between. Past it the panel falls back to the plain editor with a Retry,
 * rather than reopening forever against a server that keeps dropping it.
 */
const MAX_AUTOMATIC_REOPENS = 3;

const IDLE_SESSION_ATOM = Atom.make(AsyncResult.initial<EditorSessionState, never>(false)).pipe(
  Atom.withLabel("editor-session:idle"),
);

export interface NvimFileEditorResult extends NvimDriverResult {
  /** Why Neovim is not running, when the developer asked for it and it is not. */
  readonly fallback: NvimFallback | null;
  /** Tries again, after the setting that broke it has been fixed. */
  readonly retry: () => void;
}

export interface NvimFileEditorInput {
  readonly editor: monaco.editor.IStandaloneCodeEditor | null;
  readonly model: monaco.editor.ITextModel | null;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly enabled: boolean;
  /** The surface's own "this edit is not the developer typing" flag. */
  readonly externalEdits: {
    readonly isApplying: () => boolean;
    readonly run: (body: () => void) => void;
  };
  /** Writes the pending save now, which is what `:w` means. */
  readonly flushSave: () => void;
}

export function useNvimFileEditor(input: NvimFileEditorInput): NvimFileEditorResult {
  const { editor, model, environmentId, threadRef, cwd, relativePath } = input;
  const threadId = threadRef.threadId;

  /**
   * Why Neovim is not running, when it is not.
   *
   * Held here rather than in the driver because it decides whether the driver
   * runs at all: a session that could not start leaves the panel as the plain
   * editor it was before, and the driver is the thing that must not be in the
   * way.
   */
  const [fallback, setFallback] = useState<NvimFallback | null>(null);
  /**
   * Raised to make the driver open the file again: by a Retry, and when the
   * session is lost.
   *
   * A value the driver's open effect depends on, not a dependency smuggled into
   * `openFile`'s list. REGRESSION: that is how Retry was first written, and
   * the React Compiler drops a `useCallback` dependency the body never reads,
   * so the callback never changed and nothing reopened. Retry only appeared to
   * work because it also turns the driver off and on.
   */
  const [openGeneration, setOpenGeneration] = useState(0);
  const enabled = input.enabled && fallback === null;

  // Not subscribed at all while modal editing is off, so a developer who does
  // not use it never starts a Neovim.
  const atom = enabled
    ? editorSessionAttach({ environmentId, input: { threadId } })
    : IDLE_SESSION_ATOM;
  const result = useAtomValue(atom);
  const state =
    (Option.getOrNull(AsyncResult.value(result)) as EditorSessionState | null) ??
    EMPTY_EDITOR_SESSION_STATE;

  /**
   * Opening the file again once its session is gone.
   *
   * A session goes with the server that held it — a restart, the desktop app
   * replacing its backend — and the server also ends one on purpose. Either way
   * the attachment has nothing left to follow, and every key sent after that
   * failed with nobody told. The client holds what a new session needs — the
   * file, the project, the text on screen — so it reopens: the same open a file
   * switch does, through `openGeneration`, and then a fresh attachment, because
   * the old stream has ended or failed for good.
   *
   * Not after `gave-up`. That is a Neovim that kept exiting, and reopening it
   * would only repeat that, so the panel falls back and offers Retry instead.
   */
  const refreshAttach = useAtomRefresh(atom);
  // A ref, so a new refresh function never makes `openFile` a new callback:
  // the driver opens the file again whenever that identity changes.
  const refreshAttachRef = useRef(refreshAttach);
  useEffect(() => {
    refreshAttachRef.current = refreshAttach;
  }, [refreshAttach]);
  const reattachAfterOpenRef = useRef(false);
  const reopensInARowRef = useRef(0);
  const sessionLost =
    enabled &&
    (state.ended === "closed" || (AsyncResult.isFailure(result) && isSessionMissing(result.cause)));
  const sessionGaveUp = enabled && state.ended === "gave-up";

  useEffect(() => {
    // An open is already on its way, and the attachment is replaced after it.
    // Until then the state is the old stream's, which is what said "gone".
    if (reattachAfterOpenRef.current) return;
    if (sessionGaveUp) {
      setFallback({ reason: "spawn-failed", detail: "it kept exiting, so it was not restarted" });
      return;
    }
    if (!sessionLost) return;
    if (reopensInARowRef.current >= MAX_AUTOMATIC_REOPENS) {
      setFallback({ reason: "spawn-failed", detail: "its session kept disappearing" });
      return;
    }
    reopensInARowRef.current += 1;
    reattachAfterOpenRef.current = true;
    setOpenGeneration((generation) => generation + 1);
  }, [sessionLost, sessionGaveUp]);

  // A session that answers resets the count: the next loss is a new one.
  useEffect(() => {
    if (state.sequence > 0 && state.ended === null) reopensInARowRef.current = 0;
  }, [state.sequence, state.ended]);

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isAppShortcut = useCallback(
    (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: false },
      });
      return command !== null && APP_SHORTCUTS_THAT_OUTRANK_NEOVIM.has(command);
    },
    [keybindings],
  );

  const openCommand = useAtomCommand(editorSessionOpen, "editor session open");
  const inputCommand = useAtomCommand(editorSessionInput, "editor session input");
  const setCursorCommand = useAtomCommand(editorSessionSetCursor, "editor session set cursor");
  const viewportCommand = useAtomCommand(editorSessionViewport, "editor session viewport");
  const replaceTextCommand = useAtomCommand(
    editorSessionReplaceText,
    "editor session replace text",
  );

  const openFile = useCallback(
    (lines: ReadonlyArray<string>) => {
      void openCommand({
        environmentId,
        input: { threadId, cwd, relativePath, lines: [...lines] },
      }).then((result) => {
        // After the open, not alongside it: an attachment that reaches the
        // server first finds no session and fails again.
        if (reattachAfterOpenRef.current) {
          reattachAfterOpenRef.current = false;
          refreshAttachRef.current();
        }
        if (result._tag !== "Failure") return;
        const failure = fallbackFromCause(result.cause);
        if (failure === null) return;
        setFallback(failure);
      });
    },
    [openCommand, environmentId, threadId, cwd, relativePath],
  );

  const retry = useCallback(() => {
    reopensInARowRef.current = 0;
    reattachAfterOpenRef.current = true;
    setFallback(null);
    setOpenGeneration((generation) => generation + 1);
  }, []);

  const sendKeys = useCallback(
    (keys: string) => {
      void inputCommand({ environmentId, input: { threadId, keys } });
    },
    [inputCommand, environmentId, threadId],
  );

  const setCursor = useCallback(
    (line: number, col: number) => {
      void setCursorCommand({ environmentId, input: { threadId, line, col } });
    },
    [setCursorCommand, environmentId, threadId],
  );

  const sendViewport = useCallback(
    (viewport: { topline: number; rows: number; cols: number }) => {
      void viewportCommand({
        environmentId,
        input: { threadId, topline: viewport.topline, rows: viewport.rows, cols: viewport.cols },
      });
    },
    [viewportCommand, environmentId, threadId],
  );

  const replaceText = useCallback(
    (edits: ReadonlyArray<EditorTextEdit>) => {
      void replaceTextCommand({ environmentId, input: { threadId, edits: [...edits] } });
    },
    [replaceTextCommand, environmentId, threadId],
  );

  const driverState = useMemo(
    () => ({
      relativePath: state.relativePath,
      lines: state.lines,
      cursor: state.cursor,
      mode: state.mode,
      jumping: state.jumping,
      topline: state.topline,
      cmdline: state.cmdline,
      message: state.message,
      decorations: state.decorations,
      hlDefs: state.hlDefs,
      visual: state.visual,
      writeRequests: state.writeRequests,
      latestEvent: state.latestEvent,
      sequence: state.sequence,
    }),
    [state],
  );

  const driver = useNvimDriver({
    editor,
    model,
    environmentId,
    threadRef,
    cwd,
    relativePath,
    enabled,
    sendKeys,
    openFile,
    openGeneration,
    setCursor,
    sendViewport,
    flushSave: input.flushSave,
    externalEdits: input.externalEdits,
    replaceText,
    isAppShortcut,
    state: driverState,
  });

  return { ...driver, fallback, retry };
}
