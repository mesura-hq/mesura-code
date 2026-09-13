import type {
  EditorCmdline,
  EditorHighlightDefinition,
  EditorSessionEvent,
  EditorVisual,
  EditorTextEdit,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { editsForLinesEvent, editsForSnapshot, type MonacoEdit } from "./nvimModelSync.ts";
import { toNvimKey } from "./nvimKeymap.ts";
import { caretStyleFor } from "./nvimMode.ts";
import {
  diffWidgets,
  runsFor,
  widgetsFor,
  type DecorationState,
  type OverlayWidget,
} from "./nvimDecorations.ts";
import { highlightClassName, highlightStylesheet } from "./nvimHighlightStyles.ts";
import {
  EMPTY_VIEWPORT_HISTORY,
  rememberTopline,
  shouldEchoViewport,
  viewportFromEditor,
  type NvimViewport,
  type ViewportHistory,
} from "./nvimViewport.ts";

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
 * **With `enabled` false, this file has nothing to do with the editor.** That
 * is the invariant the fallback rests on: every effect below returns before it
 * touches anything, the cleanups take down the widgets, the decorations and
 * the stylesheet, and what is left is the plain Monaco the panel was before
 * modal editing existed — the same code, with no branch added to it. A
 * developer who turns the setting off, and a Neovim that would not start, land
 * in exactly the same place.
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
  /** Tells Neovim which lines the developer can see, and how wide they are. */
  readonly sendViewport: (viewport: NvimViewport) => void;
  /** Writes the pending save now, which is what `:w` means. */
  readonly flushSave: () => void;
  /**
   * The surface's own "this edit is not the developer typing" flag.
   *
   * `isApplying` keeps the driver from reading an agent's write as composed
   * input, undoing it and typing it into Neovim one character at a time.
   * `run` lets the driver make an edit of its own under the same flag, which
   * is how the undo-stack reset below avoids being taken for a save.
   */
  readonly externalEdits: {
    readonly isApplying: () => boolean;
    readonly run: (body: () => void) => void;
  };
  /** Hands an agent's edit to Neovim, which echoes it back as one undo step. */
  readonly replaceText: (edits: ReadonlyArray<EditorTextEdit>) => void;
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
  readonly topline: number;
  readonly cmdline: EditorCmdline | null;
  readonly message: { readonly kind: string; readonly text: string } | null;
  readonly decorations: DecorationState;
  readonly hlDefs: Readonly<Record<string, EditorHighlightDefinition>>;
  readonly visual: EditorVisual | null;
  readonly writeRequests: number;
  readonly latestEvent: EditorSessionEvent | null;
  readonly sequence: number;
}

/** What the status strip shows, and what the caret looks like. */
export interface NvimDriverResult {
  readonly mode: string;
  readonly active: boolean;
  readonly cmdline: EditorCmdline | null;
  readonly message: { readonly kind: string; readonly text: string } | null;
  /**
   * Offers an agent's write to Neovim, and says whether it took it.
   *
   * True means the caller must not touch the model: the edit is on its way to
   * Neovim and comes back as a `lines` event, which is what makes it one undo
   * step in the only undo stack that is running. False means the driver is not
   * active and the caller owns the edit as it always did.
   */
  readonly takeExternalEdit: (edit: EditorTextEdit) => boolean;
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
    sendViewport,
    flushSave,
    externalEdits,
    replaceText,
    isAppShortcut,
  } = options;
  const [mode, setMode] = useState("n");

  /** Set while Neovim's own text is being written into the model. */
  const applyingNvimEditRef = useRef(false);
  /** The last `state.sequence` this driver reconciled to, for this model. */
  const appliedSequenceRef = useRef<number | null>(null);
  const appliedCursorRef = useRef<string | null>(null);
  const appliedModeRef = useRef<string | null>(null);
  /** The toplines each side sent recently, which is what makes one an echo. */
  const viewportRef = useRef<ViewportHistory>(EMPTY_VIEWPORT_HISTORY);
  const pendingViewportFrameRef = useRef<number | null>(null);
  const renderedWidgetsRef = useRef<ReadonlyMap<string, OverlayWidget>>(new Map());
  const widgetNodesRef = useRef(
    new Map<string, { widget: monaco.editor.IContentWidget; node: HTMLElement }>(),
  );
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);
  const hadSelectionRef = useRef(false);
  const flushedWriteRequestsRef = useRef(0);
  const reactId = useId();
  const highlightScope = useMemo(
    () => `mesura-nvim-scope-${reactId.replaceAll(":", "")}`,
    [reactId],
  );

  // Hand the file over whenever the model changes identity. The lines come
  // from the model rather than from the `contents` prop, because the model is
  // what the developer is looking at — it may already carry edits the prop
  // does not.
  //
  // This also covers coming back to a model that was kept while the developer
  // was somewhere else. The model outlives the panel now, so a return finds it
  // with its undo stack intact, and the session answers the open with a
  // snapshot that the driver reconciles against — no reset, and nothing that
  // would empty a stack the whole registry exists to keep.
  useEffect(() => {
    if (!enabled || model === null) return;
    // Nothing the session said about the previous file applies to this one, so
    // the next state this driver sees is reconciled in full.
    appliedSequenceRef.current = null;
    appliedCursorRef.current = null;
    // The toplines belong to the file that was open, and a new file whose
    // first topline happens to equal a stale one would be taken for an echo
    // and never applied.
    viewportRef.current = EMPTY_VIEWPORT_HISTORY;
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
      if (externalEdits.isApplying()) return;
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
  }, [enabled, model, sendKeys, externalEdits]);

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

  // The window Monaco is showing, told to Neovim.
  //
  // Coalesced to one animation frame because a wheel produces scroll events far
  // faster than a frame, and every one of them would otherwise be a message on
  // the wire and a `winrestview` in Neovim.
  useEffect(() => {
    if (!enabled || editor === null || model === null) return;

    const publish = () => {
      pendingViewportFrameRef.current = null;
      const viewport = viewportFromEditor(
        editor.getVisibleRanges(),
        {
          height: editor.getLayoutInfo().height,
          lineHeight: editor.getOption(monaco.editor.EditorOption.lineHeight),
        },
        model,
      );
      viewportRef.current = {
        ...viewportRef.current,
        sentToplines: rememberTopline(viewportRef.current.sentToplines, viewport.topline),
      };
      sendViewport(viewport);
    };

    const schedule = () => {
      if (pendingViewportFrameRef.current !== null) return;
      pendingViewportFrameRef.current = requestAnimationFrame(publish);
    };

    schedule();
    const subscriptions = [editor.onDidScrollChange(schedule), editor.onDidLayoutChange(schedule)];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      if (pendingViewportFrameRef.current !== null) {
        cancelAnimationFrame(pendingViewportFrameRef.current);
        pendingViewportFrameRef.current = null;
      }
    };
  }, [enabled, editor, model, sendViewport]);

  // `:w`. Neovim asks the host to write, because the host owns the file.
  //
  // Counted rather than read off the latest event. A write request followed in
  // the same render by anything at all — a cursor move, the mode leaving the
  // command line, the redraw the write itself caused — leaves the latest event
  // pointing at that other thing, and the save is never flushed while the
  // developer has been told it was.
  useEffect(() => {
    if (!enabled) return;
    if (state.writeRequests === flushedWriteRequestsRef.current) return;
    flushedWriteRequestsRef.current = state.writeRequests;
    if (state.writeRequests === 0) return;
    flushSave();
  }, [enabled, state.writeRequests, flushSave]);

  // The window Neovim is showing, told to Monaco.
  //
  // Only when a key caused it. `shouldEchoViewport` drops a topline that is
  // either the one this client just sent or the one Neovim last sent, which is
  // what stops the two scrolling each other forever.
  useEffect(() => {
    if (!enabled || editor === null) return;
    if (state.relativePath !== relativePath) return;
    const topline = state.topline;
    if (!shouldEchoViewport(viewportRef.current, topline)) return;
    viewportRef.current = {
      ...viewportRef.current,
      neovimToplines: rememberTopline(viewportRef.current.neovimToplines, topline),
    };
    editor.setScrollTop(editor.getTopForLineNumber(topline));
  }, [enabled, editor, relativePath, state.relativePath, state.topline]);

  // Undo has one owner, and never both at once — and the way to keep it that
  // way is to take nothing away rather than to reset anything.
  //
  // Monaco's `undo` cannot act while the driver is running: `Ctrl+Z` reaches
  // `toNvimKey` and is stopped before the keybinding service sees it, and
  // every edit from Neovim goes through `applyEdits`, which records nothing.
  //
  // REGRESSION: an earlier version of this phase cleared the model's history on
  // both edges of activation with `model.setValue(model.getValue())`, which is
  // the only public way to clear it. Monaco's `setValue` destroys every
  // decoration on the model before it clears the history — `textModel.js`
  // says so in as many words, "Destroy all my decorations" — and the file
  // comments' anchors are decorations. Toggling modal editing on a file with
  // comments silently detached every one of them. Do not put it back: the
  // history it removed was inert, and the decorations it removed were not.
  // Everything Neovim drew over the text, as Monaco's own furniture: the
  // labels as content widgets, the highlight runs as decorations.
  //
  // Diffed against what is on screen rather than rebuilt. A content widget
  // taken out and put back flickers, and flash rewrites its labels on every
  // keystroke of a search — so a label that was already in the right place
  // keeps its node and only its text changes.
  useEffect(() => {
    if (!enabled || editor === null) return;

    // Nothing is drawn for a file the session is not on, and — the part that
    // was missing — whatever was drawn for the last one comes down. Returning
    // early left the previous file's labels on screen, anchored to line and
    // column numbers that now mean something else entirely, which is how a
    // hint belonging to another file came to sit in the middle of this one.
    const desired =
      state.relativePath === relativePath
        ? widgetsFor(state.decorations)
        : new Map<string, OverlayWidget>();
    const { addedWidgets, changedWidgets, removedWidgetIds } = diffWidgets(
      renderedWidgetsRef.current,
      desired,
    );

    for (const id of removedWidgetIds) {
      const existing = widgetNodesRef.current.get(id);
      if (existing === undefined) continue;
      editor.removeContentWidget(existing.widget);
      widgetNodesRef.current.delete(id);
    }
    for (const overlay of changedWidgets) {
      const existing = widgetNodesRef.current.get(overlay.id);
      if (existing === undefined) continue;
      existing.node.textContent = overlay.text;
      existing.node.className = `mesura-nvim-overlay ${highlightClassName(overlay.hl)}`;
    }
    for (const overlay of addedWidgets) {
      const node = document.createElement("div");
      node.textContent = overlay.text;
      node.className = `mesura-nvim-overlay ${highlightClassName(overlay.hl)}`;
      const widget: monaco.editor.IContentWidget = {
        getId: () => overlay.id,
        getDomNode: () => node,
        getPosition: () => ({
          position: { lineNumber: overlay.line, column: overlay.col },
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        }),
      };
      editor.addContentWidget(widget);
      widgetNodesRef.current.set(overlay.id, { widget, node });
    }
    renderedWidgetsRef.current = new Map(desired);

    decorationsRef.current?.set(
      (state.relativePath === relativePath ? runsFor(state.decorations) : []).map((run) => ({
        range: {
          startLineNumber: run.line,
          startColumn: run.startCol,
          endLineNumber: run.line,
          endColumn: run.endCol,
        },
        options: { inlineClassName: highlightClassName(run.hl) },
      })),
    );
    // `state.decorations`, not `state.sequence`. The sequence moves for every
    // event of any kind — a cursor, a mode, a viewport — and keying on it
    // would rebuild Monaco's decorations collection on each one, which is a
    // repaint per wire message for a drawing that did not change.
  }, [enabled, editor, relativePath, state.relativePath, state.decorations]);

  // The colours those drawings refer to, as one stylesheet per surface.
  //
  // Scoped by a class on the editor's own container, because two file panels
  // on two threads are two Neovims and highlight id 7 means something
  // different in each.
  useEffect(() => {
    if (!enabled || editor === null) return;
    const container = editor.getContainerDomNode();
    container.classList.add(highlightScope);
    const style = document.createElement("style");
    style.setAttribute("data-nvim-hl-scope", highlightScope);
    document.head.append(style);
    styleRef.current = style;
    return () => {
      style.remove();
      styleRef.current = null;
      container.classList.remove(highlightScope);
    };
  }, [enabled, editor, highlightScope]);

  useEffect(() => {
    const style = styleRef.current;
    if (style === null) return;
    style.textContent = highlightStylesheet(highlightScope, state.hlDefs);
  }, [highlightScope, state.hlDefs]);

  // The decorations collection, and the one place everything drawn is taken
  // down: a file switch, the driver going quiet, the surface going away.
  useEffect(() => {
    if (!enabled || editor === null) return;
    decorationsRef.current = editor.createDecorationsCollection([]);
    return () => {
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      for (const { widget } of widgetNodesRef.current.values()) {
        editor.removeContentWidget(widget);
      }
      widgetNodesRef.current.clear();
      renderedWidgetsRef.current = new Map();
    };
  }, [enabled, editor, model]);

  // Visual mode is Monaco's selection, not a decoration. Neovim's own `Visual`
  // group is on the classifier's deny list for the same reason: two things
  // painting one selection disagree about its edges.
  useEffect(() => {
    if (!enabled || editor === null || model === null) return;
    if (state.relativePath !== relativePath) return;
    const visual = state.visual;
    if (visual === null) {
      if (!hadSelectionRef.current) return;
      hadSelectionRef.current = false;
      const position = editor.getPosition();
      if (position !== null) editor.setSelection({ ...position, ...positionAsRange(position) });
      return;
    }
    hadSelectionRef.current = true;
    editor.setSelections(selectionsForVisual(visual, model));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, editor, model, relativePath, state.relativePath, state.visual]);

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

  const takeExternalEdit = useCallback(
    (edit: EditorTextEdit) => {
      if (!enabled) return false;
      // The session has to have *this* file open. One session serves the whole
      // thread, so between a file switch and the session catching up, an edit
      // sent now would be written into the buffer that is still attached —
      // corrupting the file the developer just left, and losing the write for
      // the one they are looking at, because the caller trusts this answer and
      // leaves its own model alone.
      if (state.relativePath !== relativePath) return false;
      // One edit, applied inside Neovim, which is what makes it one `u`. The
      // model is deliberately left alone: the `lines` event coming back is what
      // writes it, and writing it here as well would show the change twice and
      // leave Monaco's caret mapped through an edit Neovim never made.
      replaceText([edit]);
      return true;
    },
    [enabled, replaceText, relativePath, state.relativePath],
  );

  return {
    mode,
    active: enabled,
    cmdline: state.cmdline,
    message: state.message,
    takeExternalEdit,
  };
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

/** A collapsed range at a position, which is what leaving visual mode leaves. */
function positionAsRange(position: monaco.IPosition) {
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

/**
 * Neovim's selection, as Monaco's.
 *
 * Three shapes, and the differences are not cosmetic. Vim's character-wise
 * selection includes the character under the cursor, so the later end gains a
 * column; a line-wise selection is whole lines whatever the columns say; and a
 * block is not one range at all but one per line, which is the only way Monaco
 * can draw a column.
 *
 * Either end can be the earlier one: a selection made upwards has its anchor
 * below its cursor, and taking the anchor as the start would draw nothing.
 */
function selectionsForVisual(
  visual: EditorVisual,
  model: monaco.editor.ITextModel,
): monaco.ISelection[] {
  const anchor = visual.anchor;
  const cursor = visual.cursor;
  const forwards =
    anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col);
  const start = forwards ? anchor : cursor;
  const end = forwards ? cursor : anchor;

  if (visual.kind.startsWith("V")) {
    return [
      {
        selectionStartLineNumber: start.line,
        selectionStartColumn: 1,
        positionLineNumber: end.line,
        positionColumn: model.getLineMaxColumn(Math.min(end.line, model.getLineCount())),
      },
    ];
  }

  if (visual.kind.charCodeAt(0) === VISUAL_BLOCK_CODE) {
    const left = Math.min(start.col, end.col);
    const right = Math.max(start.col, end.col) + 1;
    const selections: monaco.ISelection[] = [];
    for (let line = start.line; line <= end.line; line += 1) {
      if (line > model.getLineCount()) break;
      const maxColumn = model.getLineMaxColumn(line);
      selections.push({
        selectionStartLineNumber: line,
        selectionStartColumn: Math.min(left, maxColumn),
        positionLineNumber: line,
        positionColumn: Math.min(right, maxColumn),
      });
    }
    return selections.length === 0
      ? [
          {
            selectionStartLineNumber: start.line,
            selectionStartColumn: start.col,
            positionLineNumber: start.line,
            positionColumn: start.col,
          },
        ]
      : selections;
  }

  return [
    {
      selectionStartLineNumber: start.line,
      selectionStartColumn: start.col,
      positionLineNumber: end.line,
      positionColumn: Math.min(
        end.col + 1,
        model.getLineMaxColumn(Math.min(end.line, model.getLineCount())),
      ),
    },
  ];
}

/** Neovim reports visual block as the literal Ctrl-V character. */
const VISUAL_BLOCK_CODE = 22;
