import { type EnvironmentId } from "@t3tools/contracts";
import { NotebookPenIcon } from "lucide-react";

import {
  initialScratchpadScope,
  availableScratchpadScopes,
  SCRATCHPAD_SCOPE_LABELS,
  type ScratchpadOwner,
  scratchpadPreviewLines,
  scratchpadRelativePath,
} from "./scratchpadScopes";
import { useScratchpadStore } from "./scratchpadStore";
import { useScratchpadFile, useScratchpadRoot } from "./useScratchpadFile";

interface ScratchpadPreviewCardProps {
  readonly environmentId: EnvironmentId;
  readonly owner: ScratchpadOwner;
}

/** The small card under the thread details: the default scope's first lines, a click to open. */
export function ScratchpadPreviewCard({ environmentId, owner }: ScratchpadPreviewCardProps) {
  const root = useScratchpadRoot(environmentId);
  if (root === undefined) return null;
  return <ScratchpadPreviewCardBody environmentId={environmentId} root={root} owner={owner} />;
}

function ScratchpadPreviewCardBody({
  environmentId,
  root,
  owner,
}: ScratchpadPreviewCardProps & { readonly root: string }) {
  const openScratchpad = useScratchpadStore((state) => state.openScratchpad);
  const scope = initialScratchpadScope(availableScratchpadScopes(owner));
  const relativePath = scratchpadRelativePath(scope, owner) ?? "general.md";
  const file = useScratchpadFile(environmentId, root, relativePath);
  const lines = file.status === "ready" ? scratchpadPreviewLines(file.contents) : [];

  return (
    <button
      type="button"
      data-scratchpad-preview
      onClick={() => openScratchpad(scope)}
      className="dropdown-glass flex w-full min-w-0 shrink-0 flex-col gap-1 rounded-2xl px-3 py-2 text-left transition-colors hover:bg-foreground/5"
    >
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <NotebookPenIcon className="size-3.5 shrink-0" aria-hidden />
        <span>Scratchpad</span>
        <span className="text-muted-foreground/60">{SCRATCHPAD_SCOPE_LABELS[scope]}</span>
      </span>
      {lines.length > 0 ? (
        <span className="flex min-w-0 flex-col font-mono text-search-label leading-4 text-foreground/80">
          {lines.map((line, index) => (
            // Lines repeat, and the list is rebuilt whole on every change.
            // oxlint-disable-next-line react/no-array-index-key
            <span key={index} className="truncate">
              {line}
            </span>
          ))}
        </span>
      ) : (
        <span className="text-search-label text-muted-foreground/60">
          {file.status === "failed" ? "Could not read the notes" : "Empty. Click to write."}
        </span>
      )}
    </button>
  );
}
