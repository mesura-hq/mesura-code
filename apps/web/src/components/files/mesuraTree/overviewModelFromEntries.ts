import type { OverviewEntry } from "@symmetria/fm-core/overview/contract";
import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { joinPath } from "@symmetria/fm-core/pane";
import type { ProjectEntry } from "@t3tools/contracts";

/**
 * The server's flat file list, as the file manager's folder map.
 *
 * `projects.listEntries` answers with every path below the project root, files
 * and directories alike, relative to that root. The Symmetria tree renders an
 * `OverviewModel` whose folders are keyed by absolute path, so this is the one
 * place the two shapes meet. It is pure: the same list gives the same map.
 *
 * Every folder is `Loaded`. The file manager's own scanner has budgets and
 * partial states because it discovers a filesystem incrementally; the server
 * already holds the whole index, so those states have nothing to describe.
 */
export function overviewFoldersFromEntries(
  rawCwd: string,
  entries: ReadonlyArray<ProjectEntry>,
): ReadonlyMap<string, OverviewFolder> {
  const cwd = withoutTrailingSlash(rawCwd);
  const children = new Map<string, Map<string, OverviewEntry>>();
  const ensureFolder = (path: string) => {
    let names = children.get(path);
    if (!names) {
      names = new Map();
      children.set(path, names);
    }
    return names;
  };
  ensureFolder(cwd);

  // A directory listed by the server, or implied by a file's path, is entered
  // in its parent and gets a folder of its own, ancestor by ancestor.
  const ensureDirectory = (relative: string): string => {
    let parent = cwd;
    for (const segment of relative.split("/").filter((part) => part.length > 0)) {
      ensureFolder(parent).set(segment, directoryEntry(segment));
      parent = joinPath(parent, segment);
      ensureFolder(parent);
    }
    return parent;
  };

  for (const entry of entries) {
    if (entry.kind === "directory") {
      ensureDirectory(entry.path);
      continue;
    }
    const separator = entry.path.lastIndexOf("/");
    const name = separator === -1 ? entry.path : entry.path.slice(separator + 1);
    const parent = separator === -1 ? cwd : ensureDirectory(entry.path.slice(0, separator));
    ensureFolder(parent).set(name, fileEntry(name));
  }

  const folders = new Map<string, OverviewFolder>();
  for (const [path, names] of children) {
    folders.set(path, {
      path,
      depth: path === cwd ? 0 : path.slice(cwd.length + 1).split("/").length,
      entries: [...names.values()].sort(directoriesFirstThenName),
      status: "Loaded",
    });
  }
  return folders;
}

/** The path the panel opens, from the absolute path the tree activates. */
export function relativeToCwd(rawCwd: string, absolute: string): string | null {
  const cwd = withoutTrailingSlash(rawCwd);
  const prefix = cwd === "/" ? "/" : `${cwd}/`;
  if (!absolute.startsWith(prefix)) return null;
  const relative = absolute.slice(prefix.length);
  return relative.length > 0 ? relative : null;
}

/** One spelling of the root, so both functions key the same path the same way. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function directoryEntry(name: string): OverviewEntry {
  return { name, kind: "directory", isHidden: name.startsWith("."), isSymlink: false };
}

function fileEntry(name: string): OverviewEntry {
  return { name, kind: "file", isHidden: name.startsWith("."), isSymlink: false };
}

// The same order the file manager's scanner applies, so a row moves the same
// way here as it does in the standalone app.
function directoriesFirstThenName(a: OverviewEntry, b: OverviewEntry): number {
  return (
    Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)
  );
}
