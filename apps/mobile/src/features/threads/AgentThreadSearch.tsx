import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
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
import { THREAD_SEARCH_DESCRIPTION_MAX_LENGTH } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useWorkspaceState } from "../../state/workspace";
import { useUnarchiveThreadRef } from "../home/useThreadListActions";

export type ThreadSearchMode = "exact" | "agent";

const AGENT_SEARCH_ICON = { ios: "sparkles", android: "auto_awesome" } as const;

/**
 * The control that enters agent mode, placed beside a surface's exact-word
 * search field. Agent mode never replaces that field; leaving it returns there.
 */
export function AgentThreadSearchModeButton(props: { readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Search with an agent"
      accessibilityRole="button"
      hitSlop={10}
      onPress={props.onPress}
    >
      <SymbolView
        name={AGENT_SEARCH_ICON}
        size={17}
        tintColorClassName={"accent-foreground-muted"}
        type="monochrome"
      />
    </Pressable>
  );
}

/** One description the user sent, numbered so the list keeps its identity. */
interface AgentSearchTurn {
  readonly id: number;
  readonly text: string;
}

/**
 * Agent mode of a mobile thread search surface: the user describes a
 * conversation, the shared `agentThreadSearch` coordinator searches every
 * connected environment, and the ranked threads it verified come back as rows
 * with a short reason and their project and environment.
 *
 * `surface` keys the search atom, so the home list and the navigation sidebar
 * each own one search. Nothing is persisted; unmounting — leaving agent mode or
 * the surface — resets the atom, which interrupts the search and its reads.
 */
export function AgentThreadSearch(props: {
  readonly surface: string;
  readonly onExit: () => void;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { onOpenThread } = props;
  const registry = useContext(RegistryContext);
  const { environments } = useWorkspaceState();
  const unarchiveThread = useUnarchiveThreadRef();
  const searchAtom = orchestrationEnvironment.agentThreadSearch(props.surface);
  const search = useAtomValue(searchAtom);
  const runSearch = useAtomSet(searchAtom);

  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<ReadonlyArray<AgentSearchTurn>>([]);
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  /**
   * The result to open once the client holds its active shell. Each press is a
   * new selection, so choosing the same result again opens it again.
   */
  const [selection, setSelection] = useState<{ readonly match: AgentThreadSearchMatch } | null>(
    null,
  );
  const opening = selection?.match ?? null;

  const searchEnvironments = useMemo<AgentThreadSearchEnvironment[]>(
    () =>
      Arr.sort(
        environments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => ({
            environmentId: environment.environmentId,
            label: environment.environmentLabel,
          })),
        Order.mapInput(Order.String, (environment: AgentThreadSearchEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [environments],
  );
  // Mobile has no primary environment, so the first connected one reasons.
  const modelEnvironmentId = resolveAgentSearchModelEnvironmentId(searchEnvironments, null);

  // Explicit rather than left to atom disposal: leaving agent mode must stop
  // the search even if the registry keeps an idle atom alive.
  useEffect(() => () => registry.set(searchAtom, Atom.Reset), [registry, searchAtom]);

  // An unarchived thread reaches the client through the shell stream after the
  // command settles, and the thread route needs that shell. Open on the shell,
  // never on command success; an active result opens as soon as it is held.
  const openingRef = useMemo(
    () => (opening === null ? null : scopeThreadRef(opening.environmentId, opening.threadId)),
    [opening],
  );
  const openingShell = useThreadShell(openingRef);
  const isAwaitingShell =
    opening !== null && (openingShell === null || openingShell.archivedAt !== null);
  // Once per selection: later shell updates for the same thread must not
  // navigate again.
  const openedRef = useRef<typeof selection>(null);
  useEffect(() => {
    if (selection === null || isAwaitingShell || openingShell === null) return;
    if (openedRef.current === selection) return;
    openedRef.current = selection;
    onOpenThread(openingShell);
  }, [isAwaitingShell, onOpenThread, openingShell, selection]);

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || modelEnvironmentId === null) return;
    // A retry of the same words reruns the search without repeating the turn.
    const lastTurn = turns.at(-1);
    const nextTurns =
      lastTurn?.text === text ? turns : [...turns, { id: (lastTurn?.id ?? 0) + 1, text }];
    setTurns(nextTurns);
    setDraft("");
    setSelection(null);
    runSearch({
      description: composeAgentSearchDescription(
        nextTurns.map((turn) => turn.text),
        THREAD_SEARCH_DESCRIPTION_MAX_LENGTH,
      ),
      environments: searchEnvironments,
      modelEnvironmentId,
    });
  };

  const unarchiveAndOpen = async (match: AgentThreadSearchMatch) => {
    setIsUnarchiving(true);
    const unarchived = await unarchiveThread({
      environmentId: match.environmentId,
      id: match.threadId,
    });
    setIsUnarchiving(false);
    // A failure is reported by the unarchive action's own alert.
    if (unarchived) setSelection({ match });
  };

  const confirmUnarchive = (match: AgentThreadSearchMatch) => {
    const title = "Unarchive this thread?";
    const message = `“${match.threadTitle}” is archived. Unarchive it to open it in ${match.projectTitle} on ${match.environmentLabel}.`;
    const confirmText = "Unarchive and open";
    const onConfirm = () => void unarchiveAndOpen(match);
    if (Platform.OS === "ios") {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: confirmText, onPress: onConfirm },
      ]);
      return;
    }
    showConfirmDialog({ title, message, confirmText, onConfirm });
  };

  const selectMatch = (match: AgentThreadSearchMatch) => {
    if (isUnarchiving) return;
    if (match.archivedAt !== null) {
      confirmUnarchive(match);
      return;
    }
    setSelection({ match });
  };

  const settled = settledResult(search);

  return (
    <View className="flex-1">
      <View className="mx-4 mt-2 min-h-12 flex-row items-center gap-2.5 rounded-2xl border border-input-border bg-input px-3.5">
        <SymbolView
          name={AGENT_SEARCH_ICON}
          size={17}
          tintColorClassName={"accent-foreground-muted"}
          type="monochrome"
        />
        <TextInput
          accessibilityLabel="Describe the thread you remember"
          autoCapitalize="sentences"
          autoFocus
          className="min-w-0 flex-1 py-2.5 text-base font-sans text-foreground"
          editable={modelEnvironmentId !== null}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          placeholder={
            // Short enough to clear the Exact control on a phone; the label keeps
            // the full phrase for screen readers.
            turns.length === 0 ? "Describe a thread" : "Refine it"
          }
          placeholderTextColorClassName="accent-placeholder"
          returnKeyType="search"
          value={draft}
        />
        <Pressable
          accessibilityLabel="Search exact words"
          accessibilityRole="button"
          className="shrink-0"
          hitSlop={10}
          onPress={props.onExit}
        >
          <Text className="text-sm font-t3-medium text-foreground-muted">Exact</Text>
        </Pressable>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <AgentConversation
          canSearch={modelEnvironmentId !== null}
          isUnarchiving={isUnarchiving}
          opening={isAwaitingShell ? opening : null}
          search={search}
          settled={settled}
          turns={turns}
        />
        {settled?.status === "matches"
          ? settled.matches.map((match) => (
              <AgentResultRow
                key={`${match.environmentId}:${match.threadId}`}
                match={match}
                onPress={() => selectMatch(match)}
              />
            ))
          : null}
      </ScrollView>
    </View>
  );
}

/** The coordinator's verdict, once a search has settled and none is running. */
function settledResult(
  search: AsyncResult.AsyncResult<AgentThreadSearchResult, unknown>,
): AgentThreadSearchResult | null {
  if (search.waiting || !AsyncResult.isSuccess(search)) return null;
  return search.value;
}

function AgentResultRow(props: {
  readonly match: AgentThreadSearchMatch;
  readonly onPress: () => void;
}) {
  const { match } = props;
  const isArchived = match.archivedAt !== null;
  const scope = `${match.projectTitle} · ${match.environmentLabel}`;
  return (
    <Pressable
      accessibilityLabel={`${match.threadTitle}${isArchived ? ", archived" : ""}. ${match.reason}. ${scope}`}
      accessibilityRole="button"
      className="mx-4 mt-2 gap-1 rounded-2xl bg-card px-4 py-3"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-base font-t3-bold text-foreground" numberOfLines={1}>
          {match.threadTitle}
        </Text>
        {isArchived ? (
          <SymbolView
            name="archivebox"
            size={14}
            tintColorClassName={"accent-foreground-muted"}
            type="monochrome"
          />
        ) : null}
      </View>
      <Text className="text-sm text-foreground">{match.reason}</Text>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {scope}
      </Text>
    </Pressable>
  );
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
  readonly isUnarchiving: boolean;
  readonly opening: AgentThreadSearchMatch | null;
}) {
  const { turns, search, settled } = props;
  if (!props.canSearch) {
    return (
      <View className="px-5 pt-3">
        <AgentNote tone="alert">{AGENT_SEARCH_NO_ENVIRONMENT_TEXT}</AgentNote>
      </View>
    );
  }
  if (turns.length === 0) {
    return (
      <View className="px-5 pt-3">
        <AgentNote>{AGENT_SEARCH_HINT_TEXT}</AgentNote>
      </View>
    );
  }

  const verdict = settled === null ? null : describeAgentSearchVerdict(settled);
  const coverageNotes = settled === null ? [] : describeAgentSearchCoverage(settled.coverage);
  return (
    <View className="gap-1.5 px-5 pt-3">
      {turns.map((turn) => (
        <Text className="border-l-2 border-border pl-2 text-sm text-foreground-muted" key={turn.id}>
          {turn.text}
        </Text>
      ))}
      {search.waiting ? (
        <AgentNote>{AGENT_SEARCH_PROGRESS_TEXT}</AgentNote>
      ) : AsyncResult.isFailure(search) ? (
        <AgentNote tone="alert">{AGENT_SEARCH_UNEXPECTED_FAILURE_TEXT}</AgentNote>
      ) : verdict !== null ? (
        <AgentNote tone={verdict.tone}>{verdict.text}</AgentNote>
      ) : null}
      {props.isUnarchiving ? <AgentNote>Unarchiving the thread…</AgentNote> : null}
      {props.opening !== null ? (
        <AgentNote>
          {`Opening “${props.opening.threadTitle}” once ${props.opening.environmentLabel} delivers it…`}
        </AgentNote>
      ) : null}
      {coverageNotes.map((note) => (
        <AgentNote key={note}>{note}</AgentNote>
      ))}
    </View>
  );
}

function AgentNote(props: { readonly children: string; readonly tone?: "alert" | "status" }) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      className={
        props.tone === "alert"
          ? "py-1 text-sm text-danger-foreground"
          : "py-1 text-sm text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}
