import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { NotebookPenIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { type DraftId } from "~/composerDraftStore";
import {
  MonacoFileSurface,
  type MonacoFileSurfaceControl,
} from "~/components/files/monaco/MonacoFileSurface";
import { useProjectEditorModels } from "~/components/files/monaco/useProjectEditorModels";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

import {
  availableScratchpadScopes,
  cycleScratchpadScope,
  scratchpadKeyAction,
  initialScratchpadScope,
  SCRATCHPAD_SCOPE_LABELS,
  type ScratchpadOwner,
  type ScratchpadScope,
  scratchpadRelativePath,
} from "./scratchpadScopes";
import { useScratchpadStore } from "./scratchpadStore";
import { useScratchpadFile } from "./useScratchpadFile";

/**
 * One Neovim session for every scratchpad on a host, apart from each thread's own: a session is
 * keyed by thread and holds one working directory, so sharing the thread's would replace the file
 * panel's Neovim. Buffers stay open across scope switches, with their undo history and cursor.
 */
const SCRATCHPAD_EDITOR_THREAD_ID = ThreadId.make("mesura-scratchpad");

interface ScratchpadOverlayProps {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly owner: ScratchpadOwner;
  /** Where the editor's inline line comments go: the open thread's composer. */
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}

/** Keyed by the caller on environment and root: the editor models are acquired once per pair. */
export function ScratchpadOverlay({
  environmentId,
  root,
  owner,
  composerDraftTarget,
}: ScratchpadOverlayProps) {
  const { models, retention } = useProjectEditorModels(environmentId, root);
  const { resolvedTheme } = useTheme();
  const closeScratchpad = useScratchpadStore((state) => state.closeScratchpad);
  const setScope = useScratchpadStore((state) => state.setScope);
  const storedScope = useScratchpadStore((state) => state.scope);
  const available = availableScratchpadScopes(owner);
  const scope =
    storedScope !== null && available.includes(storedScope)
      ? storedScope
      : initialScratchpadScope(available);
  const relativePath = scratchpadRelativePath(scope, owner) ?? "general.md";
  const file = useScratchpadFile(environmentId, root, relativePath);
  const controlRef = useRef<MonacoFileSurfaceControl | null>(null);
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());

  // Held one read behind, as the file panel does: unmounting the editor while the next scope
  // reads would throw away its undo stack and Neovim buffer state.
  const [editorFile, setEditorFile] = useState<{
    readonly relativePath: string;
    readonly contents: string;
  } | null>(null);
  if (
    file.status === "ready" &&
    (editorFile?.relativePath !== relativePath || editorFile.contents !== file.contents)
  ) {
    setEditorFile({ relativePath, contents: file.contents });
  }
  const showsRequestedFile = editorFile?.relativePath === relativePath;

  const focusedFile = showsRequestedFile ? relativePath : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus into the editor when it mounts or the scope changes
  useEffect(() => {
    if (focusedFile !== null) controlRef.current?.focus();
  }, [focusedFile]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- returns DOM focus to where it was before the overlay opened
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const switchScope = (next: ScratchpadScope) => {
    if (next !== scope) setScope(next);
  };

  // Capture phase, ahead of Monaco's own listener. With the editor focused, the surface's own
  // document-level dismissal takes Escape first and reports it through `onDismiss`.
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const control = controlRef.current;
    const action = scratchpadKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing,
      },
      {
        hasTextFocus: control?.hasTextFocus() === true,
        restsInNormalMode: control?.restsInNormalMode() === true,
      },
    );
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "close") closeScratchpad();
    else switchScope(cycleScratchpadScope(scope, available, action === "next-scope" ? 1 : -1));
  };

  const saving = pendingPaths.size > 0;

  return (
    <div
      data-scratchpad-overlay
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/30 backdrop-blur-xs"
      onKeyDownCapture={handleKeyDownCapture}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeScratchpad();
      }}
    >
      <section
        aria-label="Scratchpad"
        className="dropdown-glass flex h-[90%] w-[90%] min-w-0 flex-col overflow-hidden rounded-2xl shadow-2xl"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
          <NotebookPenIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div role="tablist" aria-label="Scratchpad scope" className="flex shrink-0 gap-1">
            {available.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={candidate === scope}
                tabIndex={-1}
                onClick={() => {
                  switchScope(candidate);
                  controlRef.current?.focus();
                }}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs transition-colors",
                  candidate === scope
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {SCRATCHPAD_SCOPE_LABELS[candidate]}
              </button>
            ))}
          </div>
          <span className="ml-auto hidden min-w-0 truncate font-mono sm:inline text-search-label text-muted-foreground/70">
            {relativePath}
          </span>
          <span
            className="ml-auto shrink-0 text-search-label text-muted-foreground/70 sm:ml-0"
            aria-live="polite"
          >
            {saving ? "Saving…" : "Saved"}
          </span>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {editorFile !== null ? (
            <MonacoFileSurface
              environmentId={environmentId}
              cwd={root}
              relativePath={editorFile.relativePath}
              contents={editorFile.contents}
              resolvedTheme={resolvedTheme}
              wordWrap
              revealLine={null}
              revealRequestId={0}
              retention={retention}
              models={models}
              composerDraftTarget={composerDraftTarget}
              threadRef={{ environmentId, threadId: SCRATCHPAD_EDITOR_THREAD_ID }}
              // Always Neovim, whatever the file panel's modal editing setting says: the scratchpad
              // is a Neovim buffer by design.
              modalEditing
              startInNormalMode
              controlRef={controlRef}
              onDismiss={closeScratchpad}
              onPendingChange={(path, pending) =>
                setPendingPaths((current) => {
                  if (current.has(path) === pending) return current;
                  const next = new Set(current);
                  if (pending) next.add(path);
                  else next.delete(path);
                  return next;
                })
              }
            />
          ) : null}
          {file.status === "failed" ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/90 text-sm text-destructive">
              The host could not read {relativePath}. Nothing was changed.
            </div>
          ) : !showsRequestedFile ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/40 text-xs text-muted-foreground">
              Loading…
            </div>
          ) : null}
        </div>
        <footer className="flex shrink-0 gap-3 border-t border-border/50 px-3 py-1 text-search-label text-muted-foreground/70">
          <span>Tab / Shift+Tab: scope</span>
          <span>Esc: close</span>
          <span>Saved to disk as you type</span>
        </footer>
      </section>
    </div>
  );
}
