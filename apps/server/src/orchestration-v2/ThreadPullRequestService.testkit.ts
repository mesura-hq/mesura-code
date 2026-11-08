/**
 * Drives `ThreadPullRequestServiceV2` as the server does: one startup backfill, then one
 * sweep per minute of `TestClock` time, plus the domain events that queue one thread.
 * The test supplies the thread shells, the project, git and the repository identity.
 *
 * @module orchestration-v2/ThreadPullRequestService.testkit
 */
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

export const SWEEP_NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");

export const sweepThreadShell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SWEEP_NOW,
    updatedAt: SWEEP_NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

export const sweepProjectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

/** The events that can change a thread group's pull-request answer. */
export type SweepTriggerEvent =
  | "thread.metadata-updated"
  | "thread.unarchived"
  | "checkpoint.captured"
  | "run.completed";

let eventCounter = 0;

export function sweepDomainEvent(
  kind: SweepTriggerEvent,
  thread: OrchestrationV2ThreadShell,
): OrchestrationV2DomainEvent {
  eventCounter += 1;
  const base = {
    id: EventId.make(`event:sweep-testkit:${eventCounter}`),
    threadId: thread.id,
    occurredAt: SWEEP_NOW,
  };
  const runId = RunId.make(`run:${thread.id}`);
  switch (kind) {
    case "thread.metadata-updated":
    case "thread.unarchived":
      return {
        ...base,
        type: kind,
        payload: {
          createdBy: thread.createdBy,
          creationSource: thread.creationSource,
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          activeProviderThreadId: thread.activeProviderThreadId,
          lineage: thread.lineage,
          forkedFrom: null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          archivedAt: thread.archivedAt,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      };
    case "checkpoint.captured":
      return {
        ...base,
        type: "checkpoint.captured",
        payload: {
          id: CheckpointId.make(`checkpoint:${thread.id}:${eventCounter}`),
          threadId: thread.id,
          scopeId: CheckpointScopeId.make(`scope:${thread.id}`),
          runId,
          nodeId: NodeId.make(`node:${thread.id}`),
          parentCheckpointId: null,
          ordinalWithinScope: eventCounter,
          appRunOrdinal: 1,
          ref: CheckpointRef.make(`refs/t3/checkpoints/${thread.id}/${eventCounter}`),
          status: "ready",
          files: [],
          capturedAt: SWEEP_NOW,
        },
      };
    case "run.completed":
      return {
        ...base,
        type: "run.updated",
        payload: {
          id: runId,
          threadId: thread.id,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${thread.id}`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: SWEEP_NOW,
          startedAt: SWEEP_NOW,
          completedAt: SWEEP_NOW,
          checkpointId: null,
          contextHandoffId: null,
        },
      };
  }
}

export interface CapturedLog {
  readonly level: string;
  readonly message: string;
  readonly annotations: Record<string, unknown>;
}

export interface SweepHarness {
  /** Starts the service and runs the startup backfill pass to completion. */
  readonly start: Effect.Effect<void>;
  /** Advances the clock one minute and waits for that sweep to finish. */
  readonly sweep: Effect.Effect<void>;
  /** Runs `count` sweeps, one minute apart. */
  readonly sweeps: (count: number) => Effect.Effect<void>;
  /** Publishes one domain event and waits for the work it queued. */
  readonly publish: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  /** Replaces the thread shells every later read returns. */
  readonly setThreads: (threads: ReadonlyArray<OrchestrationV2ThreadShell>) => void;
  /** Every command the service dispatched, in order. */
  readonly dispatched: ReadonlyArray<OrchestrationV2ServerCommand>;
  /** Every log the service wrote, in order. Structured message parts are JSON. */
  readonly logs: ReadonlyArray<CapturedLog>;
}

export const makeSweepHarness = (input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly project: OrchestrationProjectShell;
  readonly git: Pick<GitManager.GitManager["Service"], "branchPullRequest">;
  readonly repositoryIdentities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"];
}): Effect.Effect<SweepHarness, never, Scope.Scope> =>
  Effect.gen(function* () {
    let threads = input.threads;
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const logs: Array<CapturedLog> = [];
    const logger = Logger.make<unknown, void>(({ fiber, logLevel, message }) => {
      logs.push({
        level: logLevel,
        message: (Array.isArray(message) ? message : [message])
          .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
          .join(" "),
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      });
    });
    const activation = yield* Deferred.make<void>();
    const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    const reads = yield* Queue.unbounded<"snapshot" | ThreadId>();
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromPubSub(events),
        getShellSnapshot: (options) =>
          Queue.offer(reads, "snapshot").pipe(
            Effect.as({
              schemaVersion: 2 as const,
              snapshotSequence: 1,
              threads: threads.filter(
                (thread) =>
                  thread.archivedAt === null &&
                  !(
                    options?.unsettledOnly &&
                    (thread.settledOverride === "settled" || thread.settledAt !== null)
                  ),
              ),
              archivedThreads: [],
            }),
          ),
        getThreadEventSequence: () => Effect.succeed(1),
        getThreadShell: (threadId) =>
          Queue.offer(reads, threadId).pipe(
            Effect.as(threads.find((thread) => thread.id === threadId) ?? null),
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length, storedEvents: [] };
          }),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () => Effect.succeed([input.project]),
        getShell: () => Effect.succeedSome(input.project),
      }),
      Layer.mock(GitManager.GitManager)({
        branchPullRequest: input.git.branchPullRequest,
      }),
      Layer.mock(PullRequestService.PullRequestService)({}),
      // A client is present, so the periodic sweep runs.
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunOpportunisticWork: Effect.succeed(true),
      }),
      Layer.succeed(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        input.repositoryIdentities,
      ),
      Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(1),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      Logger.layer([logger], { mergeWithExisting: false }),
    );
    // The worker fiber starts inside `make`, so the logger must already be in place there.
    const service = yield* ThreadPullRequestService.make.pipe(Effect.provide(dependencies));
    // `start` forks the service's loops into the harness's scope, not the caller's.
    const scope = yield* Effect.scope;
    const drain = service.drain;

    const start = Effect.gen(function* () {
      yield* service.start().pipe(Effect.provide(dependencies), Scope.provide(scope));
      yield* Deferred.succeed(activation, undefined);
      yield* Queue.take(reads);
      yield* drain;
    });
    const sweep = Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(reads);
      yield* drain;
    });
    const sweeps = (count: number) =>
      Effect.gen(function* () {
        for (let index = 0; index < count; index += 1) yield* sweep;
      });
    const publish = (event: OrchestrationV2DomainEvent) =>
      Effect.gen(function* () {
        yield* PubSub.publish(events, event);
        yield* Queue.take(reads);
        yield* drain;
      });
    return {
      start,
      sweep,
      sweeps,
      publish,
      setThreads: (next) => {
        threads = next;
      },
      dispatched,
      logs,
    } satisfies SweepHarness;
  });
