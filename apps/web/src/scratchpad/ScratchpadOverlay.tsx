import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { NotebookPenIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { optimisticFileAtom } from "~/components/files/projectFilesQueryState";
import {
  MonacoFileSurface,
  type MonacoFileSurfaceControl,
} from "~/components/files/monaco/MonacoFileSurface";
import { useProjectEditorModels } from "~/components/files/monaco/useProjectEditorModels";
import { type DraftId } from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { SCRATCHPAD_EDITOR_THREAD_ID } from "./scratchpadEditorSession";
import {
  availableScratchpadScopes,
  cycleScratchpadScope,
  initialScratchpadScope,
  SCRATCHPAD_SCOPE_LABELS,
  scratchpadKeyAction,
  type ScratchpadOwner,
  type ScratchpadScope,
  scratchpadRelativePath,
} from "./scratchpadScopes";
import { useScratchpadStore } from "./scratchpadStore";

/** How long a close waits for keys and the save before unmounting anyway (a lost connection). */
const CLOSE_SETTLE_LIMIT_MS = 3000;

type LoadedFile =
  | { readonly relativePath: string; readonly status: "ready"; readonly contents: string }
  | { readonly relativePath: string; readonly status: "failed" | "too-large" };

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
  const phase = useScratchpadStore((state) => state.phase);
  const closeScratchpad = useScratchpadStore((state) => state.closeScratchpad);
  const finishClosing = useScratchpadStore((state) => state.finishClosing);
  const setScope = useScratchpadStore((state) => state.setScope);
  const storedScope = useScratchpadStore((state) => state.scope);
  const available = availableScratchpadScopes(owner);
  const scope =
    storedScope !== null && available.includes(storedScope)
      ? storedScope
      : initialScratchpadScope(available);
  const relativePath = scratchpadRelativePath(scope, owner) ?? "general.md";
  const controlRef = useRef<MonacoFileSurfaceControl | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());

  // Every open reads the host afresh: a cached read can be older than another device's edit, and
  // opening Neovim on it would save the old text back over the new.
  const readFresh = useAtomQueryRunner(projectEnvironment.readFile, {
    label: "scratchpad read",
    refresh: true,
    reportFailure: false,
  });
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const load = useEffectEvent((path: string, isCurrent: () => boolean) => {
    // Edits this client could not save yet are newer than the host's copy.
    const unsaved = appAtomRegistry.get(optimisticFileAtom(environmentId, root, path));
    const unsavedContents = unsaved?.saved === false ? unsaved.data?.contents : undefined;
    const read =
      unsavedContents === undefined
        ? readFresh({ environmentId, input: { cwd: root, relativePath: path, allowMissing: true } })
        : null;
    void Promise.resolve(read).then((result) => {
      if (!isCurrent()) return;
      if (result === null) {
        setLoaded({ relativePath: path, status: "ready", contents: unsavedContents ?? "" });
        return;
      }
      if (result._tag !== "Success") {
        setLoaded({ relativePath: path, status: "failed" });
        return;
      }
      const data = result.value;
      // The read stops at a megabyte; editing that prefix would save away the rest.
      if (data.exists !== false && data.truncated) {
        setLoaded({ relativePath: path, status: "too-large" });
        return;
      }
      setLoaded({
        relativePath: path,
        status: "ready",
        contents: data.exists === false ? "" : data.contents,
      });
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the scope's file from the host each time the scope opens
  useEffect(() => {
    let current = true;
    load(relativePath, () => current);
    return () => {
      current = false;
    };
  }, [relativePath]);

  // Held one read behind, as the file panel does: unmounting the editor while the next scope
  // reads would throw away its undo stack and Neovim buffer state.
  const [editorFile, setEditorFile] = useState<{
    readonly relativePath: string;
    readonly contents: string;
  } | null>(null);
  if (
    loaded?.status === "ready" &&
    loaded.relativePath === relativePath &&
    (editorFile?.relativePath !== loaded.relativePath || editorFile.contents !== loaded.contents)
  ) {
    setEditorFile({ relativePath: loaded.relativePath, contents: loaded.contents });
  }
  const showsRequestedFile =
    editorFile?.relativePath === relativePath &&
    loaded?.relativePath === relativePath &&
    loaded.status === "ready";
  const requestedFailure =
    loaded?.relativePath === relativePath && loaded.status !== "ready" ? loaded.status : null;

  // The editor takes the keyboard only while it shows the scope on the tab; until then the shell
  // holds it, so keys typed during a slow or failed read cannot edit the previous scope's note.
  const focusedFile = phase === "open" && showsRequestedFile ? relativePath : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus between the editor and the overlay shell as the requested file loads
  useEffect(() => {
    if (phase !== "open") return;
    if (focusedFile !== null) controlRef.current?.focus();
    else shellRef.current?.focus({ preventScroll: true });
  }, [phase, focusedFile]);

  // Where focus was when the overlay opened, returned as soon as a close starts, so keys typed
  // while the close settles reach the chat, not the hidden editor.
  const [previousFocus] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for Neovim's answers and the save before the closing overlay unmounts
  useEffect(() => {
    if (phase !== "closing") return;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    let cancelled = false;
    const settled = controlRef.current?.settle() ?? Promise.resolve();
    const limit = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_SETTLE_LIMIT_MS));
    void Promise.race([settled.catch(() => {}), limit]).then(() => {
      if (!cancelled) finishClosing();
    });
    return () => {
      cancelled = true;
    };
  }, [phase, finishClosing, previousFocus]);

  const switchScope = (next: ScratchpadScope) => {
    if (next !== scope) setScope(next);
  };

  // On the window in the capture phase: ahead of the file editor's document-level Escape
  // dismissal and of Monaco. Only while the keyboard is in the overlay (or nowhere).
  const handleWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const shell = shellRef.current;
    const active = document.activeElement;
    if (shell === null || !(active === document.body || shell.contains(active))) return;
    const control = controlRef.current;
    const action = scratchpadKeyAction(event, {
      hasTextFocus: control?.hasTextFocus() === true,
      restsInNormalMode: control?.restsInNormalMode() === true,
    });
    if (action === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action === "close") closeScratchpad();
    else switchScope(cycleScratchpadScope(scope, available, action === "next-scope" ? 1 : -1));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for Tab and Escape while the overlay is open
  useEffect(() => {
    if (phase !== "open") return;
    const onKeyDown = (event: KeyboardEvent) => handleWindowKeyDown(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [phase]);

  // One identity: the save session lists it as an effect dependency, and a new one on every
  // render released the save lease and wrote the file at once instead of after the debounce.
  const handlePendingChange = useStableCallback((path: string, pending: boolean) => {
    setPendingPaths((current) => {
      if (current.has(path) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(path);
      else next.delete(path);
      return next;
    });
  });

  const saving = pendingPaths.size > 0;

  return (
    <div
      data-scratchpad-overlay
      hidden={phase !== "open"}
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/30 backdrop-blur-xs"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeScratchpad();
      }}
    >
      <section
        ref={shellRef}
        aria-label="Scratchpad"
        tabIndex={-1}
        className="dropdown-glass flex h-[90%] w-[90%] min-w-0 flex-col overflow-hidden rounded-2xl shadow-2xl outline-none"
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
                onClick={() => switchScope(candidate)}
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
          <span className="ml-auto hidden min-w-0 truncate font-mono text-search-label text-muted-foreground/70 sm:inline">
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
              onPendingChange={handlePendingChange}
            />
          ) : null}
          {requestedFailure !== null ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/90 px-6 text-center text-sm text-destructive">
              {requestedFailure === "too-large"
                ? `${relativePath} is over a megabyte, too large for the scratchpad. Nothing was changed.`
                : `The host could not read ${relativePath}. Nothing was changed.`}
            </div>
          ) : !showsRequestedFile ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/90 text-xs text-muted-foreground">
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
