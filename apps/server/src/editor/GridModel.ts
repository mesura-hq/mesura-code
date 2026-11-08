/**
 * Classifies Neovim's grid against the buffer line under each row, as `vscode-neovim` does:
 * a differing character is virtual text, a matching character with a highlight is a mark.
 * Grid columns are screen cells (tabs, wide characters), so `classifyRow` reports UTF-16 columns.
 * This holds only while Neovim draws no gutter; the host plugin forces it off.
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
  /** How far the window is scrolled sideways, in screen cells. See `setLeftColumn`. */
  #leftColumn = 0;
  /**
   * Whether anything the classification reads moved since the last collect.
   * Some configurations flush about 230 times a second while idle, drawing nothing.
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

  /** One past the last buffer line Neovim drew, zero-based as it reports it. */
  get botLine(): number {
    return this.#botLine;
  }

  /**
   * The grid of the developer's window, `null` until the first `win_pos`.
   * With `ext_multigrid` only the redraw stream assigns this id; no API answers it.
   */
  get bufferGridId(): number | null {
    return this.#bufferGridId;
  }

  get topLine(): number {
    return this.#topLine;
  }

  /** How far the window is scrolled sideways, as the host plugin last reported it. */
  get leftColumn(): number {
    return this.#leftColumn;
  }

  /** The buffer's `tabstop`, as the host plugin last reported it. */
  get tabstop(): number {
    return this.#tabstop;
  }

  /**
   * How often the cursor actually moved. Many keys draw no cells (autopairs stepping over `)`),
   * so with `cellsDrawn` this tells a key's own frame from an empty idle flush.
   */
  get cursorMoves(): number {
    return this.#cursorMoves;
  }

  /**
   * Cells drawn since this model was made: monotonic, counted across every grid, because it
   * measures a keystroke's cost. Samples either side of a key give that key's cost.
   */
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
   * Neovim's `leftcol`, in screen cells. `win_viewport` does not carry it, so the host plugin
   * pushes it with the cursor before the frame that draws the key. The host sizes the grid so
   * this stays 0 (`gridWidth.ts`); only a line wider than the grid's bound reaches it.
   */
  setLeftColumn(leftColumn: number): void {
    if (!Number.isInteger(leftColumn) || leftColumn < 0 || leftColumn === this.#leftColumn) return;
    this.#leftColumn = leftColumn;
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
        const gridId = batch[0] as number;
        this.#touch(gridId);
        this.#grids.delete(gridId);
        this.#gridWindows.delete(gridId);
        if (this.#bufferGridId === gridId) this.#bufferGridId = null;
        return;
      }
      case "grid_scroll": {
        // Neovim moves rows it already sent and draws only the new ones. Ignoring this read
        // stale rows against new lines: one `<C-d>` produced 915 phantom overlays.
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
        // A redefined id can change whether its cells are the host's own
        // drawing, so the rows already read against the old one are stale.
        if (this.#highlightDefinitions.has(id)) this.#dirty = true;
        this.#highlightDefinitions.set(id, { attributes, groups });
        return;
      }
      case "win_pos": {
        // Map the grid to the current window. Do not take the latest `win_pos`: sidebars
        // (file tree, symbol list) report their own, and a sidebar read against the file
        // becomes all virtual text. Floats report `win_float_pos`, which is ignored.
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
      // The line, its text and `leftcol` are in the hash: after a scroll or a sideways shift,
      // the same cells read against other text still owe the client new decorations.
      const hash = `${line}\u0000${this.#leftColumn}\u0000${bufferLine ?? ""}\u0000${grid.cells[row]!.join("")}\u0000${grid.highlights[row]!.join(",")}`;
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
        leftColumn: this.#leftColumn,
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

/**
 * East Asian wide and fullwidth ranges, and emoji shown as emoji. An
 * approximation of Neovim's own width table, good for the scripts and symbols
 * a source file holds; a character it misjudges costs one misplaced overlay.
 */
const WIDE_CHARACTER =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;

/** How many screen cells a character takes when Neovim draws it as itself. */
function cellWidth(cluster: string): number {
  return WIDE_CHARACTER.test(cluster) ? 2 : 1;
}

/**
 * Code points Neovim will not draw as themselves (`utf_printable` in its
 * `mbyte.c`): zero-width formatting characters, the BOM, surrogates and a few
 * more. Each is drawn as its hex value in angle brackets.
 */
const UNPRINTABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x070f, 0x070f],
  [0x180b, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xfffe, 0xffff],
];

/**
 * How Neovim spells a character it cannot draw as itself, or `null` when it
 * draws the character. Measured against `nvim --embed`: `^A` for a control
 * character, `^?` for DEL, `<85>` for a C1 control, `<200b>` and `<070f>`
 * (four digits at least) for an unprintable one.
 */
function spellingOf(cluster: string): string | null {
  const code = cluster.codePointAt(0) ?? 0;
  if (code < 0x20) return `^${String.fromCharCode(code + 64)}`;
  if (code === 0x7f) return "^?";
  if (code >= 0x80 && code <= 0x9f) return `<${code.toString(16)}>`;
  for (const [low, high] of UNPRINTABLE_RANGES) {
    if (code >= low && code <= high) return `<${code.toString(16).padStart(4, "0")}>`;
  }
  return null;
}

/** Whether `cells` from `column` on hold exactly `spelled`, one character per cell. */
function cellsSpell(cells: ReadonlyArray<string>, column: number, spelled: string): boolean {
  for (let index = 0; index < spelled.length; index += 1) {
    if (cells[column + index] !== spelled[index]) return false;
  }
  return true;
}

/**
 * How many screen cells `cluster` takes when drawn at screen column `column`,
 * as Neovim draws it (`strdisplaywidth`): a tab reaches the next tab stop, an
 * unprintable character takes its spelling, anything else one or two cells.
 * The one width model for grid sizing and for reading a scrolled row.
 */
function cellsOf(cluster: string, column: number, tabstop: number): number {
  if (cluster === "\t") return tabstop - (column % tabstop);
  return spellingOf(cluster)?.length ?? cellWidth(cluster);
}

/** The characters of `text`, each with its UTF-16 offset, as Neovim counts them. */
function* clustersOf(
  text: string,
): Generator<{ readonly index: number; readonly cluster: string }> {
  // One pass for the whole line. Segmenting from each character on, as
  // `clusterLength` does, made one accent cost 90 ms on a 1,100-character
  // line measured seven rows at a time.
  if (!/[\u0080-\uffff]/.test(text)) {
    for (let index = 0; index < text.length; index += 1) yield { index, cluster: text[index]! };
    return;
  }
  for (const { index, segment } of graphemes.segment(text)) yield { index, cluster: segment };
}

/**
 * How many screen cells `text` takes, tabs expanded at `tabstop`, counted no
 * further than `limit`.
 */
export function displayWidth(text: string, tabstop: number, limit = Infinity): number {
  // Most lines are plain printable ASCII with no tab: a cell per UTF-16 unit.
  if (!/[^ -~]/.test(text)) return text.length;
  let column = 0;
  for (const { cluster } of clustersOf(text)) {
    column += cellsOf(cluster, column, tabstop);
    if (column >= limit) return column;
  }
  return column;
}

export interface ClassifyRowInput {
  readonly cells: ReadonlyArray<string>;
  readonly highlights: ReadonlyArray<number>;
  /** The buffer line the row shows. */
  readonly text: string;
  /** One-based. */
  readonly line: number;
  readonly tabstop: number;
  /** The screen column grid column 0 shows: Neovim's `leftcol`. */
  readonly leftColumn?: number;
  readonly isHostDrawn: (highlight: number) => boolean;
}

/**
 * Walks one drawn row and its buffer line together (tabs, wide characters) and reports overlays
 * at UTF-16 columns. Adjacent virtual cells on one highlight merge into one overlay, one client
 * node; past the line's end the overlay starts there and carries the blank gap in its text.
 * The walk starts at `leftColumn`: read from column 0, a shifted row is all phantom overlays.
 */
export function classifyRow(input: ClassifyRowInput): {
  readonly overlays: GridOverlay[];
  readonly highlightRuns: HighlightRun[];
} {
  const { cells, highlights, text, line, tabstop, isHostDrawn } = input;
  const leftColumn = input.leftColumn ?? 0;
  const overlays: GridOverlay[] = [];
  const highlightRuns: HighlightRun[] = [];

  let position = 0;
  /** The screen column of the next buffer character, until it reaches `leftColumn`. */
  let skipped = 0;
  /** What Neovim draws in the first cells for a character the left edge cuts. */
  let clipped: { readonly at: number; readonly drawing: string } | null = null;
  if (leftColumn > 0) {
    for (const { index, cluster } of clustersOf(text)) {
      const width = cellsOf(cluster, skipped, tabstop);
      if (skipped + width > leftColumn) {
        // A tab the edge cuts is read by the loop below from the cells left of
        // it, in screen columns. A wide character cut in half is drawn as `<`
        // and a spelled one as the rest of its spelling (`<200b>` from
        // `leftcol` 3 is `00b>`): both are that character, not virtual text.
        if (cluster !== "\t" && skipped < leftColumn) {
          const cut = leftColumn - skipped;
          const spelling = spellingOf(cluster);
          clipped = {
            at: index,
            drawing: spelling === null ? "<".repeat(width - cut) : spelling.slice(cut),
          };
          position = index + cluster.length;
        } else {
          position = index;
        }
        break;
      }
      skipped += width;
      position = index + cluster.length;
    }
  }
  /** The grid column the buffer text ended at, once it has. */
  let endColumn: number | null = null;
  // Initialised through a cast so the closures below that reassign them do not
  // leave TypeScript narrowing them to `null` for the rest of the loop.
  let overlay = null as { col: number; text: string; hl: number; lastColumn: number } | null;
  let run = null as { start: number; hl: number } | null;
  /**
   * A buffer character that something else was drawn over, and the grid
   * column its cells end at. A wide character under a one-cell label still
   * owns the cell after the label, so that cell must not be read against the
   * next character.
   */
  let covered = { at: 0, untilColumn: 0 };
  /** The grid column the row's own reading starts at, past a clipped character. */
  let firstColumn = 0;
  if (clipped !== null) {
    if (cellsSpell(cells, 0, clipped.drawing)) {
      firstColumn = clipped.drawing.length;
    } else {
      // Something else is drawn there: read it as drawn over that character.
      covered = { at: clipped.at, untilColumn: clipped.drawing.length };
    }
  }
  /** The last column that drew something over the text. */
  let lastOverlaidColumn = -2;

  const closeOverlay = () => {
    if (overlay === null) return;
    const trimmed = overlay.text.trimEnd();
    if (trimmed !== "") {
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

  for (let column = firstColumn; column < cells.length; column += 1) {
    const drawn = cells[column] ?? " ";
    const highlight = highlights[column] ?? 0;

    if (column < covered.untilColumn) {
      // The rest of a covered wide character: its right half, blanked, or
      // more of whatever was drawn over it.
      if (drawn === "") {
        if (overlay !== null && overlay.lastColumn === column - 1) overlay.lastColumn = column;
      } else if (drawn === " ") {
        closeOverlay();
      } else {
        addOverlay(column, drawn, highlight, covered.at);
        lastOverlaidColumn = column;
      }
      continue;
    }

    if (drawn === "" && lastOverlaidColumn === column - 1 && position < text.length) {
      // The right half of something wide drawn over the text, which covers
      // the next buffer character as well.
      const at = position;
      const length = clusterLength(text, position);
      covered = { at, untilColumn: column + cellWidth(text.slice(at, at + length)) };
      position += length;
      if (overlay !== null && overlay.lastColumn === column - 1) overlay.lastColumn = column;
      continue;
    }

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
      // In screen columns, so the stops stay where they are when scrolled.
      const screenColumn = column + leftColumn;
      const tabEnd = (Math.floor(screenColumn / tabstop) + 1) * tabstop;
      if (screenColumn + 1 >= tabEnd) position += 1;
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

    const length = clusterLength(text, position);
    const cluster = text.slice(position, position + length);
    const spelled = spellingOf(cluster);
    if (spelled !== null && cellsSpell(cells, column, spelled)) {
      // The file's own character, in the only form Neovim can draw it. Monaco
      // draws its own, so nothing is reported.
      position += length;
      closeOverlay();
      closeRun(at);
      column += spelled.length - 1;
      continue;
    }

    // Something else was drawn where the buffer has this character.
    position += length;
    covered = { at, untilColumn: column + cellsOf(cluster, column + leftColumn, tabstop) };
    closeRun(at);
    if (drawn === " ") {
      closeOverlay();
      continue;
    }
    addOverlay(column, drawn, highlight, at);
    lastOverlaidColumn = column;
  }
  closeOverlay();
  closeRun(Math.min(position, text.length));

  return { overlays, highlightRuns };
}
