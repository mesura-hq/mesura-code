import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  AgentThreadSearchEnvironment,
  AgentThreadSearchMatch,
  AgentThreadSearchResult,
} from "@t3tools/client-runtime/state/agent-thread-search";
import {
  AGENT_SEARCH_HINT_TEXT,
  AGENT_SEARCH_NO_ENVIRONMENT_TEXT,
  AGENT_SEARCH_PROGRESS_TEXT,
  AGENT_SEARCH_UNEXPECTED_FAILURE_TEXT,
  describeAgentSearchCoverage,
  describeAgentSearchVerdict,
  resolveAgentSearchModelEnvironmentId,
} from "@t3tools/client-runtime/state/agent-thread-search-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { RotateCcwIcon, SparklesIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { readThreadShell, useProjects, useThreadShell } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { buildThreadRouteParams } from "~/threadRoutes";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import type { ProjectFaviconProject } from "../ProjectFavicon";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Kbd, KbdGroup } from "../ui/kbd";
import { agentSearchResultValue } from "./threadSearchPicker.logic";
import { AgentThreadSearchResultCard } from "./AgentThreadSearchResultCard";
import {
  useAgentThreadSearchSession,
  type AgentSearchActivity,
  type AgentSearchTurn,
} from "./AgentThreadSearchSession";

/** Handles the Escape that would otherwise leave the overlay; true when it did. */
export type ThreadSearchBackHandler = () => boolean;

type ComboboxKeyboardEvent = KeyboardEvent<HTMLInputElement> & {
  readonly preventBaseUIHandler?: () => void;
};

/** Stops both the browser default and the combobox's own handling of a key. */
function claimComboboxKey(event: ComboboxKeyboardEvent): void {
  event.preventDefault();
  event.preventBaseUIHandler?.();
}

/**
 * Switches the thread picker's mode on a plain Tab in its text field. Only the
 * field claims Tab: from the mode switch itself, Tab and Shift+Tab move focus
 * as usual, so keyboard and assistive-technology users keep a normal path.
 */
export function handleThreadSearchModeKey(
  event: ComboboxKeyboardEvent,
  toggleMode: () => void,
): boolean {
  if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }
  claimComboboxKey(event);
  toggleMode();
  return true;
}

/** The hint that tells the user Tab changes the search mode. */
export function ThreadSearchModeHint(props: { readonly target: string }) {
  return (
    <KbdGroup className="items-center gap-1.5">
      <Kbd>Tab</Kbd>
      <span>{props.target}</span>
    </KbdGroup>
  );
}

/**
 * Agent mode of the thread picker: the user describes a conversation, the
 * shared `agentThreadSearch` coordinator searches every connected environment,
 * and the ranked threads it verified come back as rows with a short reason.
 *
 * The session above the popup keeps the search running after the picker closes.
 * Reset cancels it and starts a fresh conversation.
 */
export function AgentThreadSearch(props: {
  readonly modeSwitch: ReactNode;
  readonly backHandlerRef: RefObject<ThreadSearchBackHandler | null>;
  readonly onExitAgentMode: () => void;
  readonly setOpen: (open: boolean) => void;
}) {
  const { backHandlerRef, onExitAgentMode, setOpen } = props;
  const navigate = useNavigate();
  const session = useAgentThreadSearchSession();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { unarchiveThread } = useThreadActions();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const { draft, setDraft, turns, progress, search, reset, setAgentVisible } = session;
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [archivedCandidate, setArchivedCandidate] = useState<AgentThreadSearchMatch | null>(null);
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  /** Unarchived, and waiting for its active shell before the route can open it. */
  const [awaitingShellOf, setAwaitingShellOf] = useState<AgentThreadSearchMatch | null>(null);

  useEffect(() => {
    setAgentVisible(true);
    return () => setAgentVisible(false);
  }, [setAgentVisible]);
  useEffect(() => {
    const onRestart = (event: globalThis.KeyboardEvent) => {
      if (
        archivedCandidate !== null ||
        isUnarchiving ||
        awaitingShellOf !== null ||
        event.isComposing ||
        event.key.toLowerCase() !== "r" ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      reset();
    };
    window.addEventListener("keydown", onRestart, true);
    return () => window.removeEventListener("keydown", onRestart, true);
  }, [reset, archivedCandidate, isUnarchiving, awaitingShellOf]);
  const searchEnvironments = useMemo<AgentThreadSearchEnvironment[]>(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
        })),
    [environments],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const modelEnvironmentId = resolveAgentSearchModelEnvironmentId(
    searchEnvironments,
    primaryEnvironmentId,
  );

  const closeArchivedConfirmation = () => {
    setArchivedCandidate(null);
    setUnarchiveError(null);
    setAwaitingShellOf(null);
  };

  // The thread route redirects away from a thread whose active shell the
  // client does not hold yet, and the unarchive command settles before the
  // shell stream delivers the thread again. Navigating on command success
  // would therefore bounce straight back to a draft; open on the shell instead.
  const awaitedShell = useThreadShell(
    awaitingShellOf === null
      ? null
      : scopeThreadRef(awaitingShellOf.environmentId, awaitingShellOf.threadId),
  );
  const awaitedEnvironmentConnected =
    awaitingShellOf === null ||
    searchEnvironments.some(
      (environment) => environment.environmentId === awaitingShellOf.environmentId,
    );

  useEffect(() => {
    const handleBack: ThreadSearchBackHandler = () => {
      if (archivedCandidate !== null) {
        if (!isUnarchiving) closeArchivedConfirmation();
        return true;
      }
      onExitAgentMode();
      return true;
    };
    backHandlerRef.current = handleBack;
    return () => {
      if (backHandlerRef.current === handleBack) backHandlerRef.current = null;
    };
  });

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || modelEnvironmentId === null) return;
    setHighlightedItemValue(null);
    session.submit(text, searchEnvironments, modelEnvironmentId);
  };

  const openThread = (match: AgentThreadSearchMatch) => {
    setOpen(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(match.environmentId, match.threadId)),
    });
  };

  const openedAwaitedRef = useRef<AgentThreadSearchMatch | null>(null);
  useEffect(() => {
    if (awaitingShellOf === null || awaitedShell === null || awaitedShell.archivedAt !== null) {
      return;
    }
    // Once per unarchive: re-renders before the overlay closes must not
    // navigate again.
    if (openedAwaitedRef.current === awaitingShellOf) return;
    openedAwaitedRef.current = awaitingShellOf;
    openThread(awaitingShellOf);
  }, [awaitingShellOf, awaitedShell, openThread]);

  const confirmUnarchive = async () => {
    if (archivedCandidate === null || isUnarchiving) return;
    setIsUnarchiving(true);
    setUnarchiveError(null);
    const result = await unarchiveThread(
      scopeThreadRef(archivedCandidate.environmentId, archivedCandidate.threadId),
    );
    setIsUnarchiving(false);
    if (result._tag === "Success") {
      setAwaitingShellOf(archivedCandidate);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setUnarchiveError(
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "The thread could not be unarchived.",
    );
  };

  const settled = settledResult(search);
  const items =
    settled?.status === "matches"
      ? settled.matches.map((match) =>
          agentResultItem(
            match,
            projectByKey.get(`${match.environmentId}:${match.projectId}`) ?? null,
            async () => {
              const thread = readThreadShell(scopeThreadRef(match.environmentId, match.threadId));
              if ((thread === null ? match.archivedAt : thread.archivedAt) !== null) {
                setArchivedCandidate(match);
                return;
              }
              openThread(match);
            },
          ),
        )
      : [];

  return (
    <>
      <CommandPaletteContent
        key={session.resetCount}
        aria-label="Search threads with an agent"
        autoHighlight="always"
        escapeLabel="Exact words"
        footerActionLabel={
          draft.trim().length > 0 ? "Search" : items.length > 0 ? "Open thread" : undefined
        }
        footerTrailing={<ThreadSearchModeHint target="Exact words" />}
        inputAccessory={props.modeSwitch}
        inputProps={{
          className: "pe-40",
          placeholder:
            turns.length === 0
              ? "Describe the thread you remember…"
              : "Refine the description, or pick a thread…",
          startAddon: <SparklesIcon className="translate-x-0.5 text-icon-muted" />,
          onKeyDown: (event: ComboboxKeyboardEvent) => {
            if (handleThreadSearchModeKey(event, onExitAgentMode)) return;
            // New words are a new search. With the field empty, Enter falls
            // through to the combobox and opens the highlighted thread.
            if (event.key === "Enter" && draft.trim().length > 0) {
              claimComboboxKey(event);
              submit();
            }
          },
        }}
        mode="none"
        panelClassName="max-h-[min(34rem,76vh)]"
        testId="thread-search-picker"
        value={draft}
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={setDraft}
      >
        <AgentConversation
          turns={turns}
          progress={progress}
          search={search}
          settled={settled}
          canSearch={modelEnvironmentId !== null}
          onReset={reset}
        />
        {items.length > 0 ? (
          <CommandPaletteResults
            groups={[{ value: "agent-thread-search", label: "Likely threads", items }]}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind === "action") void item.run();
            }}
          />
        ) : null}
      </CommandPaletteContent>
      <AlertDialog
        open={archivedCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !isUnarchiving) closeArchivedConfirmation();
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Unarchive this thread?</AlertDialogTitle>
            <AlertDialogDescription>
              “{archivedCandidate?.threadTitle}” is archived. Unarchive it to open it in{" "}
              {archivedCandidate?.projectTitle} on {archivedCandidate?.environmentLabel}.
            </AlertDialogDescription>
            {unarchiveError !== null ? (
              <p className="text-destructive-foreground text-sm" role="alert">
                Could not unarchive: {unarchiveError}
              </p>
            ) : awaitingShellOf !== null && !awaitedEnvironmentConnected ? (
              <p className="text-destructive-foreground text-sm" role="alert">
                Unarchived, but {awaitingShellOf.environmentLabel} disconnected before the thread
                loaded. It opens when {awaitingShellOf.environmentLabel} reconnects.
              </p>
            ) : awaitingShellOf !== null ? (
              <p className="text-muted-foreground text-sm" role="status">
                Unarchived. Opening the thread…
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button disabled={isUnarchiving} variant="outline" onClick={closeArchivedConfirmation}>
              Cancel
            </Button>
            <Button
              disabled={isUnarchiving || awaitingShellOf !== null}
              onClick={() => void confirmUnarchive()}
            >
              {isUnarchiving
                ? "Unarchiving…"
                : awaitingShellOf !== null
                  ? "Opening…"
                  : "Unarchive and open"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The coordinator's verdict, once a search has settled and none is running. */
function settledResult(
  search: AsyncResult.AsyncResult<AgentThreadSearchResult, unknown>,
): AgentThreadSearchResult | null {
  if (search.waiting || !AsyncResult.isSuccess(search)) return null;
  return search.value;
}

function agentResultItem(
  match: AgentThreadSearchMatch,
  project: ProjectFaviconProject | null,
  run: () => Promise<void>,
): CommandPaletteActionItem {
  return {
    kind: "action",
    value: agentSearchResultValue(match),
    searchTerms: [],
    title: match.threadTitle,
    icon: null,
    rowContent: <AgentThreadSearchResultCard match={match} project={project} />,
    run,
  };
}

/**
 * What the user asked, and where the search stands: a hint before the first
 * description, progress while a search runs, and the verdict's caveats after.
 */
function AgentConversation(props: {
  readonly turns: ReadonlyArray<AgentSearchTurn>;
  readonly progress: ReadonlyArray<AgentSearchActivity>;
  readonly search: AsyncResult.AsyncResult<AgentThreadSearchResult, unknown>;
  readonly settled: AgentThreadSearchResult | null;
  readonly canSearch: boolean;
  readonly onReset: () => void;
}) {
  const { turns, progress, search, settled } = props;
  if (!props.canSearch) {
    return <AgentNotice role="alert">{AGENT_SEARCH_NO_ENVIRONMENT_TEXT}</AgentNotice>;
  }
  if (turns.length === 0) {
    return <AgentNotice>{AGENT_SEARCH_HINT_TEXT}</AgentNotice>;
  }

  const coverageNotes = settled === null ? [] : describeAgentSearchCoverage(settled.coverage);
  const verdict = settled === null ? null : describeAgentSearchVerdict(settled);
  const hasMatches = settled?.status === "matches";
  return (
    <div className="flex flex-col gap-3 px-3 pt-3 pb-2 text-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-2">
        <span className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
          Search conversation
        </span>
        <Button
          aria-label="Start a new agent search"
          className="h-6 gap-1.5 px-2 text-xs"
          variant="ghost"
          onClick={props.onReset}
        >
          <RotateCcwIcon className="size-3" />
          New search <Kbd className="ms-1">Alt R</Kbd>
        </Button>
      </div>
      <ol className="flex flex-col gap-2" aria-label="Your descriptions">
        {(hasMatches ? turns.slice(-1) : turns).map((turn) => (
          <li
            className={
              hasMatches
                ? "max-w-full self-end rounded-lg border border-border/60 bg-muted/70 px-3 py-1.5 text-foreground line-clamp-2"
                : "max-w-[90%] self-end rounded-lg border border-border/60 bg-muted/70 px-3 py-2 text-foreground"
            }
            key={turn.id}
          >
            {turn.text}
          </li>
        ))}
      </ol>
      {search.waiting && progress.length > 0 ? (
        <div className="border-s border-border/70 ps-3 text-xs text-muted-foreground">
          {progress.length > 5 ? <p>{progress.length - 5} earlier steps</p> : null}
          <ol className="flex flex-col gap-1.5" aria-label="Search activity">
            {progress.slice(-5).map((step) => (
              <li key={step.id}>{step.text}</li>
            ))}
          </ol>
        </div>
      ) : progress.length > 0 || (hasMatches && (coverageNotes.length > 0 || turns.length > 1)) ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Search details{progress.length > 0 ? ` · ${progress.length} steps` : ""}
            {hasMatches && coverageNotes.length > 0 ? " · Partial" : ""}
          </summary>
          {hasMatches && turns.length > 1 ? (
            <ol className="mt-2 flex flex-col gap-1.5" aria-label="Earlier descriptions">
              {turns.slice(0, -1).map((turn) => (
                <li key={turn.id}>{turn.text}</li>
              ))}
            </ol>
          ) : null}
          {hasMatches
            ? coverageNotes.map((note) => (
                <p className="mt-2" key={note}>
                  {note}
                </p>
              ))
            : null}
          {progress.length > 0 ? (
            <ol
              className="mt-2 flex flex-col gap-1.5 border-s border-border/70 ps-3"
              aria-label="Search activity"
            >
              {progress.map((step) => (
                <li key={step.id}>{step.text}</li>
              ))}
            </ol>
          ) : null}
        </details>
      ) : null}
      {search.waiting ? (
        <p className="text-xs text-muted-foreground" role="status">
          {progress.length === 0 ? `${AGENT_SEARCH_PROGRESS_TEXT} ` : ""}You can close this popup;
          the search keeps running.
        </p>
      ) : AsyncResult.isFailure(search) ? (
        <p className="text-destructive-foreground text-xs" role="alert">
          {AGENT_SEARCH_UNEXPECTED_FAILURE_TEXT}
        </p>
      ) : verdict !== null ? (
        <p
          className={verdict.tone === "alert" ? "text-destructive-foreground text-xs" : "text-xs"}
          role={verdict.tone}
        >
          {verdict.text}
        </p>
      ) : null}
      {!hasMatches
        ? coverageNotes.map((note) => (
            <p className="text-muted-foreground text-xs" key={note}>
              {note}
            </p>
          ))
        : null}
    </div>
  );
}

function AgentNotice(props: { readonly children: ReactNode; readonly role?: "alert" }) {
  return (
    <p className="px-3 py-6 text-center text-muted-foreground text-sm" role={props.role}>
      {props.children}
    </p>
  );
}
