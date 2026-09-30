import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  AgentThreadSearchEnvironment,
  AgentThreadSearchProgress,
  AgentThreadSearchResult,
} from "@t3tools/client-runtime/state/agent-thread-search";
import { composeAgentSearchDescription } from "@t3tools/client-runtime/state/agent-thread-search-presentation";
import { THREAD_SEARCH_DESCRIPTION_MAX_LENGTH, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { orchestrationEnvironment } from "~/state/orchestration";

import { toastManager } from "../ui/toast";

const SEARCH_SURFACE = "web-thread-search-picker";

export interface AgentSearchTurn {
  readonly id: number;
  readonly text: string;
}

export interface AgentSearchActivity extends AgentThreadSearchProgress {
  readonly id: number;
}

interface AgentSearchSession {
  readonly draft: string;
  readonly resetCount: number;
  readonly setDraft: (draft: string) => void;
  readonly turns: ReadonlyArray<AgentSearchTurn>;
  readonly progress: ReadonlyArray<AgentSearchActivity>;
  readonly search: AsyncResult.AsyncResult<AgentThreadSearchResult, unknown>;
  readonly setAgentVisible: (visible: boolean) => void;
  readonly submit: (
    text: string,
    environments: ReadonlyArray<AgentThreadSearchEnvironment>,
    modelEnvironmentId: EnvironmentId,
  ) => void;
  readonly reset: () => void;
}

const AgentSearchSessionContext = createContext<AgentSearchSession | null>(null);

/** Keeps one search alive while the popup is closed or a different route opens. */
export function AgentThreadSearchSessionProvider(props: {
  readonly children: ReactNode;
  readonly reopen: () => void;
}) {
  const registry = useContext(RegistryContext);
  const searchAtom = orchestrationEnvironment.agentThreadSearch(SEARCH_SURFACE);
  const search = useAtomValue(searchAtom);
  const runSearch = useAtomSet(searchAtom);
  const [draft, setDraft] = useState("");
  const [resetCount, setResetCount] = useState(0);
  const [agentVisible, setAgentVisible] = useState(false);
  const [turns, setTurns] = useState<ReadonlyArray<AgentSearchTurn>>([]);
  const [progress, setProgress] = useState<ReadonlyArray<AgentSearchActivity>>([]);
  const turnsRef = useRef<ReadonlyArray<AgentSearchTurn>>([]);
  const activityIdRef = useRef(0);
  const generationRef = useRef(0);
  const notifyOnSettleRef = useRef(false);

  const reset = useCallback(() => {
    generationRef.current += 1;
    notifyOnSettleRef.current = false;
    turnsRef.current = [];
    setDraft("");
    setResetCount((count) => count + 1);
    setTurns([]);
    setProgress([]);
    registry.set(searchAtom, Atom.Reset);
  }, [registry, searchAtom]);

  const submit = useCallback(
    (
      text: string,
      environments: ReadonlyArray<AgentThreadSearchEnvironment>,
      modelEnvironmentId: EnvironmentId,
    ) => {
      const description = text.trim();
      if (description.length === 0) return;
      const previous = turnsRef.current;
      const last = previous.at(-1);
      const next =
        last?.text === description
          ? previous
          : [...previous, { id: (last?.id ?? 0) + 1, text: description }];
      turnsRef.current = next;
      setTurns(next);
      setDraft("");
      setProgress([]);
      const generation = ++generationRef.current;
      notifyOnSettleRef.current = true;
      runSearch({
        description: composeAgentSearchDescription(
          next.map((turn) => turn.text),
          THREAD_SEARCH_DESCRIPTION_MAX_LENGTH,
        ),
        environments,
        modelEnvironmentId,
        onProgress: (step) => {
          if (generation !== generationRef.current) return;
          const activity = { ...step, id: ++activityIdRef.current };
          setProgress((current) => [...current, activity].slice(-20));
        },
      });
    },
    [runSearch],
  );

  useEffect(() => {
    if (!notifyOnSettleRef.current || search.waiting) return;
    if (!AsyncResult.isSuccess(search) && !AsyncResult.isFailure(search)) return;
    notifyOnSettleRef.current = false;
    if (agentVisible) return;
    const result = AsyncResult.isSuccess(search) ? search.value : null;
    const count = result?.status === "matches" ? result.matches.length : 0;
    toastManager.add({
      type:
        count > 0 ? "success" : result?.status === "failed" || result === null ? "error" : "info",
      title:
        count > 0
          ? `${count} likely ${count === 1 ? "thread" : "threads"} found`
          : "Thread search finished",
      description:
        count > 0 ? "Review the results in agent search." : "Review the search feedback.",
      actionProps: { children: "View search", onClick: props.reopen },
    });
  }, [agentVisible, props.reopen, search]);

  const value = useMemo(
    () => ({
      draft,
      resetCount,
      setDraft,
      turns,
      progress,
      search,
      setAgentVisible,
      submit,
      reset,
    }),
    [draft, resetCount, turns, progress, search, submit, reset],
  );
  return (
    <AgentSearchSessionContext.Provider value={value}>
      {props.children}
    </AgentSearchSessionContext.Provider>
  );
}

export function useAgentThreadSearchSession(): AgentSearchSession {
  const session = useContext(AgentSearchSessionContext);
  if (session === null) throw new Error("Agent thread search session is unavailable");
  return session;
}
