import { useAtomValue } from "@effect/atom-react";
import type { EditorTextEdit, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type * as monaco from "monaco-editor";
import { useCallback, useMemo, useState } from "react";

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
import { fallbackFromCause, type NvimFallback } from "./nvimFallback.ts";
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
   * way. `retryToken` is what a Retry changes, so the effect that opens the
   * file runs again after the developer has fixed the setting.
   */
  const [fallback, setFallback] = useState<NvimFallback | null>(null);
  const [retryToken, setRetryToken] = useState(0);
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
        if (result._tag !== "Failure") return;
        const failure = fallbackFromCause(result.cause);
        if (failure === null) return;
        setFallback(failure);
      });
    },
    // `retryToken` is in here on purpose: a Retry has to make this callback a
    // new one, or the effect that calls it will not run again.
    [openCommand, environmentId, threadId, cwd, relativePath, retryToken],
  );

  const retry = useCallback(() => {
    setFallback(null);
    setRetryToken((token) => token + 1);
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
