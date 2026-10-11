// @effect-diagnostics nodeBuiltinImport:off - Dirent inspection bounds discovery without stat calls for every repository file.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ProjectFaviconPath } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".t3",
  ".mesura-code",
  ".repos",
  ".cache",
  ".next",
  ".nuxt",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  ".venv",
]);
const isProjectImagePath = Schema.is(ProjectFaviconPath);
const ICON_NAME =
  /favicon|apple[-_]touch|isotipo|imagotipo|(?:^|[-_.])(?:logo|icon|brand|mark)(?:[-_.]|$)/i;

export interface ProjectIconCandidate {
  readonly path: string;
  readonly bytes: number;
}

/** Inspect local brand assets with a fixed traversal budget. Never follow symlink directories. */
export async function collectProjectIconCandidates(
  workspaceRoot: string,
): Promise<ProjectIconCandidate[]> {
  const root = await NodeFSP.realpath(workspaceRoot);
  const directories = [{ relative: "", depth: 0 }];
  const candidates: ProjectIconCandidate[] = [];
  let inspectedEntries = 0;
  for (let index = 0; index < directories.length && index < 256; index++) {
    const directory = directories[index]!;
    const entries = await NodeFSP.readdir(NodePath.join(root, directory.relative), {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (++inspectedEntries > 20_000) return rankCandidates(candidates);
      const relative = NodePath.join(directory.relative, entry.name);
      if (entry.isDirectory() && directory.depth < 8 && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        directories.push({ relative, depth: directory.depth + 1 });
      } else if (entry.isFile() && isProjectImagePath(entry.name) && ICON_NAME.test(entry.name)) {
        const bytes = (await NodeFSP.stat(NodePath.join(root, relative))).size;
        if (bytes > 0 && bytes <= 2 * 1024 * 1024) candidates.push({ path: relative, bytes });
      }
    }
  }
  return rankCandidates(candidates);
}

function rankCandidates(candidates: ProjectIconCandidate[]): ProjectIconCandidate[] {
  const priority = (candidate: ProjectIconCandidate) => {
    const name = NodePath.basename(candidate.path);
    return /favicon|apple[-_]touch/i.test(name) ? 0 : /logo|icon/i.test(name) ? 1 : 2;
  };
  return candidates
    .sort((left, right) => priority(left) - priority(right) || left.path.localeCompare(right.path))
    .slice(0, 64);
}

/** Revalidate a selected file after the model returns, including realpath containment. */
export async function validateProjectIconCandidate(
  workspaceRoot: string,
  selected: string,
): Promise<boolean> {
  const root = await NodeFSP.realpath(workspaceRoot);
  const absolute = await NodeFSP.realpath(NodePath.resolve(root, selected));
  const relative = NodePath.relative(root, absolute);
  if (
    relative.startsWith(`..${NodePath.sep}`) ||
    relative === ".." ||
    NodePath.isAbsolute(relative)
  )
    return false;
  const stat = await NodeFSP.stat(absolute);
  return (
    stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024 && isProjectImagePath(absolute)
  );
}
