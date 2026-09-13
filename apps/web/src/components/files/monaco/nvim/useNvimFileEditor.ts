import { useAtomValue } from "@effect/atom-react";
import type { EditorTextEdit, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type * as monaco from "monaco-editor";
import { useCallback, useMemo } from "react";

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
import { useNvimDriver, type NvimDriverResult } from "./useNvimDriver.ts";

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

/**
 * The application's shortcuts that outrank Neovim while the editor has focus.
 *
 * One entry, and the list is short because it was measured rather than
 * guessed. In the developer's configuration `<C-p>` is unmapped, so the file
 * picker costs Neovim nothing. `<C-k>` is `TmuxNavigateUp`, `<C-b>` is
 * Telescope, `<C-f>` is his file finder and `<C-u>`/`<C-d>` are the scrolling
 * half the motion set depends on — every one of those stays Neovim's, and the
 * application's own version is reached by pressing Escape in normal mode
 * first, which releases the editor.
 */
const APP_SHORTCUTS_THAT_OUTRANK_NEOVIM: ReadonlySet<string> = new Set(["filePicker.toggle"]);

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

export function useNvimFileEditor(input: NvimFileEditorInput): NvimDriverResult {
  const { editor, model, environmentId, threadRef, cwd, relativePath, enabled } = input;
  const threadId = threadRef.threadId;

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
      });
    },
    [openCommand, environmentId, threadId, cwd, relativePath],
  );

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
      latestEvent: state.latestEvent,
      sequence: state.sequence,
    }),
    [state],
  );

  return useNvimDriver({
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
}
