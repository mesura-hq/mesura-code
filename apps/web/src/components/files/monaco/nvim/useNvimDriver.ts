import type { EditorSessionEvent, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type * as monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";

import { editsForLinesEvent, editsForSnapshot, type MonacoEdit } from "./nvimModelSync.ts";
import { toNvimKey } from "./nvimKeymap.ts";
import { caretStyleFor } from "./nvimMode.ts";

/**
 * Monaco, driven by the thread's Neovim.
 *
 * The naive branch, which phase 3's measurements chose: every key goes to
 * Neovim and the text comes back. Monaco never decides what a keystroke means,
 * so the developer's own mappings, operators and plugins are the ones running.
 *
 * Four things in here are less obvious than they look.
 *
 * **Winning the key race.** `editor.onKeyDown` fires from the listener Monaco
 * installs on its `native-edit-context` node, which is below the keybinding
 * service's own listener on the container. Calling `preventDefault` and
 * `stopPropagation` on the browser event there stops both Monaco's commands
 * and the text insertion that would otherwise follow. It also closes the
 * composer hazard by construction: `onKeyDown` only fires while Monaco has
 * text focus, so a key typed into the composer, the search box or a comment
 * form is never seen here at all.
 *
 * **Reconciling to the state, not applying the event.** The session's state is
 * absolute — it carries the lines themselves. A `lines` event is taken as a
 * shortcut to the same answer and only when the driver can see it missed
 * nothing, and the result is checked against the state afterwards. Anything
 * else is a full reconcile. Two events landing between two renders, an event
 * whose arithmetic is wrong, a client that reattached mid-edit: all of them
 * end at the same place instead of at a model that has quietly drifted.
 *
 * **Keeping Monaco's undo stack empty.** Edits are applied with `applyEdits`
 * and never `pushEditOperations`. Undo belongs to Neovim while Neovim is
 * driving, and a Monaco stack with anything on it would let `Ctrl+Z` undo
 * something Neovim still believes is there.
 *
 * **Letting composition through.** A dead-key accent is not routed when the
 * browser reports one: those keydowns return null from `toNvimKey`, Monaco
 * inserts the composed character locally, and the resulting model change is
 * caught below, undone, and sent to Neovim as text. On Chromium under a
 * Latin-American layout the accent usually resolves in the layout instead and
 * arrives as an ordinary keydown for `á`, which is routed as itself. Both
 * paths put the character in the buffer once.
 */

export interface NvimDriverOptions {
  readonly editor: monaco.editor.IStandaloneCodeEditor | null;
  readonly model: monaco.editor.ITextModel | null;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string;
  readonly relativePath: string;
  readonly enabled: boolean;
  /** Sends keys to the session. Returns once they are accepted, not applied. */
  readonly sendKeys: (keys: string) => void;
  /** Opens the file in the session, handing over the text the client has. */
  readonly openFile: (lines: ReadonlyArray<string>) => void;
  readonly setCursor: (line: number, col: number) => void;
  /**
   * True while the surface is writing an agent's change into the model.
   *
   * Without it the driver reads that write as composed input, undoes it, and
   * types the agent's text into Neovim one character at a time.
   */
  readonly isApplyingExternalEdit: () => boolean;
  /**
   * True for a key the application answers itself.
   *
   * Only the shortcuts that leave the file, and only where Neovim does not
   * want the key — see `useNvimFileEditor`, which decides the set.
   */
  readonly isAppShortcut: (event: KeyboardEvent) => boolean;
  /** The session's state, as the attach subscription folded it. */
  readonly state: NvimDriverState;
}

export interface NvimDriverState {
  readonly relativePath: string | null;
  readonly lines: ReadonlyArray<string>;
  readonly cursor: { readonly line: number; readonly col: number } | null;
  readonly mode: string;
  readonly latestEvent: EditorSessionEvent | null;
  readonly sequence: number;
}

/** What the status strip shows, and what the caret looks like. */
export interface NvimDriverResult {
  readonly mode: string;
  readonly active: boolean;
}

export function useNvimDriver(options: NvimDriverOptions): NvimDriverResult {
  const {
    editor,
    model,
    relativePath,
    enabled,
    state,
    sendKeys,
    openFile,
    setCursor,
    isApplyingExternalEdit,
    isAppShortcut,
  } = options;
  const [mode, setMode] = useState("n");

  /** Set while Neovim's own text is being written into the model. */
  const applyingNvimEditRef = useRef(false);
  /** The last `state.sequence` this driver reconciled to, for this model. */
  const appliedSequenceRef = useRef<number | null>(null);
  const appliedCursorRef = useRef<string | null>(null);
  const appliedModeRef = useRef<string | null>(null);

  // Hand the file over whenever the model changes identity. The lines come
  // from the model rather than from the `contents` prop, because the model is
  // what the developer is looking at — it may already carry edits the prop
  // does not.
  useEffect(() => {
    if (!enabled || model === null) return;
    // Nothing the session said about the previous file applies to this one, so
    // the next state this driver sees is reconciled in full.
    appliedSequenceRef.current = null;
    appliedCursorRef.current = null;
    openFile(model.getLinesContent());
  }, [enabled, model, openFile]);

  // Keys.
  useEffect(() => {
    if (!enabled || editor === null) return;
    const subscription = editor.onKeyDown((event) => {
      // The application's own shortcut, before anything else looks at the key:
      // leaving it alone is what lets it bubble to the listener on `window`.
      if (isAppShortcut(event.browserEvent)) return;

      const keys = toNvimKey({
        key: event.browserEvent.key,
        code: event.browserEvent.code,
        ctrlKey: event.browserEvent.ctrlKey,
        altKey: event.browserEvent.altKey,
        metaKey: event.browserEvent.metaKey,
        shiftKey: event.browserEvent.shiftKey,
        keyCode: event.browserEvent.keyCode,
        isComposing: event.browserEvent.isComposing,
      });
      // Null means the key is not ours: it belongs to a composition, to the
      // application's own shortcuts, or to nothing at all. Letting it through
      // is what keeps dead keys and the command palette working.
      if (keys === null) return;

      event.browserEvent.preventDefault();
      event.browserEvent.stopPropagation();
      sendKeys(keys);
    });
    return () => subscription.dispose();
  }, [enabled, editor, sendKeys, isAppShortcut]);

  // Composed text. Anything that reaches the model while Neovim is driving,
  // and is neither Neovim's own edit nor the surface writing an agent's
  // change, was composed by the browser — a dead-key accent, an input method.
  // Monaco's undo stack holds only that edit, because nothing else pushes to
  // it here, so undoing it is exact.
  useEffect(() => {
    if (!enabled || model === null) return;
    const subscription = model.onDidChangeContent((event) => {
      if (applyingNvimEditRef.current) return;
      if (isApplyingExternalEdit()) return;
      // Monaco reports changes from the end of the text backwards, so reading
      // them in the order they arrive spells a multi-part composition wrong.
      const composed = [...event.changes]
        .sort((left, right) => left.rangeOffset - right.rangeOffset)
        .map((change) => change.text)
        .join("");
      if (composed.length === 0) return;
      model.undo();
      // A literal `<` opens a key name, and it has the one escape Neovim gives.
      sendKeys(composed.replaceAll("<", "<lt>"));
    });
    return () => subscription.dispose();
  }, [enabled, model, sendKeys, isApplyingExternalEdit]);

  // Text, cursor and mode coming back.
  useEffect(() => {
    if (!enabled || editor === null || model === null) return;
    // Until the session says which file it has open, and while it says a
    // different one, nothing here describes the text on screen. One session
    // serves a whole thread, so a `lines` event still in flight for the file
    // that was open a moment ago would otherwise be written into this one.
    if (state.relativePath !== relativePath) return;

    const apply = (edits: ReadonlyArray<MonacoEdit>) => {
      if (edits.length === 0) return false;
      applyingNvimEditRef.current = true;
      try {
        // `applyEdits`, never `pushEditOperations`: undo is Neovim's while
        // Neovim drives, and anything on Monaco's stack would let Ctrl+Z take
        // back an edit Neovim still believes is there.
        model.applyEdits(edits as monaco.editor.IIdentifiedSingleEditOperation[]);
      } finally {
        applyingNvimEditRef.current = false;
      }
      return true;
    };

    const event = state.latestEvent;
    const applied = appliedSequenceRef.current;
    // One event, and this driver saw the state before it. Anything else — a
    // first reconcile, a coalesced pair of events, an event that is not a line
    // change — is answered by the state itself.
    const isTheOnlyEventSince =
      applied !== null &&
      state.sequence === applied + 1 &&
      event !== null &&
      event.type === "lines";

    let changed = false;
    if (isTheOnlyEventSince && event !== null && event.type === "lines") {
      changed = apply(editsForLinesEvent(model.getLineCount(), event));
      if (!modelAgreesAbout(model, state.lines, event)) {
        // The shortcut produced something the state does not agree with. The
        // reconcile below is what makes that a dropped frame rather than a
        // file the developer has to notice is wrong.
        changed = apply(editsForSnapshot(model.getLinesContent(), state.lines)) || changed;
      }
    } else {
      changed = apply(editsForSnapshot(model.getLinesContent(), state.lines));
    }
    appliedSequenceRef.current = state.sequence;

    const cursor = state.cursor;
    if (cursor !== null) {
      const key = `${cursor.line}:${cursor.col}`;
      // After text lands, Monaco has moved the caret itself by mapping it
      // through the edit, so the position is re-asserted even when Neovim
      // reports the same one it reported before.
      if (changed || appliedCursorRef.current !== key) {
        appliedCursorRef.current = key;
        const position = { lineNumber: cursor.line, column: cursor.col };
        editor.setPosition(position);
        editor.revealPositionInCenterIfOutsideViewport(position);
      }
    }

    if (appliedModeRef.current !== state.mode) {
      appliedModeRef.current = state.mode;
      setMode(state.mode);
      editor.updateOptions({ cursorStyle: caretStyleFor(state.mode) });
    }
    // `state.sequence` is the dependency that matters: the state can be
    // identical to the last one and still be a new event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, editor, model, relativePath, state.sequence]);

  // The mouse is the one place the client tells Neovim where the caret is.
  // Every other cursor movement here is Neovim's own echo coming back.
  useEffect(() => {
    if (!enabled || editor === null) return;
    const subscription = editor.onDidChangeCursorPosition((event) => {
      if (applyingNvimEditRef.current) return;
      if (event.source !== "mouse") return;
      setCursor(event.position.lineNumber, event.position.column);
    });
    return () => subscription.dispose();
  }, [enabled, editor, setCursor]);

  return { mode, active: enabled };
}

/**
 * Whether the model now says what the state says, for the lines an event
 * touched.
 *
 * The cheap half of a comparison nobody wants to make in full on every
 * keystroke: the line count, plus the lines the event claimed to write. An
 * edit that reached the wrong range fails one of the two, and a 100,000-line
 * file costs the same as a three-line one.
 */
function modelAgreesAbout(
  model: monaco.editor.ITextModel,
  lines: ReadonlyArray<string>,
  event: { readonly first: number; readonly lines: ReadonlyArray<string> },
): boolean {
  if (model.getLineCount() !== lines.length) return false;
  return event.lines.every((line, index) => model.getLineContent(event.first + 1 + index) === line);
}
