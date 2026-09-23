/**
 * What Neovim draws, read against what the buffer actually contains.
 *
 * Neovim's UI protocol reports a grid of cells: characters and highlight ids at
 * screen positions. That is a drawing, not a meaning — nothing in it says which
 * characters are the file and which are decoration a plugin painted over it. The
 * classification `vscode-neovim` uses, and this uses, recovers the difference by
 * comparing each cell against the buffer line underneath it:
 *
 * - the cell's character differs from the buffer's → something drew over the
 *   text, so it is **virtual**: a flash label, inline diagnostics, a git blame;
 * - the characters match but the cell carries a highlight → the text is the
 *   file's own, marked: a search match, an incremental-substitution preview;
 * - a blank is neither.
 *
 * **Grid columns are screen cells, not buffer columns.** A tab is several
 * cells, a wide character is two (the second drawn as an empty string), and a
 * character outside ASCII is one cell but several bytes and possibly two
 * UTF-16 units. `classifyRow` walks the buffer line and the row together, so
 * what it reports is in UTF-16 columns — Monaco's unit — whatever the line
 * holds. Comparing index for index read every character after the first tab
 * or accent on a line as a phantom label.
 *
 * **This only holds while Neovim draws no gutter.** With line numbers on, grid
 * column N is not buffer column N, every character on the line differs from the
 * one it is compared against, and a single flash jump produced 132 phantom
 * labels when the prototype measured it. The host draws the gutter; the host
 * plugin forces Neovim's off. A test pins that reasoning in place.
 */

export interface GridOverlay {
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly hl: number;
}

export interface HighlightRun {
  readonly line: number;
  readonly startCol: number;
  readonly endCol: number;
  readonly hl: number;
}

export interface GridCollection {
  readonly overlays: GridOverlay[];
  readonly highlightRuns: HighlightRun[];
  /** Rows whose drawn content changed since the previous collection. */
  readonly changedRows: number[];
}

/**
 * Highlight groups the host renders itself, so reporting them would draw them
 * twice — once by Monaco and once as our own decoration, in disagreeing colours.
 */
const HOST_DRAWN_GROUPS: ReadonlySet<string> = new Set([
  "Visual",
  "Cursor",
  "CursorLine",
  "CursorLineNr",
  "Normal",
  "NonText",
  "EndOfBuffer",
  "Whitespace",
  "LineNr",
  "SignColumn",
]);

interface Grid {
  width: number;
  height: number;
  cells: string[][];
  highlights: number[][];
}

interface HighlightDefinition {
  readonly attributes: Record<string, unknown>;
  readonly groups: ReadonlySet<string>;
}

export class GridModel {
  readonly #grids = new Map<number, Grid>();
  readonly #highlightDefinitions = new Map<number, HighlightDefinition>();
  /** Which window each grid belongs to, as `win_pos` reports it. */
  readonly #gridWindows = new Map<number, number>();
  #currentWindow: number | null = null;
  #bufferGridId: number | null = null;
  #botLine = 0;
  #bufferLines: readonly string[] = [];
  #topLine = 0;
  #rowHashes: string[] = [];
  #tabstop = 8;
  /**
   * Whether anything the classification reads moved since the last collect.
   *
   * A real configuration flushes about 230 times a second while idle, nearly
   * always drawing nothing, so re-reading the whole grid on every one of them
   * is work for no answer.
   */
  #dirty = true;
  #overlays: GridOverlay[] = [];
  #highlightRuns: HighlightRun[] = [];
  #cellsDrawn = 0;
  #cursorRow = -1;
  #cursorColumn = -1;
  #cursorMoves = 0;

  /** The highlight definitions seen so far, for the client's own palette. */
  get highlightDefinitions(): ReadonlyMap<number, HighlightDefinition> {
    return this.#highlightDefinitions;
  }

  /**
   * The grid Neovim draws the developer's window on, once it has said so.
   *
   * `null` until the first `win_pos`. Resizing a grid needs this number and
   * there is no API that answers it: with `ext_multigrid` the id is assigned
   * by the redraw stream, so the only place that knows is whatever has been
   * reading that stream.
   */
  /** One past the last buffer line Neovim drew, zero-based as it reports it. */
  get botLine(): number {
    return this.#botLine;
  }

  get bufferGridId(): number | null {
    return this.#bufferGridId;
  }

  get topLine(): number {
    return this.#topLine;
  }

  /**
   * How many cells Neovim has drawn since this model was made.
   *
   * Monotonic, and counted across every grid rather than only the buffer's,
   * because what it measures is how much work a keystroke caused — a float
   * that repaints costs the same as a line that does. Two samples either side
   * of a key give that key's cost, and a sample that did not move says the
   * frame drew nothing, which is how the bench tells a key's own frame from a
   * status line redrawing on its own.
   */
  /**
   * How often the cursor has moved, counted only when it actually moved.
   *
   * The companion to `cellsDrawn`, and needed because a great many keys draw
   * no cells at all: with autopairs on, typing the `)` it already inserted
   * only steps the cursor over it. Between them the two counters answer "did
   * anything happen", which is what tells a key's own frame from the steady
   * stream of empty ones a real configuration emits — measured at about one
   * every four milliseconds, nearly all of them drawing nothing.
   */
  get cursorMoves(): number {
    return this.#cursorMoves;
  }

  get cellsDrawn(): number {
    return this.#cellsDrawn;
  }

  setBufferLines(lines: readonly string[]): void {
    this.#bufferLines = lines;
    this.#dirty = true;
  }

  /** The buffer's `tabstop`, which decides how many cells a tab is drawn as. */
  setTabstop(tabstop: number): void {
    if (!Number.isInteger(tabstop) || tabstop < 1 || tabstop === this.#tabstop) return;
    this.#tabstop = tabstop;
    this.#dirty = true;
  }

  /**
   * Names the window the developer is in, so its grid is the one read.
   *
   * The redraw stream alone cannot answer this: `win_pos` says where every
   * window is and never which one has the cursor.
   */
  setCurrentWindow(window: number): void {
    this.#currentWindow = window;
    const grid = [...this.#gridWindows].find(([, id]) => id === window)?.[0];
    if (grid !== undefined && grid !== this.#bufferGridId) {
      this.#bufferGridId = grid;
      this.#dirty = true;
    }
  }

  /** Applies one `redraw` notification's parameters. */
  applyRedraw(events: ReadonlyArray<ReadonlyArray<unknown>>): void {
    for (const event of events) {
      const [name, ...batches] = event as [string, ...ReadonlyArray<ReadonlyArray<unknown>>];
      for (const batch of batches) {
        this.#applyEvent(name, batch);
      }
    }
  }

  #applyEvent(name: string, batch: ReadonlyArray<unknown>): void {
    switch (name) {
      case "grid_resize": {
        const [id, width, height] = batch as [number, number, number];
        this.#ensureGrid(id, width, height);
        this.#touch(id);
        return;
      }
      case "grid_clear": {
        const grid = this.#grids.get(batch[0] as number);
        if (grid === undefined) return;
        for (const row of grid.cells) row.fill(" ");
        for (const row of grid.highlights) row.fill(0);
        this.#touch(batch[0] as number);
        return;
      }
      case "grid_destroy": {
        this.#grids.delete(batch[0] as number);
        this.#touch(batch[0] as number);
        return;
      }
      case "grid_scroll": {
        // Neovim scrolls by moving rows it already sent and drawing only the
        // ones that came into view. Ignoring this left every moved row holding
        // what it showed before the scroll, read against the line now under
        // it: one `<C-d>` in a 442-line file produced 915 phantom overlays, and
        // a closing tag from the top of the screen appeared mid-file.
        const [gridId, top, bottom, left, right, rows] = batch as [
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        const grid = this.#grids.get(gridId);
        if (grid === undefined) return;
        scrollRegion(grid.cells, top, bottom, left, right, rows);
        scrollRegion(grid.highlights, top, bottom, left, right, rows);
        this.#touch(gridId);
        return;
      }
      case "hl_attr_define": {
        const [id, attributes, , info] = batch as [
          number,
          Record<string, unknown>,
          unknown,
          ReadonlyArray<{ hi_name?: string }> | undefined,
        ];
        const groups = new Set<string>();
        for (const entry of info ?? []) {
          if (typeof entry?.hi_name === "string") groups.add(entry.hi_name);
        }
        this.#highlightDefinitions.set(id, { attributes, groups });
        return;
      }
      case "win_pos": {
        // The grid that belongs to the window the developer is in.
        //
        // Taking the most recent `win_pos` instead looks equivalent and is
        // not: a real configuration opens several ordinary windows — a file
        // tree, a symbol list — and each reports its own `win_pos`, so the
        // last one reported is usually a sidebar. Read against the file's
        // lines, a sidebar's cells differ everywhere and the whole window
        // becomes virtual text belonging to no line. Floats (which-key,
        // snacks, noice) never arrive here at all; they report
        // `win_float_pos`, which is ignored.
        const [gridId, window] = batch as [number, { id?: number } | undefined];
        this.#dirty = true;
        if (typeof window?.id === "number") {
          this.#gridWindows.set(gridId, window.id);
          if (window.id === this.#currentWindow) this.#bufferGridId = gridId;
          // Before anyone says which window is current, the first one reported
          // is the only candidate there is.
          if (this.#currentWindow === null && this.#bufferGridId === null) {
            this.#bufferGridId = gridId;
          }
          return;
        }
        if (this.#bufferGridId === null) this.#bufferGridId = gridId;
        return;
      }
      case "win_viewport": {
        // `botline` is one past the last line Neovim drew, and it is the only
        // place the window's height in *buffer* lines is reported: the grid's
        // own height counts screen rows, which a wrapped line makes two of.
        const [gridId, , topLine, botLine] = batch as [number, unknown, number, number];
        if (gridId !== this.#bufferGridId) return;
        if (topLine !== this.#topLine) this.#dirty = true;
        this.#topLine = topLine;
        this.#botLine = botLine;
        return;
      }
      case "grid_cursor_goto": {
        const [gridId, row, column] = batch as [number, number, number];
        if (gridId !== this.#bufferGridId) return;
        if (row === this.#cursorRow && column === this.#cursorColumn) return;
        this.#cursorRow = row;
        this.#cursorColumn = column;
        this.#cursorMoves += 1;
        return;
      }
      case "grid_line": {
        this.#applyGridLine(batch);
        return;
      }
      default:
        return;
    }
  }

  #applyGridLine(batch: ReadonlyArray<unknown>): void {
    const [gridId, row, startColumn, cells] = batch as [
      number,
      number,
      number,
      ReadonlyArray<[string, number?, number?]>,
    ];
    const grid = this.#grids.get(gridId);
    if (grid === undefined || row >= grid.height) return;
    this.#touch(gridId);
    let column = startColumn;
    let highlight = 0;
    for (const cell of cells) {
      const [text] = cell;
      if (cell.length > 1 && typeof cell[1] === "number") highlight = cell[1];
      const repeat = cell.length > 2 && typeof cell[2] === "number" ? cell[2] : 1;
      for (let index = 0; index < repeat; index += 1) {
        if (column < grid.width) {
          grid.cells[row]![column] = text;
          grid.highlights[row]![column] = highlight;
          // Counted here rather than beside `column += 1`: a `grid_line` run
          // routinely pads past the end of the row, and a cell that was never
          // written was never drawn. Counting the padding inflated every
          // figure derived from this by an amount nothing bounded.
          this.#cellsDrawn += 1;
        }
        column += 1;
      }
    }
  }

  /** Marks the classification stale when the grid drawn into is the one it reads. */
  #touch(gridId: number): void {
    if (this.#bufferGridId === null || gridId === this.#bufferGridId) this.#dirty = true;
  }

  #ensureGrid(id: number, width: number, height: number): Grid {
    const existing = this.#grids.get(id);
    if (existing !== undefined && existing.width === width && existing.height === height) {
      return existing;
    }
    const grid: Grid = {
      width,
      height,
      cells: Array.from({ length: height }, () => Array.from({ length: width }, () => " ")),
      highlights: Array.from({ length: height }, () => Array.from({ length: width }, () => 0)),
    };
    this.#grids.set(id, grid);
    return grid;
  }

  /**
   * Reads the current drawing against the buffer.
   *
   * `changedRows` is the set of rows whose drawn content moved since the last
   * call, so the bridge can push only what changed rather than the viewport.
   */
  collect(): GridCollection {
    const grid = this.#bufferGridId === null ? undefined : this.#grids.get(this.#bufferGridId);
    if (grid === undefined) return { overlays: [], highlightRuns: [], changedRows: [] };
    if (!this.#dirty) {
      return { overlays: this.#overlays, highlightRuns: this.#highlightRuns, changedRows: [] };
    }
    this.#dirty = false;

    const overlays: GridOverlay[] = [];
    const highlightRuns: HighlightRun[] = [];
    const changedRows: number[] = [];
    const isHostDrawn = (highlight: number) => this.#isHostDrawn(highlight);

    for (let row = 0; row < grid.height; row += 1) {
      const bufferLine = this.#bufferLines[this.#topLine + row];
      const line = this.#topLine + row + 1;
      // The line and its text are part of the hash, not only the drawing: a
      // row that shows a different line after a scroll owes the client that
      // line's decorations even when the cells happen to be the same.
      const hash = `${line}\u0000${bufferLine ?? ""}\u0000${grid.cells[row]!.join("")}\u0000${grid.highlights[row]!.join(",")}`;
      if (this.#rowHashes[row] !== hash) {
        this.#rowHashes[row] = hash;
        changedRows.push(row);
      }
      if (bufferLine === undefined) continue;

      const classified = classifyRow({
        cells: grid.cells[row]!,
        highlights: grid.highlights[row]!,
        text: bufferLine,
        line,
        tabstop: this.#tabstop,
        isHostDrawn,
      });
      overlays.push(...classified.overlays);
      highlightRuns.push(...classified.highlightRuns);
    }

    this.#overlays = overlays;
    this.#highlightRuns = highlightRuns;
    return { overlays, highlightRuns, changedRows };
  }

  #isHostDrawn(highlight: number): boolean {
    const definition = this.#highlightDefinitions.get(highlight);
    if (definition === undefined) return false;
    for (const group of definition.groups) {
      if (HOST_DRAWN_GROUPS.has(group)) return true;
    }
    return false;
  }
}

/** Moves rows `[top, bottom)` of one grid by `rows`, only within `[left, right)`. */
function scrollRegion<T>(
  grid: T[][],
  top: number,
  bottom: number,
  left: number,
  right: number,
  rows: number,
): void {
  if (rows > 0) {
    for (let row = top; row < bottom - rows; row += 1) {
      const source = grid[row + rows];
      const target = grid[row];
      if (source === undefined || target === undefined) continue;
      for (let column = left; column < right; column += 1) target[column] = source[column]!;
    }
    return;
  }
  for (let row = bottom - 1; row >= top - rows; row -= 1) {
    const source = grid[row + rows];
    const target = grid[row];
    if (source === undefined || target === undefined) continue;
    for (let column = left; column < right; column += 1) target[column] = source[column]!;
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How many UTF-16 units the character starting at `index` takes, marks included. */
function clusterLength(text: string, index: number): number {
  const segments = graphemes.segment(text.slice(index, index + 32));
  const first = segments[Symbol.iterator]().next();
  return first.done === true ? 1 : Math.max(1, first.value.segment.length);
}

export interface ClassifyRowInput {
  readonly cells: ReadonlyArray<string>;
  readonly highlights: ReadonlyArray<number>;
  /** The buffer line the row shows. */
  readonly text: string;
  /** One-based. */
  readonly line: number;
  readonly tabstop: number;
  readonly isHostDrawn: (highlight: number) => boolean;
}

/**
 * Reads one drawn row against the buffer line under it.
 *
 * Walks both at once: a cell that holds the buffer's next character is the
 * file's own text, and advances the buffer by that character's UTF-16 length;
 * a tab is however many blank cells reach the next tab stop; an empty cell is
 * the right half of a wide character and stands for nothing. What is left is
 * drawn over the text or past its end, and is reported as an overlay at the
 * UTF-16 column of the character it covers.
 *
 * Adjacent virtual cells on one highlight are one overlay, because each one
 * becomes a node on the client: git blame at the end of a line is one label,
 * not forty. Past the end of the line the overlay starts at the line's end and
 * carries the blank gap before it in its text, since Monaco has no column
 * there to put it at.
 *
 * Assumes the window is not scrolled sideways (`leftcol` 0), which holds while
 * the client sizes the grid wider than the widest visible line.
 */
export function classifyRow(input: ClassifyRowInput): {
  readonly overlays: GridOverlay[];
  readonly highlightRuns: HighlightRun[];
} {
  const { cells, highlights, text, line, tabstop, isHostDrawn } = input;
  const overlays: GridOverlay[] = [];
  const highlightRuns: HighlightRun[] = [];

  let position = 0;
  /** The grid column the buffer text ended at, once it has. */
  let endColumn: number | null = null;
  // Initialised through a cast so the closures below that reassign them do not
  // leave TypeScript narrowing them to `null` for the rest of the loop.
  let overlay = null as { col: number; text: string; hl: number; lastColumn: number } | null;
  let run = null as { start: number; hl: number } | null;

  const closeOverlay = () => {
    if (overlay === null) return;
    const trimmed = overlay.text.trimEnd();
    if (trimmed.trim().length > 0) {
      overlays.push({ line, col: overlay.col, text: trimmed, hl: overlay.hl });
    }
    overlay = null;
  };
  const closeRun = (endExclusive: number) => {
    if (run === null) return;
    // One-based, with an exclusive end, which is the shape a Monaco range
    // takes: a run over UTF-16 columns 2 to 5 is `startCol 2, endCol 6`.
    if (endExclusive > run.start) {
      highlightRuns.push({ line, startCol: run.start + 1, endCol: endExclusive + 1, hl: run.hl });
    }
    run = null;
  };
  const addOverlay = (column: number, drawn: string, highlight: number, at: number) => {
    if (overlay !== null && overlay.hl === highlight && overlay.lastColumn === column - 1) {
      overlay.text += drawn;
      overlay.lastColumn = column;
      return;
    }
    closeOverlay();
    const gap = endColumn === null ? "" : " ".repeat(Math.max(0, column - endColumn));
    overlay = { col: at + 1, text: gap + drawn, hl: highlight, lastColumn: column };
  };

  for (let column = 0; column < cells.length; column += 1) {
    const drawn = cells[column] ?? " ";
    const highlight = highlights[column] ?? 0;

    if (drawn === "") {
      // The right half of a wide character belongs to whatever the left half
      // was, so an overlay made of wide characters stays one overlay.
      if (overlay !== null && overlay.lastColumn === column - 1) overlay.lastColumn = column;
      continue;
    }

    if (position >= text.length) {
      endColumn ??= column;
      closeRun(text.length);
      if (drawn === " ") {
        // Blanks inside virtual text on its own highlight belong to it:
        // "You, 2 days ago" is one label. Trailing ones are trimmed at close.
        if (overlay !== null && highlight !== 0 && overlay.hl === highlight) {
          overlay.text += " ";
          overlay.lastColumn = column;
        } else {
          closeOverlay();
        }
        continue;
      }
      addOverlay(column, drawn, highlight, text.length);
      continue;
    }

    const at = position;
    if (text[position] === "\t") {
      const tabEnd = (Math.floor(column / tabstop) + 1) * tabstop;
      if (column + 1 >= tabEnd) position += 1;
      closeRun(at);
      if (drawn === " ") closeOverlay();
      else addOverlay(column, drawn, highlight, at);
      continue;
    }

    if (text.startsWith(drawn, position)) {
      position += drawn.length;
      closeOverlay();
      const marked = drawn !== " " && highlight !== 0 && !isHostDrawn(highlight);
      if (!marked) {
        closeRun(at);
        continue;
      }
      if (run !== null && run.hl !== highlight) closeRun(at);
      run ??= { start: at, hl: highlight };
      continue;
    }

    // Something else was drawn where the buffer has this character.
    position += clusterLength(text, position);
    closeRun(at);
    if (drawn === " ") {
      closeOverlay();
      continue;
    }
    addOverlay(column, drawn, highlight, at);
  }
  closeOverlay();
  closeRun(Math.min(position, text.length));

  return { overlays, highlightRuns };
}
