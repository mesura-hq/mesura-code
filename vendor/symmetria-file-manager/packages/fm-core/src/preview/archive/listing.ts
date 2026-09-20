import { compareNames } from "../../sort.ts";
import { type ArchiveEntry, MAX_ARCHIVE_ENTRIES } from "./types.ts";

/**
 * A flat list of archive paths, shaped into the rows the pane draws.
 *
 * Both readers hand over paths and nothing else. Everything about how an
 * archive LOOKS is decided here — the tree, the order, the depth, the cap and
 * the counts — so a zip and a tar cannot end up drawn differently.
 *
 * ── The folders have to be invented ─────────────────────────────────────────
 * A zip is a flat list and NOTHING obliges a writer to emit an entry for a
 * directory. `game/cache/build_info.json` can be the only mention of both
 * `game/` and `game/cache/`. Rows built straight from the entries would have
 * holes exactly where the structure is.
 */

export interface ArchiveRow {
  /** The whole path, which is also this row's identity. No trailing slash. */
  readonly path: string;
  /** The last segment, which is what the row shows. */
  readonly name: string;
  /** How far to indent. The root's own children are 0. */
  readonly depth: number;
  readonly isDirectory: boolean;
  /** Uncompressed bytes. Always 0 for a folder. */
  readonly size: number;
}

export interface ArchiveListing {
  readonly rows: readonly ArchiveRow[];
  readonly truncated: boolean;
  /** How many rows the archive would have. `rows.length` once truncated. */
  readonly totalRows: number;
  /**
   * Folders and files in the WHOLE archive, not in the visible rows.
   *
   * The pane says "120 dirs, 1369 files" under a listing that may be
   * truncated, so counting only what survived the cap would put a wrong number
   * on screen as a statement about the archive.
   */
  readonly dirCount: number;
  readonly fileCount: number;
}

interface Node {
  readonly name: string;
  readonly path: string;
  isDirectory: boolean;
  size: number;
  readonly children: Map<string, Node>;
}

function node(name: string, path: string): Node {
  return { name, path, isDirectory: true, size: 0, children: new Map() };
}

/**
 * A path's segments, with the noise an archive carries dropped.
 *
 * `tar -cf x.tar .` writes every member as `./name`, and a zip directory entry
 * ends in a slash. Both produce empty or `.` segments that would otherwise
 * become rows with no name.
 */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".");
}

function insert(root: Node, entry: ArchiveEntry): void {
  const segments = segmentsOf(entry.path);
  if (segments.length === 0) return;

  let current = root;
  for (const [index, name] of segments.entries()) {
    const path = current.path === "" ? name : `${current.path}/${name}`;

    let child = current.children.get(name);
    if (child === undefined) {
      child = node(name, path);
      current.children.set(name, child);
    }

    // Anything walked THROUGH is a folder, whatever it claimed to be. An
    // archive holding both `a/b` as a file and `a/b/c` is malformed, and a row
    // with children that says it is a file would draw as one. This is not a
    // hypothetical: `/opt/android-studio/lib/app.jar` has fourteen entries
    // declared as files that are also prefixes of other entries.
    //
    // **The size goes with the kind.** Flipping one and not the other left a
    // folder row carrying the byte count it had while it was a file, against
    // the invariant `ArchiveRow.size` states — and only when the file arrived
    // FIRST, which neither reader guarantees either way.
    if (index < segments.length - 1) {
      child.isDirectory = true;
      child.size = 0;
    }
    current = child;
  }

  // The last segment IS the entry, so it is the only one whose kind the
  // archive actually stated.
  current.isDirectory = entry.isDirectory || current.children.size > 0;
  current.size = current.isDirectory ? 0 : entry.size;
}

/** Folders first, then by name — the same rule `compareEntries` applies. */
function sortedChildren(parent: Node): Node[] {
  return [...parent.children.values()].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return compareNames(a.name, b.name);
  });
}

interface Counts {
  total: number;
  dirs: number;
  files: number;
}

/**
 * Depth-first over the tree, with an explicit stack rather than recursion.
 *
 * A path may hold 65535 bytes, so an archive can nominate a nesting depth deep
 * enough to exhaust the call stack — and a preview must not be able to crash
 * the panel because of what a file claims about itself.
 */
function flatten(root: Node, rows: ArchiveRow[], counts: Counts): void {
  const stack: { node: Node; depth: number }[] = [];
  const push = (parent: Node, depth: number) => {
    // Reversed, because a stack hands back what went on last.
    for (const child of sortedChildren(parent).reverse()) stack.push({ node: child, depth });
  };

  push(root, 0);

  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;

    const { node: current, depth } = next;
    counts.total += 1;
    if (current.isDirectory) counts.dirs += 1;
    else counts.files += 1;

    // The counts keep going after the rows stop, which is the whole reason
    // they are gathered in the same walk rather than from `rows`.
    if (rows.length < MAX_ARCHIVE_ENTRIES) {
      rows.push({
        path: current.path,
        name: current.name,
        depth,
        isDirectory: current.isDirectory,
        size: current.size,
      });
    }

    push(current, depth + 1);
  }
}

export function buildArchiveListing(entries: readonly ArchiveEntry[]): ArchiveListing {
  const root = node("", "");
  for (const entry of entries) insert(root, entry);

  const rows: ArchiveRow[] = [];
  const counts: Counts = { total: 0, dirs: 0, files: 0 };
  flatten(root, rows, counts);

  return {
    rows,
    truncated: counts.total > rows.length,
    totalRows: counts.total,
    dirCount: counts.dirs,
    fileCount: counts.files,
  };
}
