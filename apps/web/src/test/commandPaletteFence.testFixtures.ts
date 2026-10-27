/**
 * Data and `vi.mock` factories for the command palette suites. They replace data sources only;
 * keyboard routing, overlay modes and navigation stay real. This module must not import application
 * modules: the factories load it while the application graph is loading.
 */
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { appRootFence, makeFenceSession } from "./appRootFenceMocks";

export const LAPTOP_ENVIRONMENT_ID = EnvironmentId.make("palette-fence-laptop");
export const VIGILIA_ENVIRONMENT_ID = EnvironmentId.make("palette-fence-vigilia");
export const MESURA_PROJECT_ID = ProjectId.make("palette-fence-mesura");
export const HQ_PROJECT_ID = ProjectId.make("palette-fence-hq");

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
  const id = ThreadId.make(input.id);
  const providerInstanceId = ProviderInstanceId.make("codex");
  const at = DateTime.makeUnsafe(input.updatedAt ?? NOW);
  return presentThreadShell(input.environmentId, {
    id,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: at,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });
}

/** Two active threads, one per environment. */
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

type CommandResult = AsyncResult.Success<unknown, unknown> | AsyncResult.Failure<unknown, unknown>;

export function commandSuccess(): CommandResult {
  return AsyncResult.success(undefined);
}

export const commandPaletteFence = {
  environments: [] as Array<Record<string, unknown>>,
  projects: [] as EnvironmentProject[],
  threads: [] as EnvironmentThreadShell[],
  /** Every RPC command the application dispatched, in order. */
  commandCalls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  /** Per-command replies by command label; unlisted commands succeed. */
  commandReplies: new Map<string, (value: unknown) => Promise<CommandResult>>(),
};

/** The fixture is set before mounting, so its reads never change under a mounted app. */
function useFixtureSnapshot<T>(readSnapshot: () => T): T {
  return useSyncExternalStore(subscribeToNothing, readSnapshot);
}

function subscribeToNothing(): () => void {
  return () => {};
}

function findThreadShell(ref: {
  readonly environmentId: string;
  readonly threadId: string;
}): EnvironmentThreadShell | null {
  return (
    commandPaletteFence.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null
  );
}

export function resetCommandPaletteFence(): void {
  appRootFence.sessions.clear();
  for (const environmentId of [LAPTOP_ENVIRONMENT_ID, VIGILIA_ENVIRONMENT_ID]) {
    appRootFence.sessions.set(environmentId, makeFenceSession());
  }
  commandPaletteFence.environments = [
    connectedEnvironment(LAPTOP_ENVIRONMENT_ID, "Laptop", "PrimaryConnectionTarget"),
    connectedEnvironment(VIGILIA_ENVIRONMENT_ID, "Vigilia", "BearerConnectionTarget"),
  ];
  commandPaletteFence.projects = [
    projectShell(LAPTOP_ENVIRONMENT_ID, MESURA_PROJECT_ID, "Mesura Code"),
    projectShell(VIGILIA_ENVIRONMENT_ID, HQ_PROJECT_ID, "Mesura HQ"),
  ];
  commandPaletteFence.threads = defaultThreadShells();
  commandPaletteFence.commandCalls = [];
  commandPaletteFence.commandReplies = new Map();
}

function connectedEnvironment(
  environmentId: EnvironmentId,
  label: string,
  targetTag: "PrimaryConnectionTarget" | "BearerConnectionTarget",
) {
  return {
    environmentId,
    label,
    entry: {
      target:
        targetTag === "PrimaryConnectionTarget"
          ? new PrimaryConnectionTarget({
              environmentId,
              label,
              httpBaseUrl: "https://fixture.invalid",
              wsBaseUrl: "wss://fixture.invalid",
            })
          : new BearerConnectionTarget({
              environmentId,
              label,
              connectionId: `saved:${environmentId}`,
            }),
      profile: Option.none(),
      enabled: true,
    },
    displayUrl: null,
    relayManaged: false,
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: null,
  };
}

// Each suite registers these factories through its own vi.mock calls.

export function mockEntities<T extends object>(actual: T): T {
  const useFixtureThreadShell = (ref: { environmentId: string; threadId: string } | null) =>
    useFixtureSnapshot(() => (ref === null ? null : findThreadShell(ref)));
  return {
    ...actual,
    useProjects: () => useFixtureSnapshot(() => commandPaletteFence.projects),
    useThreadShells: () => useFixtureSnapshot(() => commandPaletteFence.threads),
    useThreadShell: useFixtureThreadShell,
    useQuietThreadShell: useFixtureThreadShell,
    readThreadShell: findThreadShell,
  };
}

export function mockEnvironments<T extends object>(actual: T): T {
  return {
    ...actual,
    useEnvironments: () => {
      const environments = useFixtureSnapshot(() => commandPaletteFence.environments);
      return {
        isReady: true,
        networkStatus: "online",
        environments,
        presentationById: new Map(
          environments.map((environment) => [environment.environmentId, environment]),
        ),
      };
    },
    useEnvironmentProviders: () => new Map(),
    usePrimaryEnvironmentId: () => LAPTOP_ENVIRONMENT_ID,
    usePrimaryEnvironment: () => commandPaletteFence.environments[0] ?? null,
  };
}

export function mockQueries<T extends object>(actual: T): T {
  return {
    ...actual,
    useThreadSearch: () => ({ matches: [], query: "", isPending: false }),
    useProjectPathSearch: () => ({
      entries: [],
      isPending: false,
      error: null,
      truncated: false,
    }),
  };
}

export function mockUseAtomCommand() {
  return {
    useAtomCommand: (command: { readonly label?: string }) => async (value: unknown) => {
      const label = command.label ?? "unlabelled-command";
      commandPaletteFence.commandCalls.push({ label, value });
      const reply = commandPaletteFence.commandReplies.get(label);
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
