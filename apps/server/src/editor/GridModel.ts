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
    if (grid !== undefined) this.#bufferGridId = grid;
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
        return;
      }
      case "grid_clear": {
        const grid = this.#grids.get(batch[0] as number);
        if (grid === undefined) return;
        for (const row of grid.cells) row.fill(" ");
        for (const row of grid.highlights) row.fill(0);
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
    const overlays: GridOverlay[] = [];
    const highlightRuns: HighlightRun[] = [];
    const changedRows: number[] = [];
    if (grid === undefined) return { overlays, highlightRuns, changedRows };

    for (let row = 0; row < grid.height; row += 1) {
      const hash = `${grid.cells[row]!.join("")} ${grid.highlights[row]!.join(",")}`;
      if (this.#rowHashes[row] !== hash) {
        this.#rowHashes[row] = hash;
        changedRows.push(row);
      }

      const bufferLine = this.#bufferLines[this.#topLine + row];
      if (bufferLine === undefined) continue;
      const line = this.#topLine + row + 1;

      let runStart: number | null = null;
      let runHighlight = 0;
      const closeRun = (endColumnExclusive: number) => {
        if (runStart === null) return;
        highlightRuns.push({
          line,
          // One-based, with an exclusive end, which is the shape a Monaco
          // range takes: a run over columns 2 to 5 is `startCol 2, endCol 6`.
          startCol: runStart + 1,
          endCol: endColumnExclusive + 1,
          hl: runHighlight,
        });
        runStart = null;
      };

      for (let column = 0; column < grid.width; column += 1) {
        const drawn = grid.cells[row]![column] ?? " ";
        const actual = bufferLine[column] ?? " ";
        const highlight = grid.highlights[row]![column] ?? 0;

        if (drawn !== actual && drawn !== " " && drawn !== "") {
          closeRun(column);
          overlays.push({ line, col: column + 1, text: drawn, hl: highlight });
          continue;
        }

        const marked =
          drawn === actual && drawn !== " " && highlight !== 0 && !this.#isHostDrawn(highlight);
        if (marked) {
          if (runStart === null) {
            runStart = column;
            runHighlight = highlight;
          } else if (runHighlight !== highlight) {
            closeRun(column);
            runStart = column;
            runHighlight = highlight;
          }
          continue;
        }
        closeRun(column);
      }
      closeRun(grid.width);
    }

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
