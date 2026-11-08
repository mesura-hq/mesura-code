import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as monaco from "monaco-editor";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { DraftId } from "~/composerDraftStore";

import { useClientSettings } from "~/hooks/useSettings";

import type { FileEditorRetention } from "../fileEditorRetention";
import { NvimStatusStrip } from "./nvim/NvimStatusStrip";
import { useNvimFileEditor } from "./nvim/useNvimFileEditor";
import { installFileEditorDismissal } from "../fileEditorDismissal";
import { getProjectFileContents, setProjectFileQueryData } from "../projectFilesQueryState";
import { useFileSaveCoordinator } from "../useFileSaveCoordinator";
import { minimalTextEdit, type MinimalTextEdit } from "./monacoFileEdit";
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
   * The models, owned by the panel: the undo stack lives in the model, and this component unmounts
   * whenever the panel shows something else (the read spinner, rendered markdown).
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
  // The editor and model also in state, so the comment view zones re-render when either changes;
  // the refs stay because the effects below read them without depending on them.
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [model, setModel] = useState<monaco.editor.ITextModel | null>(null);

  // The file the editor is showing, so a switch can put its view state away
  // before the new one arrives.
  const openKeyRef = useRef<string | null>(null);
  // The editor is created once and torn down from a layout effect, which cannot
  // depend on a prop, so the cache is reached through a ref there.
  const modelsRef = useRef(models);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref for the layout-effect teardown of the once-created editor
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);
  const initialOptionsRef = useRef({ resolvedTheme, modalEditing, wordWrap });
  const contentsRef = useRef(contents);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref read by the once-created editor's listeners
  useLayoutEffect(() => {
    contentsRef.current = contents;
  }, [contents]);
  const appliedFontRef = useRef<{
    editor: monaco.editor.IStandaloneCodeEditor;
    family: typeof fontFamilyCode;
    size: typeof fontSizeCode;
  } | null>(null);
  const revealedRequestRef = useRef<{
    editor: monaco.editor.IStandaloneCodeEditor;
    line: number | null;
    id: number;
  } | null>(null);

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
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref so the once-installed content listener sees the current save handler
  useEffect(() => {
    saveRef.current = saveCoordinator;
  }, [saveCoordinator]);

  /**
   * True while an external edit is applied. Monaco raises one content-change event for programmatic
   * and typed edits alike; without this the editor saves the incoming change back, and that echo
   * can overwrite a second external edit landing inside the save debounce.
   */
  const applyingExternalEditRef = useRef(false);
  /**
   * The flag shared with the Neovim driver: both the save listener and the driver must ignore a
   * non-typed edit, or the driver undoes an agent's write and resends it to Neovim key by key.
   */
  const externalEdits = useMemo(
    () => ({
      isApplying: () => applyingExternalEditRef.current,
      run: (body: () => void) => runExternalEdit(applyingExternalEditRef, body),
    }),
    [],
  );

  // Layout effect rather than effect: the editor measures the node, and doing
  // that after paint shows one frame of an unsized editor.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: creates the Monaco editor once on the host node and disposes it on unmount
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    ensureMonacoEnvironment();
    const surface = readCodeSurfaceColors(host);
    defineMesuraMonacoThemes(monaco, { light: surface, dark: surface });
    const font = readCodeFont();
    const initialOptions = initialOptionsRef.current;

    // The prototype's options, kept as validated by hand. The ones that are not
    // defaults: the caret animates only on an explicit move, highlighting
    // decisions are left to whatever drives the editor later, and every
    // suggestion source is off because code intelligence is a backend job.
    const editor = monaco.editor.create(host, {
      value: "",
      theme: initialOptions.resolvedTheme === "dark" ? MESURA_MONACO_DARK : MESURA_MONACO_LIGHT,
      fontFamily: font.family,
      fontSize: font.sizePx,
      lineNumbers: initialOptions.modalEditing ? "relative" : "on",
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
      wordWrap: initialOptions.wordWrap ? "on" : "off",
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
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: swaps the open file's cached model into the once-created editor
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
      contentsRef.current,
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
    // `contents` is deliberately absent: a same-path change is an external edit applied by the
    // effect below (which also catches a reused model that changed while away), not a model
    // rebuild that would discard the undo stack.
  }, [environmentId, cwd, relativePath, retention, models]);

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: pushes the word-wrap setting into the once-created editor
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [wordWrap]);

  // Redefined rather than only re-selected: an environment theme changes the
  // code-surface custom properties without changing light or dark, and the
  // colours have to be read off the node again to catch that.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: redefines the Monaco themes from the host's computed colours
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const surface = readCodeSurfaceColors(host);
    defineMesuraMonacoThemes(monaco, { light: surface, dark: surface });
    monaco.editor.setTheme(resolvedTheme === "dark" ? MESURA_MONACO_DARK : MESURA_MONACO_LIGHT);
  }, [resolvedTheme]);

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: pushes the code font settings into the once-created editor
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    const applied = appliedFontRef.current;
    if (
      applied?.editor === editor &&
      applied.family === fontFamilyCode &&
      applied.size === fontSizeCode
    )
      return;
    // The settings invalidate the font read; CSS supplies the resolved values.
    const font = readCodeFont();
    editor.updateOptions({ fontFamily: font.family, fontSize: font.sizePx });
    appliedFontRef.current = { editor, family: fontFamilyCode, size: fontSizeCode };
  }, [fontFamilyCode, fontSizeCode]);

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: reveals and highlights the requested line in the editor
  useEffect(() => {
    const editor = editorRef.current;
    const decorations = decorationsRef.current;
    const model = editor?.getModel();
    if (!editor || !decorations || !model) return;
    const previous = revealedRequestRef.current;
    if (
      previous?.editor === editor &&
      previous.line === revealLine &&
      previous.id === revealRequestId
    )
      return;
    revealedRequestRef.current = { editor, line: revealLine, id: revealRequestId };
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
    // A new request id reveals the same line again. The editor identity also
    // lets a layout-effect replay reveal it in the replacement editor.
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

  // Relative line numbers while Neovim drives (counts like `3j`), absolute otherwise: keyed on the
  // driver being active, not the setting, so a fallback plain Monaco has no relative gutter. Set
  // via `updateOptions` because the editor is created once; adding this to the creating hook's
  // dependencies would remount it and drop the undo stack (`monaco-file-surface-wired`).
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: switches the once-created editor's line numbers with the Neovim driver
  useEffect(() => {
    editorRef.current?.updateOptions({ lineNumbers: nvim.active ? "relative" : "on" });
  }, [nvim.active]);

  // Through a ref because the effect that applies an external change must not
  // be torn down and re-run every time the driver's mode changes.
  const nvimRef = useRef(nvim.takeExternalEdit);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref so the external-change effect is not re-run on mode changes
  useLayoutEffect(() => {
    nvimRef.current = nvim.takeExternalEdit;
  }, [nvim.takeExternalEdit]);

  // An external change to the open file: the watcher pushed one, or a save
  // confirmed. Applied as an edit, never `setValue`, because `setValue` clears
  // the undo stack.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: applies an external file change to the model as an undoable edit
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const current = model.getValue();
    if (current === contents) return;
    // A render older than the model: own edits write the file contents at once, but this prop
    // arrives a commit or more later, so a burst of Neovim edits can hand back our own older text.
    // Taken as an external write, it once deleted newer keys in Neovim (phase-6 "measure"). An
    // outside write reaches the file contents first, so contents equal to the model mean none.
    if (getProjectFileContents(environmentId, cwd, relativePath) === current) return;
    // Our own text coming back as a confirmation. Rewriting the model with what
    // it already said would move the caret for nothing.
    if (retention.canReuse(relativePath, contents)) return;

    // Only the part that actually differs. Replacing the whole range produces
    // the right text and the wrong caret: every position maps through an edit
    // that covered everything, so a caret well below an agent's change does not
    // come back where it was.
    const edit = minimalTextEdit(model.getValue(), contents);
    if (edit === null) return;

    // With Neovim driving, the write goes to Neovim, not the model: one `nvim_buf_set_text` is one
    // undo step there, and its `lines` event puts the text on screen. Writing the model too would
    // apply the change twice.
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

    applyExternalModelEdit(editor, model, edit, applyingExternalEditRef);
    // Suppressing the listener also suppressed the record it keeps, so the
    // record is written here instead. Leaving it stale would cost the undo
    // stack on the next return to this file, because `canReuse` would compare
    // the pre-edit text against the file on disk and decide to load fresh.
    retention.noteEditorFile(relativePath, { contents });
  }, [contents, environmentId, cwd, relativePath, retention]);

  const hasOpenDraftRef = useRef(comments.hasOpenDraft);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref read by the once-installed dismissal listener
  useEffect(() => {
    hasOpenDraftRef.current = comments.hasOpenDraft;
  }, [comments.hasOpenDraft]);

  // Read through refs because the dismissal listener is installed once, on
  // mount, and must see Neovim as it is now rather than as it was then.
  const nvimActiveRef = useRef(nvim.active);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref read by the once-installed dismissal listener
  useLayoutEffect(() => {
    nvimActiveRef.current = nvim.active;
  }, [nvim.active]);
  // Layout effect, not render: written after commit and before any later
  // keydown can reach the listener, so it never decides on a stale answer.
  const nvimEscapeRef = useRef(nvim.escapeGoesToNeovim);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref, written after commit so the dismissal listener never reads a stale answer
  useLayoutEffect(() => {
    nvimEscapeRef.current = nvim.escapeGoesToNeovim;
  }, [nvim.escapeGoesToNeovim]);

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: installs the Escape dismissal listener on the host for its lifetime
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
        // Monaco 0.56 has no API to release the keyboard, so blur the focused node directly. It is
        // a `native-edit-context` div or a hidden textarea depending on `editContext`, so ask the
        // document rather than naming either.
        blur: () => {
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && host.contains(focused)) focused.blur();
        },
      },
      // An open comment form owns Escape (it cancels the draft). So does Neovim unless it is known
      // to rest in plain normal mode: a key still in flight can change the mode, and blurring then
      // strands the developer in insert or visual mode. See `escapeGoesToNeovim`.
      isBlocked: () =>
        hasOpenDraftRef.current || (nvimActiveRef.current && nvimEscapeRef.current()),
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
          keysDelivery={nvim.keysDelivery}
        />
      ) : null}
    </div>
  );
}

// These operations run at the imperative editor boundary. Keep exception cleanup
// outside the component because React Compiler cannot lower try/finally yet.
function runExternalEdit(applyingExternalEditRef: RefObject<boolean>, body: () => void): void {
  applyingExternalEditRef.current = true;
  try {
    body();
  } finally {
    applyingExternalEditRef.current = false;
  }
}

function applyExternalModelEdit(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  edit: MinimalTextEdit,
  applyingExternalEditRef: RefObject<boolean>,
): void {
  applyingExternalEditRef.current = true;
  try {
    // Undo stops on both sides, or Monaco merges the agent's write into the open typing group and
    // one Ctrl+Z reverts both (measured: it left a half-typed line on screen).
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
}
