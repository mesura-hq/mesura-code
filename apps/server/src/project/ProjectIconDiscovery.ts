/**
 * ProjectIconDiscovery - explicit Luna searches for project icons.
 *
 * The `projectIcons.discover` RPC is the only way a search starts: nothing on
 * project creation, threads, turns, resets, restarts or replay reaches the
 * model. A request is claimed as a durable job on the project before the
 * worker runs it, the worker runs one model call at a time, and the outcome is
 * written back through the decider, which refuses to overwrite a project that
 * changed since the request. A restart marks unfinished jobs interrupted and
 * never retries them.
 *
 * @module ProjectIconDiscovery
 */
import {
  CommandId,
  ProjectIconDiscoveryError,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type ProjectIconDiscoverInput,
  type ProjectIconDiscoveryAccepted,
  type ProjectIconDiscoveryPreview,
  type ProjectIconEffectiveSource,
  type ProjectIconDiscoveryStatus,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type TextGenerationError,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { isProjectIconDiscoveryActive } from "../orchestration/projectIconDiscovery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  collectProjectIconCandidates,
  validateProjectIconCandidate,
  type ProjectIconCandidate,
} from "./ProjectIconCandidates.ts";
import { ProjectFaviconResolver } from "./ProjectFaviconResolver.ts";
import {
  canRunProjectIconSelection,
  PROJECT_ICON_SELECTION_MODEL,
  ProjectIconSelectionUnavailable,
  type ProjectIconSelection,
  type ProjectIconSelectionInput,
} from "./ProjectIconSelection.ts";

export { ProjectIconSelectionUnavailable } from "./ProjectIconSelection.ts";

export type ProjectIconSelector = (
  input: ProjectIconSelectionInput,
) => Effect.Effect<ProjectIconSelection, ProjectIconSelectionUnavailable | TextGenerationError>;

export interface ProjectIconDiscoveryShape {
  /** Read-only: inspects local files, never claims a job or calls a model. */
  readonly preview: (
    projectIds?: ReadonlyArray<ProjectId>,
  ) => Effect.Effect<ReadonlyArray<ProjectIconDiscoveryPreview>, ProjectIconDiscoveryError>;
  /** Claims or joins the project's job and answers at once; the outcome lands on the project. */
  readonly discover: (
    input: ProjectIconDiscoverInput,
  ) => Effect.Effect<ProjectIconDiscoveryAccepted, ProjectIconDiscoveryError>;
}

const unavailable = () =>
  Effect.fail(
    new ProjectIconDiscoveryError({ detail: "Icon searches are not available on this server." }),
  );

// A reference rather than a required service, so server compositions that do
// not run searches (test harnesses, tools) need not provide it; `server.ts`
// always does.
export class ProjectIconDiscovery extends Context.Reference<ProjectIconDiscoveryShape>(
  "t3/project/ProjectIconDiscovery",
  { defaultValue: () => ({ preview: unavailable, discover: unavailable }) },
) {}

export interface ProjectIconInstanceCandidate {
  readonly instance: ProviderInstance;
  /** The instance's current provider snapshot: status, sign-in and models. */
  readonly provider: ServerProvider;
}

/**
 * The instance that answers icon searches. Only an enabled instance with the
 * capability whose snapshot can run Luna qualifies; among those, the
 * configured text-generation instance wins, then settings order.
 */
export function selectProjectIconInstance(
  candidates: ReadonlyArray<ProjectIconInstanceCandidate>,
  preferredInstanceId: ProviderInstanceId | null,
): ProviderInstance | null {
  const usable = candidates
    .filter(
      ({ instance, provider }) =>
        instance.enabled &&
        instance.selectProjectIcon !== undefined &&
        canRunProjectIconSelection(provider),
    )
    .map(({ instance }) => instance);
  return (
    usable.find((instance) => instance.instanceId === preferredInstanceId) ?? usable[0] ?? null
  );
}

type Inspection =
  | { readonly status: "ready"; readonly candidates: ReadonlyArray<ProjectIconCandidate> }
  | {
      readonly status: "existing";
      readonly reason: string;
      readonly effectiveSource: ProjectIconEffectiveSource;
    }
  | { readonly status: "empty" | "failed"; readonly reason: string };

type WorkerItem =
  | { readonly kind: "interrupt-unfinished" }
  | {
      readonly kind: "run";
      readonly projectId: ProjectId;
      readonly jobToken: CommandId;
      readonly generation: number;
    };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeProjectIconDiscovery = Effect.fn("ProjectIconDiscovery.make")(function* (options: {
  /** Fails with `ProjectIconSelectionUnavailable` when no instance can search. */
  readonly resolveSelector: Effect.Effect<ProjectIconSelector, ProjectIconSelectionUnavailable>;
}) {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const resolver = yield* ProjectFaviconResolver;
  // Jobs this process claimed. The startup sweep leaves them alone.
  const claimed = new Set<CommandId>();
  // Jobs handed to the worker, each exactly once.
  const enqueued = new Set<CommandId>();

  const readProject = (projectId: ProjectId) =>
    snapshots.getProjectShellById(projectId).pipe(Effect.map(Option.getOrNull));

  // The effective icon decides eligibility, not an earlier outcome: a custom
  // icon, then whatever the resolver displays (a saved path that still
  // resolves, repository configuration, or a built-in favicon).
  // The preview may trust the resolver's cache; the worker acts on the answer,
  // so it asks for a fresh walk (`fresh`).
  const effectiveIcon = Effect.fn("ProjectIconDiscovery.effectiveIcon")(function* (
    project: OrchestrationProjectShell,
    fresh: boolean,
  ) {
    if (project.projectIcon != null) {
      return { source: "custom", reason: "The project uses a custom icon." } as const;
    }
    const effective = yield* resolver.resolveEffectiveImage(
      project.workspaceRoot,
      project.faviconPath ?? undefined,
      { fresh },
    );
    return effective === null
      ? null
      : ({
          source: effective.source,
          reason: "An icon is already shown. Use Update project icon… to replace it.",
        } as const);
  });

  const inspect = (project: OrchestrationProjectShell, fresh: boolean): Effect.Effect<Inspection> =>
    Effect.gen(function* () {
      const existing = yield* effectiveIcon(project, fresh);
      if (existing !== null) {
        return {
          status: "existing",
          reason: existing.reason,
          effectiveSource: existing.source,
        } as const;
      }
      const candidates = yield* Effect.tryPromise(() =>
        collectProjectIconCandidates(project.workspaceRoot),
      );
      return candidates.length > 0
        ? ({ status: "ready", candidates } as const)
        : ({ status: "empty", reason: "No local image candidates. Luna will not run." } as const);
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          status: "failed",
          reason: "Could not inspect this project's files.",
        } as const),
      ),
    );

  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);

  /** The project while this job is still its current, running search; otherwise null. */
  const readCurrentJobProject = Effect.fn("ProjectIconDiscovery.readCurrentJobProject")(function* (
    job: Extract<WorkerItem, { kind: "run" }>,
  ) {
    const project = yield* readProject(job.projectId);
    const state = project?.iconDiscovery;
    return state?.jobToken === job.jobToken &&
      state.generation === job.generation &&
      state.status === "running"
      ? project
      : null;
  });

  const finish = Effect.fn("ProjectIconDiscovery.finish")(function* (
    job: Extract<WorkerItem, { kind: "run" }>,
    status: ProjectIconDiscoveryStatus,
    path: string | null,
    reason: string,
  ) {
    yield* dispatch({
      type: "project.icon-discovery.complete",
      commandId: CommandId.make(`${job.jobToken}:complete`),
      projectId: job.projectId,
      jobToken: job.jobToken,
      generation: job.generation,
      status,
      path,
      reason,
      createdAt: yield* nowIso,
    });
  });

  const run = Effect.fn("ProjectIconDiscovery.run")(function* (
    job: Extract<WorkerItem, { kind: "run" }>,
  ) {
    yield* dispatch({
      type: "project.icon-discovery.start",
      commandId: CommandId.make(`${job.jobToken}:start`),
      projectId: job.projectId,
      jobToken: job.jobToken,
      createdAt: yield* nowIso,
    });
    // A reset or a moved root supersedes a queued job before it runs: such a
    // job ends here, before any model work.
    const project = yield* readCurrentJobProject(job);
    if (project === null) return;
    // The project may have changed since the preview the user confirmed.
    const inspection = yield* inspect(project, true);
    if (inspection.status !== "ready") {
      return yield* finish(job, inspection.status, null, inspection.reason);
    }
    const selector = yield* Effect.result(options.resolveSelector);
    if (Result.isFailure(selector)) {
      return yield* finish(job, "unavailable", null, selector.failure.detail);
    }
    if ((yield* readCurrentJobProject(job)) === null) return;
    const selection = yield* Effect.result(
      selector.success({ project, candidates: inspection.candidates }),
    );
    if (Result.isFailure(selection)) {
      const failure = selection.failure;
      if (failure._tag === "ProjectIconSelectionUnavailable") {
        return yield* finish(job, "unavailable", null, failure.detail);
      }
      yield* Effect.logWarning("Project icon search failed", {
        projectId: job.projectId,
        failure,
      });
      return yield* finish(job, "failed", null, "Luna could not finish the search.");
    }
    const selected = selection.success;
    if (selected.path === null) {
      return yield* finish(job, "none", null, selected.reason);
    }
    const selectedPath = selected.path;
    // A re-read guards against a bad file, not against a concurrent edit: the
    // decider's generation check owns that.
    const valid =
      inspection.candidates.some((candidate) => candidate.path === selectedPath) &&
      (yield* Effect.tryPromise(() =>
        validateProjectIconCandidate(project.workspaceRoot, selectedPath),
      ).pipe(Effect.orElseSucceed(() => false)));
    if (!valid) {
      return yield* finish(
        job,
        "failed",
        null,
        "Luna chose a file that is not a local image candidate.",
      );
    }
    // An icon may have appeared while Luna ran, such as a new built-in
    // favicon. A saved path would outrank it, so the search keeps it instead.
    const current = yield* readCurrentJobProject(job);
    if (current === null) return;
    const appeared = yield* effectiveIcon(current, true).pipe(
      Effect.map((icon) => icon?.reason ?? null),
      Effect.orElseSucceed(() => "Could not check the project's current icon."),
    );
    if (appeared !== null) return yield* finish(job, "existing", null, appeared);
    return yield* finish(job, "selected", selectedPath, selected.reason);
  });

  // A job left pending or running belonged to a server that stopped. It is
  // recorded as interrupted and never run again.
  const interruptUnfinished = Effect.fn("ProjectIconDiscovery.interruptUnfinished")(function* () {
    const activation = yield* ServerActivation;
    if (activation !== undefined) yield* activation;
    const snapshot = yield* snapshots.getShellSnapshot();
    for (const project of snapshot.projects) {
      const state = project.iconDiscovery;
      if (!state || !isProjectIconDiscoveryActive(state) || claimed.has(state.jobToken)) continue;
      yield* dispatch({
        type: "project.icon-discovery.complete",
        commandId: CommandId.make(`${state.jobToken}:interrupted`),
        projectId: project.id,
        jobToken: state.jobToken,
        generation: state.generation,
        status: "interrupted",
        path: null,
        reason: "The server stopped before the search finished.",
        createdAt: yield* nowIso,
      });
    }
  });

  const worker = yield* makeDrainableWorker((item: WorkerItem) =>
    (item.kind === "run" ? run(item) : interruptUnfinished()).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Project icon discovery step failed", {
          item,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );
  yield* worker.enqueue({ kind: "interrupt-unfinished" });

  const preview = Effect.fn("ProjectIconDiscovery.preview")(function* (
    projectIds?: ReadonlyArray<ProjectId>,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot();
    const requested = projectIds ? new Set(projectIds) : null;
    return yield* Effect.forEach(
      snapshot.projects.filter((project) => requested === null || requested.has(project.id)),
      (project) =>
        inspect(project, false).pipe(
          Effect.map((inspection): ProjectIconDiscoveryPreview =>
            inspection.status === "ready"
              ? {
                  projectId: project.id,
                  title: project.title,
                  candidateCount: inspection.candidates.length,
                  status: "ready",
                  reason: `${inspection.candidates.length} local image candidates`,
                  effectiveSource: "initials",
                }
              : {
                  projectId: project.id,
                  title: project.title,
                  candidateCount: 0,
                  status: inspection.status,
                  reason: inspection.reason,
                  // A project that could not be inspected has no known icon.
                  ...(inspection.status === "existing"
                    ? { effectiveSource: inspection.effectiveSource }
                    : inspection.status === "empty"
                      ? { effectiveSource: "initials" as const }
                      : {}),
                },
          ),
        ),
      { concurrency: 4 },
    );
  });

  // Claim, read and enqueue run uninterruptibly: an RPC cancelled after the
  // request persists must not leave a pending job that no worker owns. The
  // model call itself runs on the worker, which the server scope interrupts.
  const discover = Effect.fn("ProjectIconDiscovery.discover")(function* (
    input: ProjectIconDiscoverInput,
  ) {
    // Marked before the request persists, so the startup sweep cannot
    // interrupt a job this process is about to own.
    claimed.add(input.requestId);
    // The request ID is the command ID, so a transport retry is deduplicated
    // by the engine's command receipts and joins the job it started.
    yield* dispatch({
      type: "project.icon-discovery.request",
      commandId: input.requestId,
      projectId: input.projectId,
      createdAt: yield* nowIso,
    });
    const state = (yield* readProject(input.projectId))?.iconDiscovery;
    if (!state) {
      return yield* new ProjectIconDiscoveryError({ detail: "The project no longer exists." });
    }
    // A pending job no worker took (its request was cancelled before it was
    // queued) is adopted by the next request that joins it.
    if (state.status === "pending" && !enqueued.has(state.jobToken)) {
      enqueued.add(state.jobToken);
      claimed.add(state.jobToken);
      yield* worker.enqueue({
        kind: "run",
        projectId: input.projectId,
        jobToken: state.jobToken,
        generation: state.generation,
      });
    }
    return {
      projectId: input.projectId,
      jobToken: state.jobToken,
      generation: state.generation,
    };
  }, Effect.uninterruptible);

  const isDiscoveryError = Schema.is(ProjectIconDiscoveryError);
  const toDiscoveryError = (detail: string) => (error: unknown) =>
    isDiscoveryError(error) ? error : new ProjectIconDiscoveryError({ detail });

  return {
    preview: (projectIds?: ReadonlyArray<ProjectId>) =>
      preview(projectIds).pipe(Effect.mapError(toDiscoveryError("Could not read projects."))),
    discover: (input: ProjectIconDiscoverInput) =>
      discover(input).pipe(Effect.mapError(toDiscoveryError("Could not start the search."))),
    drain: worker.drain,
  };
});

/** Searches run on the configured Codex instance that supports Luna, if any. */
const resolveConfiguredSelector = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const settings = yield* ServerSettingsService;
  return Effect.gen(function* () {
    const preferred = yield* settings.getSettings.pipe(
      Effect.map((value) => value.textGenerationModelSelection?.instanceId ?? null),
      Effect.orElseSucceed(() => null),
    );
    const candidates = yield* Effect.forEach(
      (yield* registry.listInstances).filter((instance) => instance.selectProjectIcon),
      (instance) =>
        instance.snapshot.getSnapshot.pipe(Effect.map((provider) => ({ instance, provider }))),
    );
    const instance = selectProjectIconInstance(candidates, preferred);
    if (instance?.selectProjectIcon === undefined) {
      return yield* new ProjectIconSelectionUnavailable({
        detail:
          candidates.length === 0
            ? "No enabled Codex instance can run Luna icon searches."
            : `No Codex instance is ready and signed in with ${PROJECT_ICON_SELECTION_MODEL}.`,
      });
    }
    return instance.selectProjectIcon satisfies ProjectIconSelector;
  });
});

export const layer = Layer.effect(
  ProjectIconDiscovery,
  Effect.gen(function* () {
    const discovery = yield* makeProjectIconDiscovery({
      resolveSelector: yield* resolveConfiguredSelector,
    });
    return { preview: discovery.preview, discover: discovery.discover };
  }),
);
