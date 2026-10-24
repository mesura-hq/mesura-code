import type { ScopedThreadRef } from "@t3tools/contracts";
import * as monaco from "monaco-editor";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { observeResize } from "~/lib/observeResize";
import { buildFileReviewComment } from "~/reviewCommentContext";

import { DiffCommentAnnotation } from "../../diffs/DiffCommentAnnotation";
import {
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  type FileCommentAnnotationEntry,
} from "../fileCommentAnnotations";
import {
  anchorForLines,
  entryAfterModelChange,
  groupEntriesByEndLine,
  type CommentAnchor,
  type FileCommentGroup,
} from "./monacoFileCommentAnchors";

const SELECTION_CLASS = "mesura-file-comment-selection";
const ZONE_CLASS = "mesura-file-comment-zone";

export interface SelectedLineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Line selection by dragging down the line-number gutter.
 *
 * Monaco has no such gesture of its own — dragging the gutter moves the text
 * cursor — so this is built from the editor's mouse events. It reports the
 * range as it grows so the caller can highlight it, and once more when the
 * button comes up, which is what opens a comment form.
 *
 * The pointer often leaves the gutter mid-drag, and it may leave the editor
 * entirely, so the end of the gesture is taken from the window rather than
 * from Monaco: `onMouseUp` never fires for a release over another element.
 */
export function installGutterLineSelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  {
    isEnabled,
    onSelectionChange,
    onSelectionEnd,
  }: {
    isEnabled: () => boolean;
    onSelectionChange: (range: SelectedLineRange | null) => void;
    onSelectionEnd: (range: SelectedLineRange) => void;
  },
): () => void {
  let anchorLine: number | null = null;
  let currentLine: number | null = null;

  const finish = () => {
    if (anchorLine === null || currentLine === null) return;
    const range = { start: anchorLine, end: currentLine };
    anchorLine = null;
    currentLine = null;
    window.removeEventListener("pointermove", extend);
    onSelectionEnd(range);
  };

  /**
   * Grows the range as the pointer moves.
   *
   * Bound to the window rather than to `editor.onMouseMove`, which Monaco stops
   * emitting as soon as a button goes down — it routes those moves into its own
   * drag handling instead. Listening on the window and asking the editor what
   * is under the pointer keeps the gesture alive, and keeps it alive when the
   * pointer wanders off the gutter or out of the editor entirely.
   */
  function extend(event: PointerEvent): void {
    if (anchorLine === null) return;
    const line = editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position?.lineNumber;
    if (line === undefined || line === currentLine) return;
    currentLine = line;
    onSelectionChange({ start: anchorLine, end: line });
  }

  const down = editor.onMouseDown((event) => {
    if (!isEnabled()) return;
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    const line = event.target.position?.lineNumber;
    if (line === undefined) return;
    // Monaco would otherwise put the caret on the line and start its own
    // selection, which fights the drag and leaves the editor focused.
    event.event.preventDefault();
    anchorLine = line;
    currentLine = line;
    window.addEventListener("pointermove", extend);
    onSelectionChange({ start: line, end: line });
  });

  // `pointerup` on the window rather than on the editor, because a release over
  // another element never reaches Monaco. `pointercancel` and `blur` end the
  // gesture too: a release outside the browser window delivers neither a
  // pointerup nor anything else, and without them the highlight would sit on
  // screen until the next drag.
  const endGesture = () => finish();
  for (const type of ["pointerup", "pointercancel", "blur"] as const) {
    window.addEventListener(type, endGesture);
  }

  return () => {
    down.dispose();
    window.removeEventListener("pointermove", extend);
    for (const type of ["pointerup", "pointercancel", "blur"] as const) {
      window.removeEventListener(type, endGesture);
    }
  };
}

interface PlacedAnchor extends CommentAnchor {
  readonly decorationId: string;
}

/** Used only when a comment somehow has no anchor, which ends it either way. */
const ZERO_OFFSETS = { startLineOffset: 0, endLineOffset: 0 };

interface CommentZone {
  readonly zoneId: string;
  readonly domNode: HTMLElement;
  readonly contentNode: HTMLElement;
  readonly zone: monaco.editor.IViewZone;
}

export interface UseMonacoFileCommentsInput {
  readonly editor: monaco.editor.IStandaloneCodeEditor | null;
  readonly model: monaco.editor.ITextModel | null;
  readonly relativePath: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}

export interface MonacoFileComments {
  /** True while a form is open, which blocks gutter selection and Escape. */
  readonly hasOpenDraft: boolean;
  /** The portals to render, one per view zone. */
  readonly zones: readonly React.ReactNode[];
}

/**
 * File comments, drawn as Monaco view zones.
 *
 * Each comment owns a tracked decoration over the lines it covers, which is
 * what makes it follow an edit: Monaco remaps the decoration, and the zone is
 * re-anchored to wherever it ended up. When the commented lines are deleted the
 * decoration collapses and the comment goes with them.
 *
 * The comments live in this hook's state rather than in the composer store,
 * which matches what the Pierre surface did. The store holds only submitted
 * comments, and it is written to on submit and on delete.
 */
export function useMonacoFileComments({
  editor,
  model,
  relativePath,
  composerDraftTarget,
}: UseMonacoFileCommentsInput): MonacoFileComments {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);

  const [entries, setEntries] = useState<FileCommentAnnotationEntry[]>([]);
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [commentModel, setCommentModel] = useState(model);
  // Reset before React commits the new model, so an old draft never renders
  // into the new file's zones.
  if (commentModel !== model) {
    setCommentModel(model);
    setEntries([]);
    setSelection(null);
  }
  /**
   * The tracked decoration that anchors each comment, by comment id, with the
   * offsets its placement used. The decoration covers a little more than the
   * comment does; see `anchorForLines`.
   */
  const anchorsRef = useRef(new Map<string, PlacedAnchor>());

  // Read inside Monaco's own callbacks, which fire outside React's render and
  // must not reach for a state updater to see the current comments: doing the
  // work inside an updater means doing it during render, and writing to the
  // composer store from there updates another component mid-render.
  const entriesRef = useRef(entries);
  useLayoutEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const hasOpenDraft = entries.some((entry) => entry.kind === "draft");
  const hasOpenDraftRef = useRef(hasOpenDraft);
  useLayoutEffect(() => {
    hasOpenDraftRef.current = hasOpenDraft;
  }, [hasOpenDraft]);

  // The editor owns the decorations. Only release the anchor registry here:
  // the surface can dispose the editor before passive cleanups run.
  useEffect(() => {
    if (model === null) return;
    const anchors = anchorsRef.current;
    return () => anchors.clear();
  }, [model]);

  const dropEntries = useCallback(
    (ids: ReadonlySet<string>) => {
      if (ids.size === 0) return;
      const anchors = anchorsRef.current;
      const removed = [...ids].flatMap((id) => {
        const anchor = anchors.get(id);
        anchors.delete(id);
        return anchor === undefined ? [] : [anchor.decorationId];
      });
      if (removed.length > 0 && model !== null) model.deltaDecorations(removed, []);
      setEntries((current) => current.filter((entry) => !ids.has(entry.id)));
    },
    [model],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange) => {
      if (model === null) return;
      const { startLine, endLine } = normalizeFileCommentRange(range);
      const anchor = anchorForLines(startLine, endLine, model.getLineCount(), (line) =>
        model.getLineMaxColumn(line),
      );
      const [anchorId] = model.deltaDecorations(
        [],
        [
          {
            range: new monaco.Range(
              anchor.range.startLineNumber,
              anchor.range.startColumn,
              anchor.range.endLineNumber,
              anchor.range.endColumn,
            ),
            options: {
              // The anchor must not swallow text typed at either edge of the
              // commented range: a comment on lines 4-6 still covers 4-6 after
              // someone types at the start of line 4.
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ],
      );
      const draft: FileCommentAnnotationEntry = {
        id: nextFileCommentId(),
        kind: "draft",
        startLine,
        endLine,
        text: "",
      };
      if (anchorId !== undefined) {
        anchorsRef.current.set(draft.id, { decorationId: anchorId, ...anchor });
      }
      // One draft at a time, as the Pierre surface had it.
      setEntries((current) => [...current.filter((entry) => entry.kind !== "draft"), draft]);
    },
    [model],
  );

  // Gutter drag selects the lines to comment on.
  useEffect(() => {
    if (editor === null) return;
    return installGutterLineSelection(editor, {
      isEnabled: () => !hasOpenDraftRef.current,
      onSelectionChange: setSelection,
      onSelectionEnd: (range) => {
        setSelection(range);
        beginComment(range);
      },
    });
  }, [editor, beginComment]);

  // The live gutter selection, drawn as whole lines.
  useEffect(() => {
    if (editor === null) return;
    const decorations = editor.createDecorationsCollection();
    if (selection !== null) {
      const { startLine, endLine } = normalizeFileCommentRange(selection);
      decorations.set([
        {
          range: new monaco.Range(startLine, 1, endLine, 1),
          options: { isWholeLine: true, className: SELECTION_CLASS },
        },
      ]);
    }
    return () => decorations.clear();
  }, [editor, selection]);

  // Follow the text. Monaco has already remapped the anchors; this reads where
  // they landed, drops the comments whose lines are gone, and tells the composer
  // about the ones that moved.
  useEffect(() => {
    if (model === null) return;
    const subscription = model.onDidChangeContent(() => {
      const anchors = anchorsRef.current;
      const next: FileCommentAnnotationEntry[] = [];
      const moved: FileCommentAnnotationEntry[] = [];
      let changed = false;

      for (const entry of entriesRef.current) {
        const anchor = anchors.get(entry.id);
        const range = anchor === undefined ? null : model.getDecorationRange(anchor.decorationId);
        const remapped = entryAfterModelChange(entry, anchor ?? ZERO_OFFSETS, range);
        if (remapped === null) {
          changed = true;
          if (anchor !== undefined) {
            model.deltaDecorations([anchor.decorationId], []);
            anchors.delete(entry.id);
          }
          continue;
        }
        if (remapped !== entry) {
          changed = true;
          if (remapped.kind === "comment") moved.push(remapped);
        }
        next.push(remapped);
      }

      if (!changed) return;
      entriesRef.current = next;
      setEntries(next);
      // A submitted comment carries its line range into the composer, so a
      // comment whose lines moved has to be sent again or the chip keeps
      // quoting the line it was made on.
      const contents = model.getValue();
      for (const entry of moved) {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text: entry.text,
            contents,
          }),
        );
      }
    });
    return () => subscription.dispose();
  }, [model, addReviewComment, composerDraftTarget, relativePath]);

  const removeEntry = useCallback(
    (entryId: string) => {
      setSelection(null);
      removeReviewComment(composerDraftTarget, entryId);
      dropEntries(new Set([entryId]));
    },
    [composerDraftTarget, dropEntries, removeReviewComment],
  );

  const submitEntry = useCallback(
    (entryId: string, text: string) => {
      setSelection(null);
      const entry = entriesRef.current.find((candidate) => candidate.id === entryId);
      if (entry === undefined) return;
      addReviewComment(
        composerDraftTarget,
        buildFileReviewComment({
          id: entry.id,
          filePath: relativePath,
          startLine: entry.startLine,
          endLine: entry.endLine,
          text,
          // Read at submit time, so the quoted lines are the ones on screen
          // rather than the ones that were there when the form opened.
          contents: model?.getValue() ?? "",
        }),
      );
      setEntries((current) =>
        current.map((candidate) =>
          candidate.id === entryId ? { ...candidate, kind: "comment" as const, text } : candidate,
        ),
      );
    },
    [addReviewComment, composerDraftTarget, model, relativePath],
  );

  const changeEntryText = useCallback((entryId: string, text: string) => {
    setEntries((current) =>
      current.map((entry) => (entry.id === entryId ? { ...entry, text } : entry)),
    );
  }, []);

  const groups = useMemo(() => groupEntriesByEndLine(entries), [entries]);
  const zones = useCommentZones(editor, groups);

  return {
    hasOpenDraft,
    zones: zones.map(({ group, contentNode }) =>
      createPortal(
        <FileCommentZoneContent
          group={group}
          onCancel={removeEntry}
          onComment={submitEntry}
          onDelete={removeEntry}
          onTextChange={changeEntryText}
        />,
        contentNode,
        `${group.endLine}`,
      ),
    ),
  };
}

/**
 * Keeps one Monaco view zone per group of comments.
 *
 * Zones are keyed by the line they hang under, and the DOM node for a line is
 * reused while that line keeps its comments, so React portals into a stable
 * node and a form does not remount as the text around it moves.
 */
function useCommentZones(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  groups: readonly FileCommentGroup[],
): ReadonlyArray<{ group: FileCommentGroup; contentNode: HTMLElement }> {
  const [store] = useState(createCommentZoneStore);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // Comment text changes per keystroke; only changed line membership needs
  // Monaco zone reconciliation and a new resize subscription.
  const zoneLines = groups.map((group) => group.endLine).join(",");

  useEffect(() => {
    if (editor === null) return;
    return store.synchronize(editor, zoneLines);
  }, [editor, store, zoneLines]);

  useEffect(() => {
    if (editor === null) return;
    return () => store.clear();
  }, [editor, store]);

  if (snapshot.editor !== editor) return [];
  return groups.flatMap((group) => {
    const contentNode = snapshot.contentNodes.get(group.endLine);
    return contentNode === undefined ? [] : [{ group, contentNode }];
  });
}

// Monaco owns mutable zones. React subscribes only to the portal destinations,
// which change after reconciliation, never while React renders a comment.
function createCommentZoneStore() {
  const zones = new Map<number, CommentZone>();
  const listeners = new Set<() => void>();
  let snapshot: {
    readonly editor: monaco.editor.IStandaloneCodeEditor | null;
    readonly contentNodes: ReadonlyMap<number, HTMLElement>;
  } = { editor: null, contentNodes: new Map() };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    synchronize: (editor: monaco.editor.IStandaloneCodeEditor, zoneLines: string) => {
      const wanted = new Set(zoneLines === "" ? [] : zoneLines.split(",").map(Number));
      let touched = snapshot.editor !== editor;
      // Collect first so deleting entries does not change the iteration.
      const stale = [...zones.keys()].filter((endLine) => !wanted.has(endLine));

      editor.changeViewZones((accessor) => {
        for (const endLine of stale) {
          const zone = zones.get(endLine);
          if (zone === undefined) continue;
          accessor.removeZone(zone.zoneId);
          zones.delete(endLine);
          touched = true;
        }
        for (const endLine of wanted) {
          if (zones.has(endLine)) continue;
          const domNode = document.createElement("div");
          domNode.className = ZONE_CLASS;
          const contentNode = document.createElement("div");
          domNode.append(contentNode);
          stopEditorEvents(domNode);
          const zone: monaco.editor.IViewZone = {
            afterLineNumber: endLine,
            domNode,
            heightInPx: 0,
          };
          zones.set(endLine, {
            zoneId: accessor.addZone(zone),
            domNode,
            contentNode,
            zone,
          });
          touched = true;
        }
      });

      if (touched) {
        snapshot = {
          editor,
          contentNodes: new Map([...zones].map(([line, zone]) => [line, zone.contentNode])),
        };
        for (const listener of listeners) listener();
      }

      // The form grows with its textarea. Monaco needs the measured height or
      // it clips the portal's content.
      const byContentNode = new Map<Element, CommentZone>();
      for (const zone of zones.values()) byContentNode.set(zone.contentNode, zone);
      return observeResize([...byContentNode.keys()], (observed) => {
        let needsLayout = false;
        for (const item of observed) {
          const entry = byContentNode.get(item.target);
          if (entry === undefined) continue;
          const height = Math.ceil(item.contentRect.height);
          if (entry.zone.heightInPx === height) continue;
          entry.zone.heightInPx = height;
          needsLayout = true;
        }
        if (!needsLayout) return;
        editor.changeViewZones((accessor) => {
          for (const zone of zones.values()) accessor.layoutZone(zone.zoneId);
        });
      });
    },
    clear: () => {
      // The surface disposes the editor in a layout cleanup, before this
      // passive cleanup. Disposal removes its zones; calling it here reaches
      // through a disposed handle.
      zones.clear();
      snapshot = { editor: null, contentNodes: new Map() };
    },
  };
}

/**
 * Keeps the zone's own interactions out of the editor.
 *
 * A view zone is inside Monaco's DOM, so without this a keystroke in the
 * comment textarea also reaches the editor's keybindings, and a scroll inside a
 * long comment scrolls the file instead.
 */
function stopEditorEvents(node: HTMLElement): void {
  for (const type of ["pointerdown", "mousedown", "keydown", "wheel"] as const) {
    node.addEventListener(type, (event) => event.stopPropagation());
  }
}

function FileCommentZoneContent({
  group,
  onCancel,
  onComment,
  onDelete,
  onTextChange,
}: {
  group: FileCommentGroup;
  onCancel: (entryId: string) => void;
  onComment: (entryId: string, text: string) => void;
  onDelete: (entryId: string) => void;
  onTextChange: (entryId: string, text: string) => void;
}) {
  return (
    <div className="py-1">
      {group.entries.map((entry) => (
        <DiffCommentAnnotation
          key={entry.id}
          kind={entry.kind}
          rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
          text={entry.text}
          // Controlled on purpose. A zone is rebuilt when the text around it
          // moves, and an uncontrolled form would lose what the user had typed.
          onTextChange={(text) => onTextChange(entry.id, text)}
          onCancel={() => onCancel(entry.id)}
          onComment={(text) => onComment(entry.id, text)}
          onDelete={() => onDelete(entry.id)}
        />
      ))}
    </div>
  );
}
