// @effect-diagnostics nodeBuiltinImport:off - reads the frozen fixture files beside this module.
/**
 * The editor latency bench's files, byte for byte: the Markdown from a port of the bench's seeded
 * `fixtures/make-fixtures.mjs`, the TypeScript frozen in `fixtures/sample.ts.txt`.
 * `RECORDED_J_RUNS` is the real client's `MESURA_EDITOR_TRACE` requests for "50 j from the top".
 * @module longLineFixtures
 */
import * as NodeFS from "node:fs";

/** mulberry32, seeded as the bench seeds it. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the editor session keeps a headless neovim per thread and every key travels over the websocket " +
  "to the server where the bridge forwards input and the grid model diffs cells against the buffer " +
  "so that monaco can paint text cursor and decorations while the status strip shows the current mode " +
  "remote hosts add latency on each round trip which makes queueing visible when typing quickly " +
  "markdown paragraphs are often written as one long line that wraps on screen in the file panel"
).split(" ");

/**
 * The bench's `long-lines.md`: 266 lines, paragraphs of 300 to 990 characters
 * in sections 1 to 10 and of 700 to 1,100 in sections 11 and 12.
 */
export function benchMarkdownLines(): ReadonlyArray<string> {
  const random = seededRandom(0x5eed1234);
  const paragraph = (min: number, max: number) => {
    const target = Math.floor(min + random() * (max - min));
    let text = "";
    while (text.length < target) {
      const word = WORDS[Math.floor(random() * WORDS.length)] ?? "";
      text += (text === "" ? "" : " ") + word;
      if (random() < 0.08) text += ",";
    }
    text = text.slice(0, target).replace(/[ ,]+$/, "");
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  };
  const lines = ["# Long-line Markdown fixture", ""];
  for (let section = 1; section <= 12; section += 1) {
    lines.push(`## Section ${section}`, "");
    for (let index = 0; index < 10; index += 1) {
      lines.push(section <= 10 ? paragraph(300, 990) : paragraph(700, 1100), "");
    }
  }
  return lines.join("\n").split("\n");
}

/** The bench's `sample.ts`: 685 lines, the longest (line 467) 225 characters. */
export function benchTypeScriptLines(): ReadonlyArray<string> {
  const text = NodeFS.readFileSync(new URL("./fixtures/sample.ts.txt", import.meta.url), "utf8");
  return text.split("\n");
}

/** A step of a recorded run: keys for `input`, or `[topline, rows, cols]` for `viewport`. */
export type RecordedStep = string | readonly [number, number, number];

export interface RecordedRun {
  /** The last viewport the client sent before the run began. */
  readonly before: readonly [number, number, number];
  readonly steps: ReadonlyArray<RecordedStep>;
}

export const RECORDED_J_RUNS = JSON.parse(
  NodeFS.readFileSync(new URL("./fixtures/recorded-j-runs.json", import.meta.url), "utf8"),
) as {
  readonly markdownAtDelay0: RecordedRun;
  readonly markdownAtDelay20: RecordedRun;
  readonly typescriptAtDelay0: RecordedRun;
  readonly typescriptAtDelay20: RecordedRun;
};

/** The one-based number of the longest line in `[first, last]`. */
export function widestLineIn(lines: ReadonlyArray<string>, first: number, last: number): number {
  let widest = first;
  for (let line = first; line <= last; line += 1) {
    if ((lines[line - 1]?.length ?? 0) > (lines[widest - 1]?.length ?? 0)) widest = line;
  }
  return widest;
}
