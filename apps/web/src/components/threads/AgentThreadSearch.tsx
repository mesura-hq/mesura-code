import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
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
  composeAgentSearchDescription,
  describeAgentSearchCoverage,
  describeAgentSearchVerdict,
  resolveAgentSearchModelEnvironmentId,
} from "@t3tools/client-runtime/state/agent-thread-search-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { THREAD_SEARCH_DESCRIPTION_MAX_LENGTH } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { ArchiveIcon, MessageSquareIcon, SparklesIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { useThreadShell } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { orchestrationEnvironment } from "~/state/orchestration";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { buildThreadRouteParams } from "~/threadRoutes";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
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

/** The one agent search this popup owns; mobile surfaces use their own key. */
const AGENT_THREAD_SEARCH_SURFACE = "web-thread-search-picker";

/** One description the user sent, numbered so the list keeps its identity. */
interface AgentSearchTurn {
  readonly id: number;
  readonly text: string;
}

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
 * The popup conversation lives only in this component. Nothing is persisted and
 * no coding-agent thread is created; unmounting — closing the picker, or going
 * back to exact words — resets the atom, which interrupts the search and every
 * read it has in flight.
 */
export function AgentThreadSearch(props: {
  readonly modeSwitch: ReactNode;
  readonly backHandlerRef: RefObject<ThreadSearchBackHandler | null>;
  readonly onExitAgentMode: () => void;
  readonly setOpen: (open: boolean) => void;
}) {
  const { backHandlerRef, onExitAgentMode, setOpen } = props;
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { unarchiveThread } = useThreadActions();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const searchAtom = orchestrationEnvironment.agentThreadSearch(AGENT_THREAD_SEARCH_SURFACE);
  const search = useAtomValue(searchAtom);
  const runSearch = useAtomSet(searchAtom);

  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<ReadonlyArray<AgentSearchTurn>>([]);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [archivedCandidate, setArchivedCandidate] = useState<AgentThreadSearchMatch | null>(null);
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  /** Unarchived, and waiting for its active shell before the route can open it. */
  const [awaitingShellOf, setAwaitingShellOf] = useState<AgentThreadSearchMatch | null>(null);

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
  const modelEnvironmentId = resolveAgentSearchModelEnvironmentId(
    searchEnvironments,
    primaryEnvironmentId,
  );

  // Explicit rather than left to atom disposal: leaving agent mode must stop
  // the search even if the registry keeps an idle atom alive.
  useEffect(() => () => registry.set(searchAtom, Atom.Reset), [registry, searchAtom]);

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
    // A retry of the same words reruns the search without repeating the turn.
    const lastTurn = turns.at(-1);
    const nextTurns =
      lastTurn?.text === text ? turns : [...turns, { id: (lastTurn?.id ?? 0) + 1, text }];
    setTurns(nextTurns);
    setDraft("");
    setHighlightedItemValue(null);
    runSearch({
      description: composeAgentSearchDescription(
        nextTurns.map((turn) => turn.text),
        THREAD_SEARCH_DESCRIPTION_MAX_LENGTH,
      ),
      environments: searchEnvironments,
      modelEnvironmentId,
    });
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
          agentResultItem(match, async () => {
            if (match.archivedAt !== null) {
              setArchivedCandidate(match);
              return;
            }
            openThread(match);
          }),
        )
      : [];

  return (
    <>
      <CommandPaletteContent
        aria-label="Search threads with an agent"
        autoHighlight="always"
        escapeLabel="Exact words"
        footerActionLabel={draft.trim().length > 0 ? "Search" : "Open thread"}
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
          search={search}
          settled={settled}
          canSearch={modelEnvironmentId !== null}
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
  run: () => Promise<void>,
): CommandPaletteActionItem {
  const isArchived = match.archivedAt !== null;
  return {
    kind: "action",
    value: agentSearchResultValue(match),
    searchTerms: [],
    title: match.threadTitle,
    icon: isArchived ? (
      <ArchiveIcon className={ITEM_ICON_CLASS} />
    ) : (
      <MessageSquareIcon className={ITEM_ICON_CLASS} />
    ),
    description: (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground/80">{match.reason}</span>
        <span className="truncate">
          {match.projectTitle} · {match.environmentLabel}
        </span>
      </span>
    ),
    titleTrailingContent: isArchived ? (
      <span className="shrink-0 rounded-sm border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Archived
      </span>
    ) : undefined,
    run,
  };
}

/**
 * What the user asked, and where the search stands: a hint before the first
 * description, progress while a search runs, and the verdict's caveats after.
 */
function AgentConversation(props: {
  readonly turns: ReadonlyArray<AgentSearchTurn>;
  readonly search: AsyncResult.AsyncResult<AgentThreadSearchResult, unknown>;
  readonly settled: AgentThreadSearchResult | null;
  readonly canSearch: boolean;
}) {
  const { turns, search, settled } = props;
  if (!props.canSearch) {
    return <AgentNotice role="alert">{AGENT_SEARCH_NO_ENVIRONMENT_TEXT}</AgentNotice>;
  }
  if (turns.length === 0) {
    return <AgentNotice>{AGENT_SEARCH_HINT_TEXT}</AgentNotice>;
  }

  const coverageNotes = settled === null ? [] : describeAgentSearchCoverage(settled.coverage);
  const verdict = settled === null ? null : describeAgentSearchVerdict(settled);
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-2 pb-1 text-sm">
      <ol className="flex flex-col gap-1" aria-label="Your descriptions">
        {turns.map((turn) => (
          <li className="border-s-2 border-border ps-2 text-muted-foreground" key={turn.id}>
            {turn.text}
          </li>
        ))}
      </ol>
      {search.waiting ? (
        <p className="text-muted-foreground text-xs" role="status">
          {AGENT_SEARCH_PROGRESS_TEXT}
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
      {coverageNotes.map((note) => (
        <p className="text-muted-foreground text-xs" key={note}>
          {note}
        </p>
      ))}
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
