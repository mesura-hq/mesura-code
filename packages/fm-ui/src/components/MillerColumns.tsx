import type { FsEntry } from "@symmetria/fm-core/entry";
import type { FlashColumn } from "@symmetria/fm-core/flash/labels";
import { useCallback } from "react";

import type { ColumnLabels } from "../useFlash.ts";

import { FileList, NO_FLASH_LABELS, NO_SELECTION, type VisibleRange } from "./FileList.tsx";
import type { FlashRowLabel } from "./FlashName.tsx";
import { PreviewPane, type PreviewPaneProps } from "./preview/PreviewPane.tsx";

/** No labels anywhere. Shared, so an absent prop does not churn identities. */
const NO_COLUMN_LABELS: ColumnLabels = {
  current: NO_FLASH_LABELS,
  preview: NO_FLASH_LABELS,
  parent: NO_FLASH_LABELS,
};

/** A stable reporter for one column, or none when nobody is listening. */
function useReporter(
  column: FlashColumn,
  report: ((column: FlashColumn, range: VisibleRange) => void) | undefined,
): ((range: VisibleRange) => void) | undefined {
  const bound = useCallback((range: VisibleRange) => report?.(column, range), [column, report]);
  return report === undefined ? undefined : bound;
}

interface ParentColumnProps {
  readonly entries: readonly FsEntry[];
  /** Which entry it sits on — the directory we are inside. */
  readonly cursorName: string;
  /**
   * Go to a sibling directory. `undefined` leaves the whole column inert.
   *
   * Declared `| undefined` rather than optional, here and on the two components
   * below, so the composition can forward what it was given without a
   * conditional spread per prop — `exactOptionalPropertyTypes` forbids handing
   * an optional prop `undefined`, and four such spreads cost more than the
   * complexity bound allows in one function.
   */
  readonly onLeaveTo: ((name: string) => void) | undefined;
  readonly flashLabels: ReadonlyMap<number, FlashRowLabel>;
  readonly flashActive: boolean;
  readonly onVisibleRange: ((range: VisibleRange) => void) | undefined;
}

/**
 * The column you came from.
 *
 * One click, not two. This column is a list of destinations rather than a place
 * the cursor lives, so there is no selecting to do first — and `onActivate` is
 * deliberately absent, since the second click of a double click would then
 * re-navigate somewhere it already went.
 *
 * A FILE here is not a destination and is left inert. Entering it is impossible
 * and opening it on a single click would be both surprising and, for anything
 * the desktop hands to an application, hard to undo. The hand cursor therefore
 * appears only over the directories, which is what makes the column honest
 * about where a click will go.
 *
 * A component of its own rather than a block inside `MillerColumns`, because
 * the complexity gate scores a component as one function and this column's
 * conditional wiring was most of that one's branching.
 */
function ParentColumn({
  entries,
  cursorName,
  onLeaveTo,
  flashLabels,
  flashActive,
  onVisibleRange,
}: ParentColumnProps) {
  // NOT clamped to 0. If the directory we are inside has been renamed or
  // removed between reads, clamping would highlight whatever sits at index
  // zero and claim "this is where you are" — a false statement, which is worse
  // than no highlight. `-1` matches nothing.
  const cursorIndex = entries.findIndex((entry) => entry.name === cursorName);

  return (
    <FileList
      entries={entries}
      cursorIndex={cursorIndex}
      testId="column-parent"
      selection={NO_SELECTION}
      flashLabels={flashLabels}
      flashActive={flashActive}
      {...(onVisibleRange === undefined ? {} : { onVisibleRange })}
      {...(onLeaveTo === undefined
        ? {}
        : {
            onSelect: (index: number) => {
              const entry = entries[index];
              if (entry?.kind === "directory") onLeaveTo(entry.name);
            },
            clickableWhen: (entry: FsEntry) => entry.kind === "directory",
          })}
    />
  );
}

export interface MillerColumnsProps {
  readonly path: string;
  readonly parentEntries: readonly FsEntry[];
  readonly entries: readonly FsEntry[];
  readonly cursorIndex: number;
  /** Which entry the parent column sits on — the directory we are inside. */
  readonly parentCursorName: string;
  /** Marked entries in the CURRENT column, by name. */
  readonly selection?: ReadonlySet<string>;
  /** Search matches in the CURRENT column, by index. Nowhere else searches. */
  readonly matches?: ReadonlySet<number>;
  /** Flash labels for every column, by index within it, and whether one runs. */
  readonly flashLabels?: ColumnLabels;
  readonly flashActive?: boolean;
  /** What the third column shows. Absent means an empty slot. */
  readonly preview?: PreviewPaneProps;
  /** Move the cursor to a row of the current column. */
  readonly onSelect?: (index: number) => void;
  /** Enter or open a row of the current column. */
  readonly onActivate?: (index: number) => void;
  /** Go to a directory named in the parent column. */
  readonly onLeaveTo?: (name: string) => void;
  /** Which rows of a column are on screen. Every column reports its own. */
  readonly onVisibleRange?: (column: FlashColumn, range: VisibleRange) => void;
}

/**
 * Three columns: where we came from, where we are, and what is under the cursor.
 *
 * Each column is a solid surface over the window backdrop, per the transparency
 * model: the panes are opaque and the chrome between them is where the desktop
 * shows through.
 */
interface CurrentColumnProps {
  readonly entries: readonly FsEntry[];
  readonly cursorIndex: number;
  readonly selection: ReadonlySet<string>;
  readonly flashLabels: ReadonlyMap<number, FlashRowLabel>;
  readonly flashActive: boolean;
  readonly matches: ReadonlySet<number> | undefined;
  readonly onSelect: ((index: number) => void) | undefined;
  readonly onActivate: ((index: number) => void) | undefined;
  readonly onVisibleRange: ((range: VisibleRange) => void) | undefined;
}

/**
 * The column you are in: the only one with a cursor, a selection and a search.
 *
 * Its own component for the reason `ParentColumn` and `PreviewSlot` are: the
 * composition below is scored as one function, and its optional wiring — four
 * conditional spreads, since `exactOptionalPropertyTypes` forbids handing an
 * optional prop `undefined` — is most of what that function would cost.
 */
function CurrentColumn(props: CurrentColumnProps) {
  return (
    <FileList
      entries={props.entries}
      cursorIndex={props.cursorIndex}
      testId="column-current"
      selection={props.selection}
      flashActive={props.flashActive}
      flashLabels={props.flashLabels}
      {...(props.matches === undefined ? {} : { matches: props.matches })}
      {...(props.onSelect === undefined ? {} : { onSelect: props.onSelect })}
      {...(props.onActivate === undefined ? {} : { onActivate: props.onActivate })}
      {...(props.onVisibleRange === undefined ? {} : { onVisibleRange: props.onVisibleRange })}
    />
  );
}

interface PreviewSlotProps {
  readonly flashLabels: ReadonlyMap<number, FlashRowLabel>;
  readonly flashActive: boolean;
  readonly onVisibleRange: ((range: VisibleRange) => void) | undefined;
  /**
   * What to draw, or `undefined` for the empty slot.
   *
   * Declared as `| undefined` rather than optional: `exactOptionalPropertyTypes`
   * is on, and the caller forwards a value that may be absent rather than
   * choosing whether to pass the prop at all.
   */
  readonly preview: PreviewPaneProps | undefined;
  /** What the cursor is on, for the empty slot to name. */
  readonly cursorName: string;
}

/**
 * The third column: what entering would reveal, or an empty slot naming it.
 *
 * The empty case is not a placeholder to be tidied away — a window whose
 * preview has not resolved yet still has to say what the cursor is on, and the
 * slot has to occupy its width either way or the other two columns would move
 * under the reader as previews come and go.
 *
 * A component of its own for the reason `ParentColumn` is one: the composition
 * above is scored as a single function, and a ternary in its JSX costs the same
 * as one anywhere else.
 */
function PreviewSlot({
  preview,
  cursorName,
  flashLabels,
  flashActive,
  onVisibleRange,
}: PreviewSlotProps) {
  if (preview === undefined) {
    return (
      <div className="list" data-testid="column-preview">
        <span>{cursorName}</span>
      </div>
    );
  }
  return (
    <PreviewPane
      {...preview}
      flashLabels={flashLabels}
      flashActive={flashActive}
      {...(onVisibleRange === undefined ? {} : { onVisibleRange })}
    />
  );
}

export function MillerColumns({
  path,
  parentEntries,
  entries,
  cursorIndex,
  parentCursorName,
  selection = NO_SELECTION,
  matches,
  flashLabels = NO_COLUMN_LABELS,
  flashActive = false,
  preview,
  onSelect,
  onActivate,
  onLeaveTo,
  onVisibleRange,
}: MillerColumnsProps) {
  // One stable reporter per column. Bound here rather than inline, because an
  // arrow rebuilt each render would re-run the effect inside every column on
  // every keystroke.
  const reportCurrent = useReporter("current", onVisibleRange);
  const reportPreview = useReporter("preview", onVisibleRange);
  const reportParent = useReporter("parent", onVisibleRange);

  return (
    <div className="columns" data-path={path}>
      <ParentColumn
        entries={parentEntries}
        cursorName={parentCursorName}
        onLeaveTo={onLeaveTo}
        flashLabels={flashLabels.parent}
        flashActive={flashActive}
        onVisibleRange={reportParent}
      />
      <CurrentColumn
        entries={entries}
        cursorIndex={cursorIndex}
        selection={selection}
        flashLabels={flashLabels.current}
        flashActive={flashActive}
        matches={matches}
        onSelect={onSelect}
        onActivate={onActivate}
        onVisibleRange={reportCurrent}
      />
      <PreviewSlot
        preview={preview}
        cursorName={entries[cursorIndex]?.name ?? ""}
        flashLabels={flashLabels.preview}
        flashActive={flashActive}
        onVisibleRange={reportPreview}
      />
    </div>
  );
}
