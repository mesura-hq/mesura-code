/**
 * Shared data and mock factories for the thread-search picker suites that mount
 * the application entry point through `threadSearchPicker.testMount.tsx`.
 *
 * The factories replace data sources only — environment presentations, entity
 * shells, the lexical search query, the agent-search atom family, settings, and
 * the RPC command boundary. Keyboard routing, overlay modes, the picker, and
 * navigation stay real.
 *
 * `vi.mock` must be called from each test file, so this module exports the
 * factories and the mutable state they read. It must not import application
 * modules: the factories load it while the application graph is loading.
 */
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type {
  AgentThreadSearchInput,
  AgentThreadSearchMatch,
  AgentThreadSearchResult,
} from "@t3tools/client-runtime/state/agent-thread-search";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useSyncExternalStore } from "react";

export const LAPTOP_ENVIRONMENT_ID = EnvironmentId.make("thread-search-laptop");
export const VIGILIA_ENVIRONMENT_ID = EnvironmentId.make("thread-search-vigilia");
export const MESURA_PROJECT_ID = ProjectId.make("thread-search-mesura");
export const HQ_PROJECT_ID = ProjectId.make("thread-search-hq");

const NOW = "2026-09-29T12:00:00.000Z";

function projectShell(
  environmentId: EnvironmentId,
  id: ProjectId,
  title: string,
): EnvironmentProject {
  return {
    id,
    environmentId,
    title,
    workspaceRoot: `/repos/${title.toLowerCase().replaceAll(" ", "-")}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function threadShell(input: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly updatedAt?: string;
}): EnvironmentThreadShell {
  const shell: OrchestrationThreadShell = {
    id: ThreadId.make(input.id),
    projectId: input.projectId,
    title: input.title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: input.updatedAt ?? NOW,
    updatedAt: input.updatedAt ?? NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: input.updatedAt ?? NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as OrchestrationThreadShell;
  return { ...shell, environmentId: input.environmentId };
}

/** Two active threads the lexical picker lists, one per environment. */
export function defaultThreadShells(): EnvironmentThreadShell[] {
  return [
    threadShell({
      environmentId: LAPTOP_ENVIRONMENT_ID,
      id: "thread-rename-keybind",
      projectId: MESURA_PROJECT_ID,
      title: "Rename keybind chord",
      updatedAt: "2026-09-29T11:00:00.000Z",
    }),
    threadShell({
      environmentId: VIGILIA_ENVIRONMENT_ID,
      id: "thread-hosts-dock",
      projectId: HQ_PROJECT_ID,
      title: "Hosts dock layout",
      updatedAt: "2026-09-29T10:00:00.000Z",
    }),
  ];
}

export function agentMatch(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: string;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly reason: string;
  readonly archivedAt?: string | null;
}): AgentThreadSearchMatch {
  return {
    environmentId: input.environmentId,
    environmentLabel: input.environmentLabel,
    threadId: ThreadId.make(input.threadId),
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    threadTitle: input.threadTitle,
    archivedAt: input.archivedAt ?? null,
    reason: input.reason,
  };
}

export const FULL_COVERAGE = {
  unavailableEnvironments: [],
  budgetExhausted: false,
  unreadEvidence: false,
} as const;

export interface AgentSearchCall {
  readonly surface: string;
  readonly input: AgentThreadSearchInput;
  readonly deferred: Deferred.Deferred<AgentThreadSearchResult>;
  interrupted: boolean;
}

type CommandResult = AsyncResult.Success<unknown, unknown> | AsyncResult.Failure<unknown, unknown>;

/** The label `threadEnvironment.unarchive` dispatches under. */
export const UNARCHIVE_COMMAND_LABEL = "environment-data:commands:thread:unarchive";

export function commandSuccess(): CommandResult {
  return AsyncResult.success(undefined);
}

export function commandFailure(message: string): CommandResult {
  return AsyncResult.failure(Cause.fail(new Error(message)));
}

export const threadSearchFixture = {
  environments: [] as Array<Record<string, unknown>>,
  projects: [] as EnvironmentProject[],
  threads: [] as EnvironmentThreadShell[],
  agentCalls: [] as AgentSearchCall[],
  /** Every RPC command the application dispatched, in order. */
  commandCalls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  /** Per-command replies by command label; unlisted commands succeed. */
  commandReplies: new Map<string, (value: unknown) => Promise<CommandResult>>(),
};

/**
 * Entity and environment reads re-render on `publishFixtureChange`, so a test
 * can deliver a thread shell or drop a connection after the app has mounted,
 * the way the shell stream and the connection supervisor do.
 */
const fixtureListeners = new Set<() => void>();
let fixtureVersion = 0;

function publishFixtureChange(): void {
  fixtureVersion += 1;
  for (const listener of fixtureListeners) listener();
}

function useFixtureVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      fixtureListeners.add(listener);
      return () => {
        fixtureListeners.delete(listener);
      };
    },
    () => fixtureVersion,
  );
}

/** Adds or replaces an active thread shell, as the shell stream's upsert does. */
export function deliverThreadShell(shell: EnvironmentThreadShell): void {
  threadSearchFixture.threads = [
    ...threadSearchFixture.threads.filter(
      (thread) => !(thread.environmentId === shell.environmentId && thread.id === shell.id),
    ),
    shell,
  ];
  publishFixtureChange();
}

export function setEnvironmentConnectionPhase(
  environmentId: EnvironmentId,
  phase: "connected" | "disconnected",
): void {
  threadSearchFixture.environments = threadSearchFixture.environments.map((environment) =>
    environment.environmentId === environmentId
      ? { ...environment, connection: { phase } }
      : environment,
  );
  publishFixtureChange();
}

function findThreadShell(ref: {
  readonly environmentId: string;
  readonly threadId: string;
}): EnvironmentThreadShell | null {
  return (
    threadSearchFixture.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null
  );
}

export function resetThreadSearchFixture(): void {
  threadSearchFixture.environments = [
    connectedEnvironment(LAPTOP_ENVIRONMENT_ID, "Laptop", "PrimaryConnectionTarget"),
    connectedEnvironment(VIGILIA_ENVIRONMENT_ID, "Vigilia", "BearerConnectionTarget"),
  ];
  threadSearchFixture.projects = [
    projectShell(LAPTOP_ENVIRONMENT_ID, MESURA_PROJECT_ID, "Mesura Code"),
    projectShell(VIGILIA_ENVIRONMENT_ID, HQ_PROJECT_ID, "Mesura HQ"),
  ];
  threadSearchFixture.threads = defaultThreadShells();
  threadSearchFixture.agentCalls = [];
  threadSearchFixture.commandCalls = [];
  threadSearchFixture.commandReplies = new Map();
}

function connectedEnvironment(
  environmentId: EnvironmentId,
  label: string,
  targetTag: "PrimaryConnectionTarget" | "BearerConnectionTarget",
) {
  return {
    environmentId,
    label,
    entry: { target: { _tag: targetTag, label, connectionId: `saved:${environmentId}` } },
    displayUrl: null,
    relayManaged: false,
    connection: { phase: "connected" },
    serverConfig: null,
  };
}

// ---------------------------------------------------------------------------
// Mock factories. Each suite calls these from its own `vi.mock` lines.
// ---------------------------------------------------------------------------

export function mockEntities<T extends object>(actual: T): T {
  return {
    ...actual,
    useProjects: () => threadSearchFixture.projects,
    useThreadShells: () => {
      useFixtureVersion();
      return threadSearchFixture.threads;
    },
    useThreadShell: (ref: { environmentId: string; threadId: string } | null) => {
      useFixtureVersion();
      return ref === null ? null : findThreadShell(ref);
    },
    readThreadShell: findThreadShell,
  };
}

export function mockEnvironments<T extends object>(actual: T): T {
  return {
    ...actual,
    useEnvironments: () => {
      useFixtureVersion();
      return {
        isReady: true,
        networkStatus: "online",
        environments: threadSearchFixture.environments,
        presentationById: new Map(),
      };
    },
    usePrimaryEnvironmentId: () => LAPTOP_ENVIRONMENT_ID,
    usePrimaryEnvironment: () => threadSearchFixture.environments[0] ?? null,
  };
}

export function mockQueries<T extends object>(actual: T): T {
  return {
    ...actual,
    useThreadSearch: () => ({ matches: [], isPending: false }),
    useProjectPathSearch: () => ({
      entries: [],
      isPending: false,
      error: null,
      truncated: false,
    }),
  };
}

/**
 * The shared `orchestrationEnvironment.agentThreadSearch` family with the same
 * shape and cancellation semantics as the real one — an `Atom.fn` per surface
 * key, whose fiber is interrupted by a new write, `Atom.Reset`, or disposal —
 * but whose result each test settles by hand.
 */
export function mockOrchestration<T extends { orchestrationEnvironment: object }>(actual: T): T {
  const agentThreadSearch = Atom.family((surface: string) =>
    Atom.fn((input: AgentThreadSearchInput) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<AgentThreadSearchResult>();
        const call: AgentSearchCall = { surface, input, deferred, interrupted: false };
        threadSearchFixture.agentCalls.push(call);
        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              call.interrupted = true;
            }),
          ),
        );
      }),
    ),
  );
  return {
    ...actual,
    orchestrationEnvironment: { ...actual.orchestrationEnvironment, agentThreadSearch },
  };
}

export function mockUseAtomCommand() {
  return {
    useAtomCommand: (command: { readonly label?: string }) => async (value: unknown) => {
      const label = command.label ?? "unlabelled-command";
      threadSearchFixture.commandCalls.push({ label, value });
      const reply = threadSearchFixture.commandReplies.get(label);
      return reply ? reply(value) : commandSuccess();
    },
  };
}

export async function mockSettings<T extends object>(actual: T): Promise<T> {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  return {
    ...actual,
    useEnvironmentSettings: () => settings,
    useSettings: () => settings,
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
  };
}
