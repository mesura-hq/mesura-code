import type { EntryClass } from "./entry.ts";
import { globToRegExp, specificity } from "./glob.ts";

/**
 * MIME resolution and classification, over the XDG shared-mime-info database.
 *
 * Pure: it is handed already-parsed tables and never reads a file. Loading them
 * is the privileged half's job (`app/src/main/fs/mimeTables.ts`), which is what
 * keeps this package free of Node and testable without one.
 */

/** One row of `globs2`: a weight, a type, a filename pattern, and its flags. */
export interface MimeGlob {
  readonly weight: number;
  readonly mime: string;
  readonly pattern: string;
  /**
   * The database's `cs` flag. The minority of rows are case-sensitive —
   * `*.[Cc]` tells a C source from a C++ one — and everything else folds case,
   * which is the only reason `photo.JPG` resolves.
   */
  readonly caseSensitive?: boolean;
}

export interface MimeTables {
  readonly globs: readonly MimeGlob[];
  /** From `subclasses`: child → its declared parents. */
  readonly subclasses: ReadonlyMap<string, readonly string[]>;
  /** From `aliases`: an old or alternative name → the canonical one. */
  readonly aliases: ReadonlyMap<string, string>;
}

/** How much of a file's head the content sniff inspects. */
const SNIFF_BYTES = 8192;

/** The type the database returns when it has nothing useful to say. */
/**
 * The type the database returns when it recognised nothing.
 *
 * Exported because `icons/resolve.ts` has to make the same judgement — a type
 * that carries no information must not be treated as an established fact — and
 * two spellings of that rule is how one of them silently stops matching.
 */
export const GENERIC = "application/octet-stream";

/**
 * Resolve a filename to a MIME type, or `null`.
 *
 * Specificity, in order: higher weight wins, then the longer pattern. Both
 * matter — `*.gz` and `*.tar.gz` both match `backup.tar.gz`, and the archive
 * type is the one a user means.
 */
export function resolveMimeType(tables: MimeTables, filename: string): string | null {
  const caseSensitivePatterns = patternsWithCaseFlag(tables.globs);
  let best: MimeGlob | null = null;

  for (const glob of tables.globs) {
    if (isRedundantDuplicate(glob, caseSensitivePatterns)) continue;
    if (!matches(glob, filename)) continue;
    if (best === null || wins(glob, best)) best = glob;
  }

  if (best === null) return null;
  return canonical(tables, best.mime);
}

/**
 * Which patterns the database marks case-sensitive somewhere.
 *
 * Cached per table object, because `resolveMimeType` is called once per
 * filename over a table of roughly two thousand rows and rebuilding this set
 * each time would make the common path quadratic.
 */
const caseFlagCache = new WeakMap<readonly MimeGlob[], ReadonlySet<string>>();

function patternsWithCaseFlag(globs: readonly MimeGlob[]): ReadonlySet<string> {
  const cached = caseFlagCache.get(globs);
  if (cached !== undefined) return cached;

  const flagged = new Set<string>();
  for (const glob of globs) {
    if (glob.caseSensitive === true) flagged.add(glob.pattern);
  }
  caseFlagCache.set(globs, flagged);
  return flagged;
}

/**
 * Is this row the compatibility duplicate of a case-sensitive one?
 *
 * The real database writes each case-sensitive rule TWICE: once with the `cs`
 * flag and once without. The unflagged copy exists only so that a parser which
 * does not understand `cs` still sees the rule at all. A parser that does
 * understand it must ignore the copy.
 *
 * Treating them as two independent rows is not a small mistake. Verification
 * caught it: `*.C:cs` and its unflagged twin `*.C` both matched `main.c` — the
 * twin case-insensitively — tying on weight and specificity with the correct
 * `*.c:cs` row, and the tie broke on file order. `main.c` resolved to
 * `text/x-c++src`. The same defect reproduced on all five `cs` pairs the
 * database carries: `*.c`, `*.C`, `*.gs`, `perf.data` and `core`.
 */
function isRedundantDuplicate(glob: MimeGlob, caseSensitivePatterns: ReadonlySet<string>): boolean {
  return glob.caseSensitive !== true && caseSensitivePatterns.has(glob.pattern);
}

/**
 * Compiled patterns, keyed by the pattern and its case flag.
 *
 * `resolveMimeType` walks every row of a table with roughly two thousand of
 * them, once per filename. Recompiling each pattern per call would make the
 * common path quadratic in the worst way.
 */
const compiled = new Map<string, RegExp>();

function matches(glob: MimeGlob, filename: string): boolean {
  const key = `${glob.caseSensitive === true ? "s" : "i"}:${glob.pattern}`;
  let expression = compiled.get(key);
  if (expression === undefined) {
    expression = globToRegExp(glob.pattern, glob.caseSensitive ?? false);
    compiled.set(key, expression);
  }
  return expression.test(filename);
}

function wins(candidate: MimeGlob, incumbent: MimeGlob): boolean {
  if (candidate.weight !== incumbent.weight) return candidate.weight > incumbent.weight;
  return specificity(candidate.pattern) > specificity(incumbent.pattern);
}

/** Follow an alias to the name the rest of the database uses. */
export function canonical(tables: MimeTables, mime: string): string {
  return tables.aliases.get(mime) ?? mime;
}

/**
 * Does `mime` inherit from `ancestor`?
 *
 * Two rules are implicit in the specification and absent from the tables. Both
 * are implemented here, and the first one is load-bearing:
 *
 * 1. **Every `text/*` type is a subclass of `text/plain`.** `text/x-shellscript`
 *    lists only `application/x-executable` as a parent in the real `subclasses`
 *    file — it is never connected to `text/plain` there. An implementation that
 *    reads the table and stops decides a shell script is not text, and every
 *    shell script silently stops previewing.
 * 2. **Every type is a subclass of `application/octet-stream`.**
 *
 * The `seen` set is not decoration: the database is user-extensible and a cycle
 * would otherwise recurse until the stack gives out.
 */
export function inheritsFrom(tables: MimeTables, mime: string, ancestor: string): boolean {
  const target = canonical(tables, ancestor);
  const start = canonical(tables, mime);

  if (start === target) return true;
  if (target === GENERIC) return true; // implicit rule 2

  const seen = new Set<string>();
  const queue = [start];

  while (queue.length > 0) {
    // SAFETY: `queue.length > 0` is the loop condition, so `pop` returns an
    // element rather than `undefined`.
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    if (current === target) return true;
    // Implicit rule 1, applied at every hop rather than only at the start, so
    // a type whose ancestry passes through any text/* subtype still resolves.
    if (target === "text/plain" && current.startsWith("text/")) return true;

    for (const parent of tables.subclasses.get(current) ?? []) {
      queue.push(canonical(tables, parent));
    }
  }

  return false;
}

export function isTextMime(tables: MimeTables, mime: string): boolean {
  return inheritsFrom(tables, mime, "text/plain");
}

export function isImageMime(tables: MimeTables, mime: string): boolean {
  return canonical(tables, mime).startsWith("image/");
}

/**
 * Does this file's head look binary?
 *
 * A NUL byte in the first eight kilobytes. Crude, and exactly what makes an
 * extensionless configuration file preview when the database has no opinion.
 */
export function looksBinary(head: Uint8Array): boolean {
  const limit = Math.min(head.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}

/**
 * Decide what a preview would do with this entry.
 *
 * **The order is a contract, not a convenience.** `image/svg+xml` inherits from
 * `application/xml`, which inherits from `text/plain`, so an SVG *is* text under
 * the inheritance rules. The image test must run first or every SVG previews as
 * source. The Qt router got this right only because it happened to test
 * `isImage` before falling through to text.
 */
export function classify(tables: MimeTables, mime: string | null, head: Uint8Array): EntryClass {
  if (mime !== null && mime !== GENERIC) {
    if (isImageMime(tables, mime)) return "image";
    if (isTextMime(tables, mime)) return "text";
  }
  // No type, or the useless generic one: the content is the only evidence left.
  return looksBinary(head) ? "binary" : "text";
}
