import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as monaco from "monaco-editor";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DraftId } from "~/composerDraftStore";

import { useClientSettings } from "~/hooks/useSettings";

import type { FileEditorRetention } from "../fileEditorRetention";
import { NvimStatusStrip } from "./nvim/NvimStatusStrip";
import { useNvimFileEditor } from "./nvim/useNvimFileEditor";
import { installFileEditorDismissal } from "../fileEditorDismissal";
import { setProjectFileQueryData } from "../projectFilesQueryState";
import { useFileSaveCoordinator } from "../useFileSaveCoordinator";
import { minimalTextEdit } from "./monacoFileEdit";
import { ensureMonacoEnvironment } from "./monacoEnvironment";
import { useMonacoFileComments } from "./monacoFileComments";
import { languageIdForPath } from "./monacoFileLanguage";
import { monacoFileModelKey, type MonacoFileModels } from "./monacoFileModels";
import { resolveRevealLine } from "./monacoFileReveal";
import {
  defineMesuraMonacoThemes,
  MESURA_MONACO_DARK,
  MESURA_MONACO_LIGHT,
  readCodeFont,
  readCodeSurfaceColors,
} from "./monacoFileTheme";
import "./monacoFileSurface.css";
import { registerFocusTarget } from "~/lib/focusTargets";
import { setPaneEntryFocus } from "~/lib/panelSurfaceFocus";

const REVEAL_LINE_CLASS = "mesura-file-reveal-line";

export interface MonacoFileSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly retention: FileEditorRetention;
  /**
   * The models, owned by the panel rather than by this component.
   *
   * The undo stack lives in the model, so it survives exactly as long as the
   * cache does. This component is unmounted whenever the panel shows something
   * else in its place — the spinner while a file is read, the rendered markdown
   * view — and a cache that died with it would take every file's history along.
   */
  readonly models: MonacoFileModels;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** The thread whose Neovim drives this editor, when modal editing is on. */
  readonly threadRef: ScopedThreadRef;
  readonly modalEditing: boolean;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

/**
 * The file panel's editing surface.
 *
 * Mounted without a React key on purpose. The editor has to outlive a file
 * switch and a theme switch: rebuilding it would throw away the undo stack,
 * which is the whole reason the retention record exists.
 */
export function MonacoFileSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  resolvedTheme,
  wordWrap,
  revealLine,
  revealRequestId,
  retention,
  models,
  composerDraftTarget,
  threadRef,
  modalEditing,
  onPendingChange,
}: MonacoFileSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The same editor and model the refs hold, in state as well. Comments render
  // React into Monaco view zones, so the pieces that own them have to re-render
  // when the editor appears and when the open file changes; a ref cannot do
  // that. The refs stay because the effects below read them without depending
  // on them.
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [model, setModel] = useState<monaco.editor.ITextModel | null>(null);

  // The file the editor is showing, so a switch can put its view state away
  // before the new one arrives.
  const openKeyRef = useRef<string | null>(null);
  // The editor is created once and torn down from a layout effect, which cannot
  // depend on a prop, so the cache is reached through a ref there.
  const modelsRef = useRef(models);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);

  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange,
  });
  // The change handler is rebuilt as its inputs move, but the editor is created
  // once, so the listener reads the current handler through a ref instead of
  // being torn down and reinstalled.
  const saveRef = useRef(saveCoordinator);
  useEffect(() => {
    saveRef.current = saveCoordinator;
  }, [saveCoordinator]);

  /**
   * True while an edit from outside is being applied to the model.
   *
   * Monaco raises one content-change event for a programmatic edit and a typed
   * one alike, so without this the editor answers an incoming change by saving
   * it straight back. That is not merely a redundant write and a pending
   * indicator for something the user never did: if a second external edit lands
   * inside the save debounce, the echo of the first one overwrites it.
   */
  const applyingExternalEditRef = useRef(false);
  /**
   * The seam the Neovim driver shares with the effect below.
   *
   * One flag, two readers: the listener that turns a model change into a save
   * has to ignore an edit that is not the developer typing, and so does the
   * driver — for the driver, an agent's write read as typing would be undone
   * and sent to Neovim one character at a time.
   */
  const externalEdits = useMemo(
    () => ({
      isApplying: () => applyingExternalEditRef.current,
      run: (body: () => void) => {
        applyingExternalEditRef.current = true;
        try {
          body();
        } finally {
          applyingExternalEditRef.current = false;
        }
      },
    }),
    [],
  );

  // Layout effect rather than effect: the editor measures the node, and doing
  // that after paint shows one frame of an unsized editor.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    ensureMonacoEnvironment();
    const surface = readCodeSurfaceColors(host);
    defineMesuraMonacoThemes(monaco, { light: surface, dark: surface });
    const font = readCodeFont();

    // The prototype's options, kept as validated by hand. The ones that are not
    // defaults: the caret animates only on an explicit move, highlighting
    // decisions are left to whatever drives the editor later, and every
    // suggestion source is off because code intelligence is a backend job.
    const editor = monaco.editor.create(host, {
      value: "",
      theme: resolvedTheme === "dark" ? MESURA_MONACO_DARK : MESURA_MONACO_LIGHT,
      fontFamily: font.family,
      fontSize: font.sizePx,
      lineNumbers: modalEditing ? "relative" : "on",
      scrollBeyondLastLine: false,
      cursorSmoothCaretAnimation: "explicit",
      smoothScrolling: true,
      minimap: { enabled: false },
      automaticLayout: true,
      renderWhitespace: "none",
      occurrencesHighlight: "off",
      selectionHighlight: false,
      wordBasedSuggestions: "off",
      quickSuggestions: false,
      parameterHints: { enabled: false },
      contextmenu: false,
      wordWrap: wordWrap ? "on" : "off",
    });
    editorRef.current = editor;
    setEditor(editor);
    decorationsRef.current = editor.createDecorationsCollection();
    const focusEditor = () => {
      editor.focus();
      return true;
    };
    const unregisterFocusTarget = registerFocusTarget("editor", focusEditor);
    // The panel's entry, ranked over the file tree beside it.
    const clearPaneEntry = setPaneEntryFocus(host, focusEditor);

    return () => {
      unregisterFocusTarget();
      clearPaneEntry();
      decorationsRef.current = null;
      editorRef.current = null;
      setEditor(null);
      // Put the open file away before the editor goes. This runs while the
      // editor is still alive, which a passive effect could not promise: React
      // flushes layout-effect cleanups first, so anything reading the editor
      // from a plain effect would be reaching through a disposed handle.
      const openKey = openKeyRef.current;
      if (openKey !== null) {
        modelsRef.current.saveViewState(openKey, editor.saveViewState());
        modelsRef.current.release(openKey);
        openKeyRef.current = null;
      }
      // The model belongs to the cache. Disposing it here would pull it out
      // from under the cache, which still holds it for the next visit.
      editor.dispose();
    };
    // Created once. Theme, font and wrap are applied by the effects below so a
    // change to any of them does not rebuild the editor.
  }, []);

  // The open file's model, kept in a cache so leaving a file and coming back
  // finds its undo stack, caret and scroll where they were.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;

    const key = monacoFileModelKey(environmentId, cwd, relativePath);
    const previousKey = openKeyRef.current;
    if (previousKey !== null && previousKey !== key) {
      models.saveViewState(previousKey, editor.saveViewState());
      models.release(previousKey);
    }
    openKeyRef.current = key;

    const { model, reused } = models.acquire(
      key,
      contents,
      languageIdForPath(relativePath, monaco.languages.getLanguages()),
    );
    editor.setModel(model);
    setModel(model);
    if (reused) {
      const viewState = models.viewStateFor(key);
      if (viewState !== null) editor.restoreViewState(viewState);
    }

    const subscription = model.onDidChangeContent(() => {
      if (applyingExternalEditRef.current) return;
      const next = model.getValue();
      retention.noteEditorFile(relativePath, { contents: next });
      setProjectFileQueryData(environmentId, cwd, relativePath, next);
      saveRef.current.change(next);
    });
    return () => subscription.dispose();
    // `contents` is deliberately absent: a change to it for the SAME path is an
    // external edit and is applied by the effect below, not by rebuilding the
    // model, which would discard the undo stack. A reused model whose file
    // changed while it was away is caught by that same effect, which runs after
    // this one on the same render.
  }, [environmentId, cwd, relativePath, retention, models]);

  // An external change to the open file: the watcher pushed one, or a save
  // confirmed. Applied as an edit, never `setValue`, because `setValue` clears
  // the undo stack.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (model.getValue() === contents) return;
    // Our own text coming back as a confirmation. Rewriting the model with what
    // it already said would move the caret for nothing.
    if (retention.canReuse(relativePath, contents)) return;

    // Only the part that actually differs. Replacing the whole range produces
    // the right text and the wrong caret: every position maps through an edit
    // that covered everything, so a caret well below an agent's change does not
    // come back where it was.
    const edit = minimalTextEdit(model.getValue(), contents);
    if (edit === null) return;

    // With Neovim driving, the write goes to Neovim rather than to the model.
    // One `nvim_buf_set_text` is one undo step there, which is what makes a
    // single `u` take an agent's whole write back — and the `lines` event it
    // sends afterwards is what puts the text on screen. Writing the model here
    // as well would show the change twice.
    const start = model.getPositionAt(edit.startOffset);
    const end = model.getPositionAt(edit.endOffset);
    const takenByNeovim = nvimRef.current({
      startLine: start.lineNumber,
      startCol: start.column,
      endLine: end.lineNumber,
      endCol: end.column,
      text: edit.text,
    });
    if (takenByNeovim) {
      // The record is still written, exactly as below: the next `contents` prop
      // equal to this text has to be recognised as ours rather than reloaded.
      retention.noteEditorFile(relativePath, { contents });
      return;
    }

    applyingExternalEditRef.current = true;
    try {
      // The edit gets its own undo element, on both sides. Without these,
      // Monaco merges the incoming rewrite into whatever typing group is still
      // open, and one Ctrl+Z then reverts the agent's write AND the user's
      // last few keystrokes together. Measured, not guessed: undoing a
      // merged group left a half-typed line on screen.
      model.pushStackElement();
      const range = monaco.Range.fromPositions(
        model.getPositionAt(edit.startOffset),
        model.getPositionAt(edit.endOffset),
      );
      // The selection goes in so undo restores it, and the computer returns
      // null so Monaco maps the caret through the edit itself rather than
      // being told where to put it.
      model.pushEditOperations(
        editor.getSelections() ?? [],
        [{ range, text: edit.text }],
        () => null,
      );
      model.pushStackElement();
    } finally {
      applyingExternalEditRef.current = false;
    }
    // Suppressing the listener also suppressed the record it keeps, so the
    // record is written here instead. Leaving it stale would cost the undo
    // stack on the next return to this file, because `canReuse` would compare
    // the pre-edit text against the file on disk and decide to load fresh.
    retention.noteEditorFile(relativePath, { contents });
  }, [contents, relativePath, retention]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [wordWrap]);

  // Redefined rather than only re-selected: an environment theme changes the
  // code-surface custom properties without changing light or dark, and the
  // colours have to be read off the node again to catch that.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const surface = readCodeSurfaceColors(host);
    defineMesuraMonacoThemes(monaco, { light: surface, dark: surface });
    monaco.editor.setTheme(resolvedTheme === "dark" ? MESURA_MONACO_DARK : MESURA_MONACO_LIGHT);
  }, [resolvedTheme]);

  useEffect(() => {
    editorRef.current?.updateOptions(
      (() => {
        const font = readCodeFont();
        return { fontFamily: font.family, fontSize: font.sizePx };
      })(),
    );
  }, [fontFamilyCode, fontSizeCode]);

  useEffect(() => {
    const editor = editorRef.current;
    const decorations = decorationsRef.current;
    const model = editor?.getModel();
    if (!editor || !decorations || !model) return;
    if (revealLine === null) {
      decorations.clear();
      return;
    }
    const line = resolveRevealLine(revealLine, model.getLineCount());
    editor.revealLineInCenter(line);
    decorations.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: REVEAL_LINE_CLASS },
      },
    ]);
    // `revealRequestId` is listed although the body never reads it: asking for
    // the same line twice has to reveal it twice, and the request id is the only
    // thing that changes between those two asks.
  }, [revealRequestId, revealLine]);

  const comments = useMonacoFileComments({
    editor,
    model,
    relativePath,
    composerDraftTarget,
  });
  // A ref so the dismissal listeners can read the current answer without being
  // torn down and reinstalled every time a comment form opens or closes.
  const nvim = useNvimFileEditor({
    editor,
    model,
    environmentId,
    threadRef,
    cwd,
    relativePath,
    enabled: modalEditing,
    // Shared with the effect below rather than duplicated: the driver has to
    // know an agent's write from a browser composition, and the difference is
    // this ref being set.
    externalEdits: externalEdits,
    flushSave: () => {
      void saveRef.current.flush();
    },
  });

  // Relative while Neovim is driving, absolute otherwise.
  //
  // The numbers are what `3j` and `d5k` are counted off, so they belong to the
  // modal editing they serve. Monaco's `relative` is Vim's hybrid — the
  // cursor's own line keeps its absolute number — which is what the
  // developer's `number` plus `relativenumber` already gives them.
  //
  // Keyed on the driver being active, not on the setting. With the setting on
  // and no session — `nvim` missing, a configuration directory that is not
  // there — the panel is plain Monaco, and a relative gutter there counts off
  // a cursor nothing is moving.
  //
  // Applied through `updateOptions` rather than only at creation, because the
  // editor is created once on purpose and outlives every setting change.
  // Adding this to the creating hook's dependencies would remount the editor
  // and take the undo stack with it, which is the defect
  // `monaco-file-surface-wired` exists to prevent.
  useEffect(() => {
    editorRef.current?.updateOptions({ lineNumbers: nvim.active ? "relative" : "on" });
  }, [nvim.active]);

  // Through a ref because the effect that applies an external change must not
  // be torn down and re-run every time the driver's mode changes.
  const nvimRef = useRef(nvim.takeExternalEdit);
  nvimRef.current = nvim.takeExternalEdit;

  const hasOpenDraftRef = useRef(comments.hasOpenDraft);
  useEffect(() => {
    hasOpenDraftRef.current = comments.hasOpenDraft;
  }, [comments.hasOpenDraft]);

  // Read through refs because the dismissal listener is installed once, on
  // mount, and must see the mode as it is now rather than as it was then.
  const nvimModeRef = useRef(nvim.mode);
  nvimModeRef.current = nvim.mode;
  const nvimActiveRef = useRef(nvim.active);
  nvimActiveRef.current = nvim.active;
  const nvimJumpingRef = useRef(nvim.jumping);
  nvimJumpingRef.current = nvim.jumping;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    return installFileEditorDismissal({
      root: host,
      editor: {
        hasTextFocus: () => editorRef.current?.hasTextFocus() === true,
        collapseSelection: () => {
          const editor = editorRef.current;
          const position = editor?.getPosition();
          if (editor && position) editor.setPosition(position);
        },
        // Monaco 0.56 exposes `focus()` and blur *events*, but nothing that
        // asks the editor to release the keyboard, so the focused node has to
        // be blurred directly. Which node that is depends on the build: with
        // the `editContext` option on, Monaco keeps the caret in a
        // `native-edit-context` div; with it off, in a hidden textarea. Asking
        // the document what is focused covers both and names neither, so this
        // does not break when Monaco moves its input handling again.
        blur: () => {
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && host.contains(focused)) focused.blur();
        },
      },
      // An open comment form owns Escape: it cancels the draft rather than
      // blurring the editor underneath it.
      //
      // So does Neovim, whenever it is in any mode but plain normal — Escape
      // is how a developer leaves insert, visual or an operator, and a host
      // that blurred the editor instead would strand them in that mode with
      // the keyboard somewhere else. In plain normal mode there is nothing to
      // leave, so Escape dismisses as it always did — except while flash waits
      // for a label. Neovim reports plain normal mode then, and Escape is how
      // the jump is abandoned; taken as a dismissal it left the labels up.
      isBlocked: () =>
        hasOpenDraftRef.current ||
        (nvimActiveRef.current && (nvimModeRef.current !== "n" || nvimJumpingRef.current)),
      onDismiss: () => {},
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={hostRef}
        data-monaco-file-surface
        data-pane-entry="2"
        className="flex min-h-0 flex-1"
      >
        {comments.zones}
      </div>
      {nvim.active || nvim.fallback !== null ? (
        <NvimStatusStrip
          mode={nvim.mode}
          jumping={nvim.jumping}
          cmdline={nvim.cmdline}
          message={nvim.message}
          fallback={nvim.fallback}
          onRetry={nvim.retry}
        />
      ) : null}
    </div>
  );
}
