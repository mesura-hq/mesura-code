import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { MimeGlob, MimeTables } from "@symmetria/fm-core/mime";

import { dataDirectories } from "../xdg.ts";

/**
 * Load the XDG shared-mime-info database from disk.
 *
 * The pure half (`fm-core/mime.ts`) is handed already-parsed tables and never
 * reads a file, which is what keeps it free of Node and testable without one.
 * This is the other half.
 *
 * **The database is the system's, not ours.** Shipping a copy would mean a file
 * type the user installed a program for — a `.kra`, a `.blend` — resolves in
 * their file manager and not in ours, which reads as our bug.
 */

async function readLines(path: string): Promise<string[]> {
  // A missing file is normal: not every data directory has a MIME database,
  // and a machine with none still runs — it just resolves fewer types.
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Parse one `globs2` row: `weight:mime:pattern[:flags]`.
 *
 * The pattern may itself contain a colon, so the split is bounded to three
 * fields and the remainder stays with the pattern — except for the trailing
 * flags field, which is a fixed vocabulary and is taken from the END.
 */
function parseGlob(line: string): MimeGlob | null {
  const parts = line.split(":");
  const weight = Number(parts[0]);
  const mime = parts[1];
  if (!Number.isFinite(weight) || mime === undefined || parts.length < 3) return null;

  const rest = parts.slice(2);
  const last = rest.at(-1);
  // `cs` is the only flag this resolver acts on: the minority of rows are
  // case-sensitive, and `*.[Cc]` telling a C source from a C++ one is why.
  const caseSensitive = last === "cs";
  const pattern = (caseSensitive ? rest.slice(0, -1) : rest).join(":");
  if (pattern === "") return null;

  return caseSensitive ? { weight, mime, pattern, caseSensitive } : { weight, mime, pattern };
}

/** Parse a two-column file (`subclasses`, `aliases`) into pairs. */
function parsePairs(lines: readonly string[]): [string, string][] {
  return lines
    .map((line) => line.split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length >= 2)
    .map(([left, right]) => [left, right]);
}

let cached: MimeTables | null = null;

/**
 * The tables, parsed once per process.
 *
 * Cached because the database is several thousand rows and does not change
 * while the application runs; re-reading it per preview would put a disk read
 * and a parse on every cursor movement.
 */
export async function mimeTables(): Promise<MimeTables> {
  if (cached !== null) return cached;

  const globs: MimeGlob[] = [];
  const subclasses = new Map<string, string[]>();
  const aliases = new Map<string, string>();

  for (const dir of dataDirectories()) {
    const mime = join(dir, "mime");

    for (const line of await readLines(join(mime, "globs2"))) {
      const glob = parseGlob(line);
      if (glob !== null) globs.push(glob);
    }

    for (const [child, parent] of parsePairs(await readLines(join(mime, "subclasses")))) {
      // A type may declare several parents, and the directories are read
      // most-specific first, so entries accumulate rather than replace.
      subclasses.set(child, [...(subclasses.get(child) ?? []), parent]);
    }

    for (const [alias, canonicalName] of parsePairs(await readLines(join(mime, "aliases")))) {
      // First writer wins: the user's directory is read first and its answer is
      // the one that should stand.
      if (!aliases.has(alias)) aliases.set(alias, canonicalName);
    }
  }

  cached = { globs, subclasses, aliases };
  return cached;
}

/** Drop the cache. For tests, which must not inherit another test's database. */
export function forgetMimeTables(): void {
  cached = null;
}
