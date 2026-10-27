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
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { editsForLinesEvent, editsForSnapshot, type MonacoEdit } from "./nvimModelSync.ts";
import { toNvimKey } from "./nvimKeymap.ts";
import { monacoFileModelKey } from "../monacoFileModels.ts";
import { caretStyleFor } from "./nvimMode.ts";
import {
  diffWidgets,
  runsFor,
  widgetsFor,
  type DecorationState,
  type OverlayWidget,
} from "./nvimDecorations.ts";
import {
  highlightClassName,
  highlightStylesheet,
  NVIM_JUMPING_CLASS,
} from "./nvimHighlightStyles.ts";
import {
  EMPTY_VIEWPORT_HISTORY,
  followingHidesCaret,
  rememberTopline,
  shouldEchoViewport,
  viewportFromEditor,
  type NvimViewport,
  type ViewportHistory,
} from "./nvimViewport.ts";

/**
 * Monaco driven by the thread's Neovim: every key goes to Neovim and the text comes back, so the
 * developer's own mappings and plugins run. Invariant: with `enabled` false every effect returns
 * before touching the editor and the cleanups remove all widgets, decorations and the stylesheet,
 * so a disabled setting and a Neovim that would not start both leave plain Monaco.
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
  /**
   * Opens the file in the session, handing over the text the client has.
   * Resolves with the lines the session answered with, or null when the open
   * did not succeed.
   */
  readonly openFile: (lines: ReadonlyArray<string>) => Promise<ReadonlyArray<string> | null>;
  /** Raised when the file has to be opened again with nothing else changed. */
  readonly openGeneration: number;
  readonly setCursor: (line: number, col: number) => void;
  /** Tells Neovim which lines the developer can see, and how wide they are. */
  readonly sendViewport: (viewport: NvimViewport) => void;
  /** Writes the pending save now, which is what `:w` means. */
  readonly flushSave: () => void;
  /**
   * The surface's "not the developer typing" flag: `isApplying` keeps an agent's write from being
   * read as composed input, and `run` applies an edit under the same flag.
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
  /**
   * The same state, followed outside React: text, caret and mode apply as each event arrives,
   * because a passive effect runs a commit later (a `j` leaving the view painted its caret about
   * 160 ms late).
   */
  readonly stateSource: NvimDriverStateSource;
}

export interface NvimDriverStateSource {
  readonly get: () => NvimDriverState;
  /** Calls `listener` with every new state, synchronously; returns the unsubscribe. */
  readonly subscribe: (listener: (state: NvimDriverState) => void) => () => void;
}

export interface NvimDriverState {
  readonly relativePath: string | null;
  readonly lines: ReadonlyArray<string>;
  readonly cursor: { readonly line: number; readonly col: number } | null;
  readonly mode: string;
  readonly jumping: boolean;
  readonly topline: number;
  readonly cmdline: EditorCmdline | null;
  readonly message: { readonly kind: string; readonly text: string } | null;
  readonly decorations: DecorationState;
  readonly hlDefs: Readonly<Record<string, EditorHighlightDefinition>>;
  readonly visual: EditorVisual | null;
  readonly writeRequests: number;
  readonly latestEvent: EditorSessionEvent | null;
  readonly sequence: number;
  /** How many snapshots arrived; see `EditorSessionState.snapshots`. */
  readonly snapshots: number;
  /** The lines the last snapshot carried. */
  readonly snapshotLines: ReadonlyArray<string>;
}

/** What the status strip shows, and what the caret looks like. */
export interface NvimDriverResult {
  readonly mode: string;
  /** flash is labelling jump targets. */
  readonly jumping: boolean;
  readonly active: boolean;
  readonly cmdline: EditorCmdline | null;
  readonly message: { readonly kind: string; readonly text: string } | null;
  /**
   * Offers an agent's write to Neovim. True: the caller must not touch the model; the edit returns
   * as a `lines` event and is one undo step in Neovim. False: the driver is inactive and the caller
   * applies the edit.
   */
  readonly takeExternalEdit: (edit: EditorTextEdit) => boolean;
}

export function useNvimDriver(options: NvimDriverOptions): NvimDriverResult {
  const {
    editor,
    model,
    environmentId,
    cwd,
    relativePath,
    enabled,
    state,
    sendKeys,
    openFile,
    openGeneration,
    setCursor,
    sendViewport,
    flushSave,
    externalEdits,
    replaceText,
    isAppShortcut,
    stateSource,
  } = options;
  const [mode, setMode] = useState("n");

  /** Set while Neovim's own text is being written into the model. */
  const applyingNvimEditRef = useRef(false);
  /** The last `state.sequence` this driver reconciled to, for this model. */
  const appliedSequenceRef = useRef<number | null>(null);
  /**
   * The `state.lines` the model last agreed with. The fold reuses the array for events that change
   * no text, so an unchanged identity skips the model read and diff. Cleared whenever the model may
   * have moved without Neovim.
   */
  const appliedLinesRef = useRef<ReadonlyArray<string> | null>(null);
  /** The model those refs describe. */
  const reconciledModelRef = useRef<monaco.editor.ITextModel | null>(null);
  /**
   * The pending open: the model handed to Neovim, the snapshot count then, and the reply's lines.
   * Nothing reconciles until the state carries that answer (a newer snapshot with the reply's
   * lines); an older snapshot would overwrite edits made while modal editing was off.
   */
  const openRef = useRef<PendingOpen | null>(null);
  /** The reconcile the subscription runs, for the open's reply to run too. */
  const reconcileRef = useRef<((state: NvimDriverState) => void) | null>(null);
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
  /**
   * Who moved the view last. Both sides' scroll echoes arrive, and following Neovim after a wheel
   * scroll jumped the view back ("scroll down and it jumps up"), so the view follows Neovim only
   * while keys move it.
   */
  const scrollOwnerRef = useRef<"keys" | "pointer">("keys");
  const flushedWriteRequestsRef = useRef(0);
  const reactId = useId();
  const highlightScope = useMemo(
    () => `mesura-nvim-scope-${reactId.replaceAll(":", "")}`,
    [reactId],
  );

  // Hand the file over whenever the model changes identity, with the model's lines (they may carry
  // edits the `contents` prop lacks). A kept model coming back is reconciled against the session's
  // snapshot, never reset, so its undo stack survives.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: opens the file in the thread's Neovim session when the model changes identity
  useEffect(() => {
    if (!enabled || model === null) return;

    // The path and the model land on different renders: `openFile` changes with the path while
    // `model` is still the previous file's. Opening then sent the old file's text under the new
    // path and overwrote a source file. Wait instead; the matching model arrives a render later.

    // Both sides parsed: the model's URI went through `monaco.Uri.parse`, which normalises it.
    const expected = monaco.Uri.parse(monacoFileModelKey(environmentId, cwd, relativePath));
    if (model.uri.toString() !== expected.toString()) {
      // Normally true for one render during a file switch. If it stays true (a `cwd` or
      // `environmentId` mismatch, a model from another path), modal editing silently never starts.
      if (import.meta.env.DEV) {
        console.warn("nvim: the model does not belong to the open path, so no session was opened", {
          model: model.uri.toString(),
          expected: expected.toString(),
        });
      }
      return;
    }

    // Nothing the session said about the previous file applies to this one, so
    // the next state this driver sees is reconciled in full.
    appliedSequenceRef.current = null;
    appliedLinesRef.current = null;
    appliedCursorRef.current = null;
    // The toplines belong to the file that was open, and a new file whose
    // first topline happens to equal a stale one would be taken for an echo
    // and never applied.
    viewportRef.current = EMPTY_VIEWPORT_HISTORY;
    // A new file opens where Neovim has its cursor, whatever the wheel did to
    // the last one.
    scrollOwnerRef.current = "keys";
    const open: PendingOpen = {
      model,
      snapshotsBefore: stateSource.get().snapshots,
      reply: undefined,
      answered: false,
    };
    openRef.current = open;
    void openFile(model.getLinesContent()).then((lines) => {
      if (openRef.current !== open) return;
      open.reply = lines;
      reconcileRef.current?.(stateSource.get());
    });
    // `openGeneration` is read by nothing here and is still the point: a Retry,
    // or a session that was lost, opens the same file in the same model again.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `openGeneration`, above.
  }, [enabled, model, openFile, openGeneration, environmentId, cwd, relativePath, stateSource]);

  // Keys. `onKeyDown` fires on Monaco's `native-edit-context` node, below the keybinding
  // service's listener, so `preventDefault` and `stopPropagation` here stop both Monaco's commands
  // and the text insertion. It fires only while Monaco has text focus, so keys typed in the
  // composer, the search box or a comment form never reach it.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: routes editor keydowns to Neovim while the driver is active
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
      scrollOwnerRef.current = "keys";
      sendKeys(keys);
    });
    return () => subscription.dispose();
  }, [enabled, editor, sendKeys, isAppShortcut]);

  // Composed text (dead-key accent, input method): a model change that is neither Neovim's edit nor
  // an agent's write is undone locally and sent to Neovim as text; Monaco's undo stack holds only
  // that edit, so the undo is exact. Chromium on a Latin-American layout usually sends `á` as a
  // plain keydown instead, routed as itself.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: sends browser-composed text to Neovim and undoes it locally
  useEffect(() => {
    if (!enabled || model === null) return;
    const subscription = model.onDidChangeContent((event) => {
      if (applyingNvimEditRef.current) return;
      if (externalEdits.isApplying()) {
        // The surface wrote the model itself, so the next state is reconciled
        // in full rather than trusted to match.
        appliedLinesRef.current = null;
        return;
      }
      // Monaco reports changes from the end of the text backwards, so reading
      // them in the order they arrive spells a multi-part composition wrong.
      const composed = [...event.changes]
        .sort((left, right) => left.rangeOffset - right.rangeOffset)
        .map((change) => change.text)
        .join("");
      if (composed.length === 0) return;
      model.undo();
      scrollOwnerRef.current = "keys";
      // A literal `<` opens a key name, and it has the one escape Neovim gives.
      sendKeys(composed.replaceAll("<", "<lt>"));
    });
    return () => subscription.dispose();
  }, [enabled, model, sendKeys, externalEdits]);

  // Applied per event from the subscription (see `stateSource`), and once at setup so a changed
  // model, file or activation catches up at once. Reconciles to the absolute state: a `lines`
  // event is a shortcut only when nothing was missed, checked afterwards; else a full reconcile.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: subscribes to session state outside React so text and caret apply per event
  useLayoutEffect(() => {
    if (!enabled || editor === null || model === null) return;
    if (reconciledModelRef.current !== model) {
      // A model kept from an earlier visit holds whatever it held then.
      reconciledModelRef.current = model;
      appliedLinesRef.current = null;
      appliedSequenceRef.current = null;
      appliedCursorRef.current = null;
    }

    const apply = (edits: ReadonlyArray<MonacoEdit>) =>
      applyNvimEdits(model, edits, applyingNvimEditRef);

    const reconcileText = (state: NvimDriverState): boolean => {
      // The text has not changed since the model last agreed with it.
      if (state.lines === appliedLinesRef.current) return false;
      const event = state.latestEvent;
      const applied = appliedSequenceRef.current;
      // One event, and this driver saw the state before it. Anything else — a
      // first reconcile, events this listener did not see one by one, a model
      // the surface wrote to — is answered by the state itself.
      const isTheOnlyEventSince =
        appliedLinesRef.current !== null &&
        applied !== null &&
        state.sequence === applied + 1 &&
        event !== null &&
        event.type === "lines";
      if (isTheOnlyEventSince && event.type === "lines") {
        let changed = apply(editsForLinesEvent(model.getLineCount(), event));
        if (!modelAgreesAbout(model, state.lines, event)) {
          // The shortcut produced something the state does not agree with. The
          // reconcile below is what makes that a dropped frame rather than a
          // file the developer has to notice is wrong.
          changed = apply(editsForSnapshot(model.getLinesContent(), state.lines)) || changed;
        }
        return changed;
      }
      return apply(editsForSnapshot(model.getLinesContent(), state.lines));
    };

    const reconcile = (state: NvimDriverState) => {
      // Until the session says which file it has open, and while it says a
      // different one, nothing here describes the text on screen. One session
      // serves a whole thread, so a `lines` event still in flight for the file
      // that was open a moment ago would otherwise be written into this one.
      if (state.relativePath !== relativePath) return;
      // Not before the session answered this model's open: see `openRef`.
      const open = openRef.current;
      if (open === null || open.model !== model) return;
      if (!open.answered) {
        if (open.reply === undefined) return;
        if (state.snapshots <= open.snapshotsBefore) return;
        // A failed open has no answer to wait for; the next snapshot will do.
        if (open.reply !== null && !sameLines(state.snapshotLines, open.reply)) return;
        open.answered = true;
      }

      const changed = reconcileText(state);
      appliedLinesRef.current = state.lines;
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
          // The smallest scroll that shows the caret. Neovim's own topline
          // follows in the same frame when the key scrolled, and a centring
          // reveal first made every scroll at the window's edge a jump and a
          // jump back.
          if (scrollOwnerRef.current === "keys") {
            editor.revealPosition(position, monaco.editor.ScrollType.Immediate);
          }
        }
      }

      if (appliedModeRef.current !== state.mode) {
        appliedModeRef.current = state.mode;
        setMode(state.mode);
        editor.updateOptions({ cursorStyle: caretStyleFor(state.mode) });
      }
    };

    const unsubscribe = stateSource.subscribe(reconcile);
    reconcileRef.current = reconcile;
    reconcile(stateSource.get());
    return () => {
      unsubscribe();
      if (reconcileRef.current === reconcile) reconcileRef.current = null;
    };
  }, [enabled, editor, model, relativePath, stateSource]);

  // The window Monaco is showing, told to Neovim.
  //
  // Coalesced to one animation frame because a wheel produces scroll events far
  // faster than a frame, and every one of them would otherwise be a message on
  // the wire and a `winrestview` in Neovim.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: publishes the editor viewport to Neovim, coalesced per animation frame
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
      // Only a pointer scroll may move Neovim's cursor; see `EditorViewportSource`.
      sendViewport({ ...viewport, source: scrollOwnerRef.current });
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

  // `:w`: Neovim asks the host to write. Counted, not read off the latest event, because any event
  // in the same render (cursor, mode, the write's own redraw) would hide the request and the save
  // would never flush.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: flushes a save for each write request Neovim sends
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
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: follows Neovim's topline when a key moved the view
  useEffect(() => {
    if (!enabled || editor === null) return;
    if (state.relativePath !== relativePath) return;
    const topline = state.topline;
    if (!shouldEchoViewport(viewportRef.current, topline)) return;
    viewportRef.current = {
      ...viewportRef.current,
      neovimToplines: rememberTopline(viewportRef.current.neovimToplines, topline),
    };
    if (scrollOwnerRef.current !== "keys") return;
    const targetTop = editor.getTopForLineNumber(topline);
    const caret = editor.getPosition();
    if (
      caret !== null &&
      followingHidesCaret({
        targetTop,
        // The caret's own row: on a wrapped line it can be many rows below
        // the line's first one.
        caretTop: editor.getTopForPosition(caret.lineNumber, caret.column),
        lineHeight: editor.getOption(monaco.editor.EditorOption.lineHeight),
        height: editor.getLayoutInfo().height,
      })
    ) {
      return;
    }
    editor.setScrollTop(targetTop);
  }, [enabled, editor, relativePath, state.relativePath, state.topline]);

  // The pointer takes the view the moment it touches it: a wheel, a trackpad
  // swipe, a drag on the scrollbar, a click in the text.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: hands view ownership to the pointer on wheel, scrollbar drag or click
  useEffect(() => {
    if (!enabled || editor === null) return;
    const container = editor.getContainerDomNode();
    const takeView = () => {
      scrollOwnerRef.current = "pointer";
    };
    const options = { capture: true, passive: true } as const;
    container.addEventListener("wheel", takeView, options);
    container.addEventListener("pointerdown", takeView, options);
    container.addEventListener("touchstart", takeView, options);
    return () => {
      container.removeEventListener("wheel", takeView, options);
      container.removeEventListener("pointerdown", takeView, options);
      container.removeEventListener("touchstart", takeView, options);
    };
  }, [enabled, editor]);

  // The labels are set in the editor's font when they are made, so a zoom or a
  // font change has to reach the ones already on screen too.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: re-fonts the labels on screen when the editor font changes
  useEffect(() => {
    if (!enabled || editor === null) return;
    const subscription = editor.onDidChangeConfiguration((event) => {
      if (!event.hasChanged(monaco.editor.EditorOption.fontInfo)) return;
      for (const { node } of widgetNodesRef.current.values()) applyEditorFont(node, editor);
    });
    return () => subscription.dispose();
  }, [enabled, editor]);

  // Undo has one owner: `Ctrl+Z` stops at `toNvimKey`, and Neovim's edits go through `applyEdits`,
  // so Monaco's history stays inert. REGRESSION: never clear it with `model.setValue(...)` on
  // activation; `setValue` destroys every decoration first, which detached all file comment
  // anchors.

  // Neovim's drawing as Monaco widgets and decorations, diffed against the screen because a
  // re-added widget flickers. This collection is where it all comes down: file switch, driver off,
  // unmount.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: owns the decorations collection and tears down everything drawn
  useEffect(() => {
    if (!enabled || editor === null) return;
    if (model === null) return;
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

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: diffs Neovim's overlays into Monaco content widgets and decorations
  useEffect(() => {
    if (!enabled || editor === null) return;

    // Nothing is drawn for a file the session is not on, and the last file's drawing comes down:
    // returning early once left another file's labels at line numbers that mean something else.
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
      applyEditorFont(node, editor);
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
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: installs the scoped highlight stylesheet on the editor container
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

  // flash's backdrop fades while it waits for a label; the rule that fades it
  // is in the highlight stylesheet and keys on this class.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: toggles the flash jumping class on the editor container
  useEffect(() => {
    if (!enabled || editor === null) return;
    const container = editor.getContainerDomNode();
    container.classList.toggle(NVIM_JUMPING_CLASS, state.jumping);
    return () => container.classList.remove(NVIM_JUMPING_CLASS);
  }, [enabled, editor, state.jumping]);

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: writes Neovim's highlight definitions into the scoped stylesheet node
  useEffect(() => {
    const style = styleRef.current;
    if (style === null) return;
    style.textContent = highlightStylesheet(highlightScope, state.hlDefs);
  }, [highlightScope, state.hlDefs]);

  // Visual mode is Monaco's selection, not a decoration. Neovim's own `Visual`
  // group is on the classifier's deny list for the same reason: two things
  // painting one selection disagree about its edges.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: mirrors Neovim's visual selection as Monaco selections
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
  }, [enabled, editor, model, relativePath, state.relativePath, state.visual]);

  // The mouse is the one place the client tells Neovim where the caret is.
  // Every other cursor movement here is Neovim's own echo coming back.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: sends mouse caret moves to Neovim, the one cursor change the client originates
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
      // The session must have this file open: one session serves the thread, so after a file
      // switch the edit would land in the old file's buffer and be lost for this one.
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
    jumping: enabled && state.jumping,
    active: enabled,
    cmdline: state.cmdline,
    message: state.message,
    takeExternalEdit,
  };
}

/**
 * Whether the model matches the state for the lines an event touched: the line count plus the
 * written lines. A wrong-range edit fails one of the two, at a cost independent of file size.
 */
function modelAgreesAbout(
  model: monaco.editor.ITextModel,
  lines: ReadonlyArray<string>,
  event: { readonly first: number; readonly lines: ReadonlyArray<string> },
): boolean {
  if (model.getLineCount() !== lines.length) return false;
  return event.lines.every((line, index) => model.getLineContent(event.first + 1 + index) === line);
}

interface PendingOpen {
  readonly model: monaco.editor.ITextModel;
  readonly snapshotsBefore: number;
  /** The lines the open answered with; null for a failed open, undefined until it answers. */
  reply: ReadonlyArray<string> | null | undefined;
  answered: boolean;
}

function sameLines(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
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
 * Neovim's selection as Monaco's. Character-wise includes the cursor's character (the later end
 * gains a column), line-wise is whole lines, and block is one range per line. Either end can be
 * the earlier one: an upward selection has its anchor below the cursor.
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

/**
 * Sets a node in the editor's own font so an overlay sits on the text grid. Content widgets live
 * outside `.view-lines` and would inherit the interface font, covering the wrong characters.
 */
function applyEditorFont(node: HTMLElement, editor: monaco.editor.IStandaloneCodeEditor): void {
  const font = editor.getOption(monaco.editor.EditorOption.fontInfo);
  node.style.fontFamily = font.fontFamily;
  node.style.fontSize = `${font.fontSize}px`;
  node.style.fontWeight = font.fontWeight;
  node.style.fontFeatureSettings = font.fontFeatureSettings;
  node.style.lineHeight = `${font.lineHeight}px`;
  node.style.letterSpacing = `${font.letterSpacing}px`;
}

// Neovim owns undo here. Keep the flag's exception cleanup at the imperative
// model boundary, outside the hook that React Compiler analyzes.
function applyNvimEdits(
  model: monaco.editor.ITextModel,
  edits: ReadonlyArray<MonacoEdit>,
  applyingNvimEditRef: RefObject<boolean>,
): boolean {
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
}
