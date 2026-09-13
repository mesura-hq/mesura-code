/**
 * What Neovim drew over the text, kept per row.
 *
 * Everything on the buffer grid that is not the file's own text arrives here:
 * flash's jump labels, the search highlight, a plugin's virtual text. It is
 * kept per row because of what an event means — `rows` names the buffer lines
 * this event fully replaces, and says nothing at all about the others.
 *
 * That rule is the whole reason this module is not a straight assignment. A
 * host that took each event as the complete picture would clear every flash
 * label the moment one unrelated row redrew, and under the developer's real
 * configuration a row redraws constantly.
 *
 * Pure, and diffing rather than replacing, so the driver's work per event is
 * bounded by what changed rather than by what is on screen. Rebuilding thirty
 * content widgets on every keystroke of a flash search is the difference
 * between a label that sits still and one that flickers.
 */

export interface DecorationOverlay {
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly hl: number;
}

export interface DecorationRun {
  readonly line: number;
  readonly startCol: number;
  readonly endCol: number;
  readonly hl: number;
}

export interface DecorationEvent {
  readonly overlays: ReadonlyArray<DecorationOverlay>;
  readonly highlightRuns: ReadonlyArray<DecorationRun>;
  /** The buffer lines this event replaces. Rows absent from it are untouched. */
  readonly rows: ReadonlyArray<number>;
}

export interface OverlayWidget extends DecorationOverlay {
  readonly id: string;
}

interface DecorationRow {
  readonly overlays: ReadonlyArray<DecorationOverlay>;
  readonly runs: ReadonlyArray<DecorationRun>;
}

export interface DecorationState {
  readonly rows: ReadonlyMap<number, DecorationRow>;
}

export const EMPTY_DECORATION_STATE: DecorationState = { rows: new Map() };

export interface DecorationChange {
  readonly state: DecorationState;
  /** Every widget that should exist now. */
  readonly widgets: ReadonlyArray<OverlayWidget>;
  readonly addedWidgets: ReadonlyArray<OverlayWidget>;
  /** Widgets in the same place whose text or colour moved on. */
  readonly changedWidgets: ReadonlyArray<OverlayWidget>;
  readonly removedWidgetIds: ReadonlyArray<string>;
  /** Every highlight run that should be drawn now. */
  readonly runs: ReadonlyArray<DecorationRun>;
}

/**
 * A widget's name, which is its position.
 *
 * Naming it by where it is rather than by what it says is what lets the same
 * node be reused when the label on it changes: a content widget removed and
 * added again flickers, and flash rewrites its labels on every keystroke.
 */
export function overlayWidgetId(line: number, col: number): string {
  return `nvim-ovl-${line}-${col}`;
}

/** Every widget a state implies, by id. */
export function widgetsFor(state: DecorationState): ReadonlyMap<string, OverlayWidget> {
  return widgetsOf(state.rows);
}

/** Every highlight run a state implies. */
export function runsFor(state: DecorationState): ReadonlyArray<DecorationRun> {
  const runs: DecorationRun[] = [];
  for (const row of state.rows.values()) runs.push(...row.runs);
  return runs;
}

/**
 * What changed between what is on screen and what should be.
 *
 * Separate from the fold because the two run in different places: the fold
 * accumulates whether or not anything is rendered, and the renderer compares
 * against what it last put on screen. A renderer that trusted the fold's own
 * diff would miss everything that happened while two events shared a render.
 */
export function diffWidgets(
  before: ReadonlyMap<string, OverlayWidget>,
  after: ReadonlyMap<string, OverlayWidget>,
): {
  readonly addedWidgets: ReadonlyArray<OverlayWidget>;
  readonly changedWidgets: ReadonlyArray<OverlayWidget>;
  readonly removedWidgetIds: ReadonlyArray<string>;
} {
  const addedWidgets: OverlayWidget[] = [];
  const changedWidgets: OverlayWidget[] = [];
  const removedWidgetIds: string[] = [];
  for (const [id, widget] of after) {
    const previous = before.get(id);
    if (previous === undefined) {
      addedWidgets.push(widget);
      continue;
    }
    if (previous.text !== widget.text || previous.hl !== widget.hl) changedWidgets.push(widget);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removedWidgetIds.push(id);
  }
  return { addedWidgets, changedWidgets, removedWidgetIds };
}

const widgetsOf = (rows: ReadonlyMap<number, DecorationRow>): Map<string, OverlayWidget> => {
  const widgets = new Map<string, OverlayWidget>();
  for (const row of rows.values()) {
    for (const overlay of row.overlays) {
      widgets.set(overlayWidgetId(overlay.line, overlay.col), {
        ...overlay,
        id: overlayWidgetId(overlay.line, overlay.col),
      });
    }
  }
  return widgets;
};

export function applyDecorationEvent(
  state: DecorationState,
  event: DecorationEvent,
): DecorationChange {
  const before = widgetsOf(state.rows);

  const rows = new Map(state.rows);
  for (const row of event.rows) rows.set(row, { overlays: [], runs: [] });
  for (const overlay of event.overlays) {
    const row = rows.get(overlay.line) ?? { overlays: [], runs: [] };
    rows.set(overlay.line, { ...row, overlays: [...row.overlays, overlay] });
  }
  for (const run of event.highlightRuns) {
    const row = rows.get(run.line) ?? { overlays: [], runs: [] };
    rows.set(run.line, { ...row, runs: [...row.runs, run] });
  }
  // A row with nothing left on it is a row nobody has to look at again.
  for (const [line, row] of rows) {
    if (row.overlays.length === 0 && row.runs.length === 0) rows.delete(line);
  }

  const after = widgetsOf(rows);
  const next: DecorationState = { rows };

  return {
    state: next,
    widgets: [...after.values()],
    ...diffWidgets(before, after),
    runs: runsFor(next),
  };
}
