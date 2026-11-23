import { type EnvironmentId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { NotebookPenIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { FileEditorRetention } from "~/components/files/fileEditorRetention";
import { optimisticFileAtom } from "~/components/files/projectFilesQueryState";
import {
  MonacoFileSurface,
  type MonacoFileSurfaceControl,
} from "~/components/files/monaco/MonacoFileSurface";
import { relativePathFromModelKey } from "~/components/files/monaco/monacoFileModels";
import { createMonacoFileModels } from "~/components/files/monaco/monacoFileModelStore";
import { type DraftId } from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { saveAbandonedScratchpadNote, settledSaves } from "./scratchpadDetachedSave";
import { retireScratchpadSession, scratchpadEditorThreadId } from "./scratchpadEditorSession";
import { registerScratchpadFocus } from "./scratchpadFocus";
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

/**
 * A backstop only: the key lane gives keys up after its own outage limit (a minute), and the close
 * normally settles in well under a second. Until it settles, a reopen waits and the preview card
 * says "Saving…", so pending keys can never replay into another scope's buffer.
 */
const CLOSE_SETTLE_BACKSTOP_MS = 75_000;

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
  owner: currentOwner,
  composerDraftTarget,
}: ScratchpadOverlayProps) {
  // The thread it was opened from: navigating elsewhere closes the overlay (below), which
  // settles this note, rather than swapping the note under the editor or writing to the old one.
  const [owner] = useState(currentOwner);
  // Models of this open only, and only the scope on screen (limit 1): a kept model holds the text
  // it last had, and the editor's echo guard could take it over the fresh read of a scope that
  // another device saved meanwhile. Every scope change and every open start from the host.
  const [{ models, retention }] = useState(() => {
    const created = { models: createMonacoFileModels(1), retention: new FileEditorRetention() };
    created.models.onEvict((key) => created.retention.forget(relativePathFromModelKey(key)));
    return created;
  });
  // After the editor's own layout-effect teardown, which hands its model back first.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes this open's Monaco models on unmount
  useEffect(
    () => () => {
      models.disposeAll();
      retention.clear();
    },
    [models, retention],
  );
  // This tab's own Neovim session, claimed before the editor mounts (see the session module).
  const [editorThreadId, setEditorThreadId] = useState<ThreadId | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for this tab's claim on its Neovim session key
  useEffect(() => {
    let live = true;
    void scratchpadEditorThreadId().then((threadId) => {
      if (live) setEditorThreadId(threadId);
    });
    return () => {
      live = false;
    };
  }, []);
  const { resolvedTheme } = useTheme();
  const phase = useScratchpadStore((state) => state.phase);
  const closeScratchpad = useScratchpadStore((state) => state.closeScratchpad);
  const finishClosing = useScratchpadStore((state) => state.finishClosing);
  const ownerMoved =
    currentOwner.projectId !== owner.projectId || currentOwner.threadId !== owner.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the overlay when the chat navigates to another thread
  useEffect(() => {
    if (ownerMoved && phase === "open") closeScratchpad();
  }, [ownerMoved, phase, closeScratchpad]);
  const setScope = useScratchpadStore((state) => state.setScope);
  const storedScope = useScratchpadStore((state) => state.scope);
  const available = availableScratchpadScopes(owner);
  const scope =
    storedScope !== null && available.includes(storedScope)
      ? storedScope
      : initialScratchpadScope(available);
  const relativePath = scratchpadRelativePath(scope, owner) ?? "general.md";
  const controlRef = useRef<MonacoFileSurfaceControl | null>(null);
  /** Where a scope change still settling is headed, and the settle itself. */
  const switchTargetRef = useRef<ScratchpadScope | null>(null);
  const switchingRef = useRef<Promise<void> | null>(null);
  /** Shown state of the same: the outgoing editor is inert while it settles. */
  const [switching, setSwitching] = useState(false);
  /** Bumped when a switch ends back on the scope it left, to refocus that editor. */
  const [refocusAfterSwitch, setRefocusAfterSwitch] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refocuses the editor once the commit that lifts inert has happened
  useEffect(() => {
    if (refocusAfterSwitch > 0) controlRef.current?.focus();
  }, [refocusAfterSwitch]);
  /** False once unmounted, so a settle finishing late never acts on a replacement overlay. */
  const aliveRef = useRef(true);
  /** True once this overlay's own close finished; an unmount without it hands the note over. */
  const closedRef = useRef(false);
  /** The note Neovim holds now, for that hand-over (read in the unmount cleanup). */
  const openNoteRef = useRef<Parameters<typeof saveAbandonedScratchpadNote>[0] | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the overlay unmounted for settles that finish after it
  useEffect(() => {
    // Set on every mount: development runs effects twice, and a false left by the first cleanup
    // stranded every scope change half-way (editor inert, scope unchanged).
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // Unmounted before its close finished (a keyed chat view replaced outright): the note is
      // saved from the tab's Neovim session, which still holds every key it took.
      const open = openNoteRef.current;
      if (!closedRef.current && open !== null) saveAbandonedScratchpadNote(open);
    };
  }, []);
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
    // After any note an earlier overlay left behind is saved, so this read includes it.
    void settledSaves()
      .then(() =>
        unsavedContents === undefined
          ? readFresh({
              environmentId,
              input: { cwd: root, relativePath: path, allowMissing: true },
            })
          : null,
      )
      .then((result) => {
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- latest-value ref read by the unmount cleanup that hands an unsettled note over
  useLayoutEffect(() => {
    openNoteRef.current =
      editorThreadId !== null && editorFile !== null
        ? {
            environmentId,
            sessionThreadId: editorThreadId,
            cwd: root,
            relativePath: editorFile.relativePath,
          }
        : null;
  }, [editorThreadId, editorFile, environmentId, root]);
  const showsRequestedFile =
    editorThreadId !== null &&
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
  const pendingSwitch = useEffectEvent(() => switchingRef.current);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for Neovim's answers and the save before the closing overlay unmounts
  useEffect(() => {
    if (phase !== "closing") return;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const abandon = new AbortController();
    let unmounted = false;
    // A scope change still settling owns the outgoing buffer; the close settles after it.
    const settled = (pendingSwitch() ?? Promise.resolve()).then(
      () => controlRef.current?.settle(abandon.signal) ?? Promise.resolve(),
    );
    let backstopTimer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<void>((resolve) => {
      backstopTimer = setTimeout(() => {
        abandon.abort();
        // Keys may still be queued for this session; the next open must not receive them.
        retireScratchpadSession();
        resolve();
      }, CLOSE_SETTLE_BACKSTOP_MS);
    });
    void Promise.race([settled.catch(() => {}), backstop]).then(() => {
      clearTimeout(backstopTimer);
      if (unmounted) return;
      closedRef.current = true;
      finishClosing();
    });
    return () => {
      unmounted = true;
      clearTimeout(backstopTimer);
      abandon.abort();
    };
  }, [phase, finishClosing, previousFocus]);

  // A scope change first settles the outgoing buffer: switching the model before Neovim's last
  // text arrives would drop that text from the save. Tabs pressed meanwhile retarget the switch.
  const switchScope = (next: ScratchpadScope) => {
    if (switchTargetRef.current === null && next === scope) {
      if (showsRequestedFile) controlRef.current?.focus();
      return;
    }
    const inFlight = switchTargetRef.current !== null;
    switchTargetRef.current = next;
    if (inFlight) return;
    // The shell holds the keyboard and the outgoing editor is inert while it settles, so no key
    // or click joins that buffer late.
    shellRef.current?.focus({ preventScroll: true });
    setSwitching(true);
    const settled = controlRef.current?.settle() ?? Promise.resolve();
    switchingRef.current = settled
      .catch(() => {})
      .then(() => {
        if (!aliveRef.current) return;
        const target = switchTargetRef.current;
        switchTargetRef.current = null;
        switchingRef.current = null;
        setSwitching(false);
        // A close that started meanwhile ends this open; it keeps the scope it settled.
        if (target === null || useScratchpadStore.getState().phase !== "open") return;
        // After the commit that lifts `inert`: focusing an inert editor is refused.
        if (target === scope) setRefocusAfterSwitch((count) => count + 1);
        else setScope(target);
      });
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
    else {
      const from = switchTargetRef.current ?? scope;
      switchScope(cycleScratchpadScope(from, available, action === "next-scope" ? 1 : -1));
    }
  });
  const focusOverlay = useEffectEvent(() => {
    if (focusedFile !== null && !switching) controlRef.current?.focus();
    else shellRef.current?.focus({ preventScroll: true });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lets the command palette hand the keyboard back to the open overlay
  useLayoutEffect(() => {
    if (phase !== "open") return;
    return registerScratchpadFocus(() => focusOverlay());
  }, [phase]);

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
      {/* `role="application"` keeps the chat's type-to-focus off this shell, and the marker keeps
          the app's Vim keys off it, while a read is pending and the shell holds the keyboard. */}
      <section
        ref={shellRef}
        role="application"
        aria-label="Scratchpad"
        data-mesura-owns-keys
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
        <div className="relative flex min-h-0 flex-1 flex-col" inert={switching}>
          {editorFile !== null && editorThreadId !== null ? (
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
              threadRef={{ environmentId, threadId: editorThreadId }}
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
