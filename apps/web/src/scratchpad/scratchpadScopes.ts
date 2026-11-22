import { type ProjectId, type ThreadId } from "@t3tools/contracts";

/** Tab walks the scopes in this order; Shift+Tab walks it backwards. */
const SCRATCHPAD_SCOPES = ["general", "project", "thread"] as const;
export type ScratchpadScope = (typeof SCRATCHPAD_SCOPES)[number];

const DEFAULT_SCRATCHPAD_SCOPE: ScratchpadScope = "project";

export const SCRATCHPAD_SCOPE_LABELS: Readonly<Record<ScratchpadScope, string>> = {
  general: "General",
  project: "Project",
  thread: "Thread",
};

/** What the open thread contributes to the scratchpad file names. */
export interface ScratchpadOwner {
  readonly projectId: ProjectId | null;
  /** Null for a draft: its id can change when it is sent, which would orphan its notes. */
  readonly threadId: ThreadId | null;
}

/** Ids may carry `:` (draft-derived thread ids), which Windows refuses in a file name. */
function fileNameFor(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The file inside the server's scratchpad folder. Ids rather than titles: a renamed project or
 * thread must keep its notes. Null when the open thread has nothing for that scope.
 */
export function scratchpadRelativePath(
  scope: ScratchpadScope,
  owner: ScratchpadOwner,
): string | null {
  switch (scope) {
    case "general":
      return "general.md";
    case "project":
      return owner.projectId === null ? null : `projects/${fileNameFor(owner.projectId)}.md`;
    case "thread":
      return owner.threadId === null ? null : `threads/${fileNameFor(owner.threadId)}.md`;
  }
}

export function availableScratchpadScopes(owner: ScratchpadOwner): ReadonlyArray<ScratchpadScope> {
  return SCRATCHPAD_SCOPES.filter((scope) => scratchpadRelativePath(scope, owner) !== null);
}

export function cycleScratchpadScope(
  scope: ScratchpadScope,
  available: ReadonlyArray<ScratchpadScope>,
  direction: 1 | -1,
): ScratchpadScope {
  if (available.length === 0) return scope;
  const index = available.indexOf(scope);
  const from = index === -1 ? 0 : index;
  return available[(from + direction + available.length) % available.length] ?? scope;
}

/** The scope a newly opened scratchpad starts on: Project, or the first one the thread has. */
export function initialScratchpadScope(available: ReadonlyArray<ScratchpadScope>): ScratchpadScope {
  return available.includes(DEFAULT_SCRATCHPAD_SCOPE)
    ? DEFAULT_SCRATCHPAD_SCOPE
    : (available[0] ?? "general");
}

/** The first lines with text, for the preview card. Blank lines carry nothing at that size. */
export function scratchpadPreviewLines(contents: string, count = 3): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    lines.push(line);
    if (lines.length === count) break;
  }
  return lines;
}

export type ScratchpadKeyAction = "next-scope" | "previous-scope" | "close";

/**
 * What a key does to the scratchpad itself. Tab and Escape belong to it only while Neovim rests in
 * plain normal mode, or the editor lacks focus. In insert mode Tab indents and Escape leaves
 * insert mode, as in Neovim. Null leaves the key to the editor.
 */
export function scratchpadKeyAction(
  key: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly isComposing: boolean;
  },
  editor: { readonly hasTextFocus: boolean; readonly restsInNormalMode: boolean },
): ScratchpadKeyAction | null {
  if (key.ctrlKey || key.altKey || key.metaKey || key.isComposing) return null;
  if (key.key !== "Tab" && key.key !== "Escape") return null;
  if (editor.hasTextFocus && !editor.restsInNormalMode) return null;
  if (key.key === "Escape") return "close";
  return key.shiftKey ? "previous-scope" : "next-scope";
}
