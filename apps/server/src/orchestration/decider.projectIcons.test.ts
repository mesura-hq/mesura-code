// Entry point: `decideOrchestrationCommand` then `projectEvent`, the serialized
// decider and the pure projector the orchestration engine runs for every
// command. Project icon discovery phase 1, acceptance criteria 3 and 7: an
// explicit request claims a job token and generation, and a completion saves
// its image only while that token, generation, captured root and starting icon
// fields still hold.
import {
  CommandId,
  EventId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-11T00:00:00.000Z";
const projectId = ProjectId.make("project-icon-discovery");

/** The durable discovery state the phase adds to a project. */
interface DiscoveryState {
  readonly generation: number;
  readonly jobToken: string | null;
  readonly status: string;
  readonly path: string | null;
  readonly reason: string;
}
const discoveryOf = (project: OrchestrationProject | undefined): DiscoveryState | null =>
  (project as { iconDiscovery?: DiscoveryState | null } | undefined)?.iconDiscovery ?? null;

/**
 * Decides one command against the read model and projects what it emits. A
 * rejected command leaves the model unchanged, as the engine does.
 */
const apply = Effect.fnUntraced(function* (
  state: { model: OrchestrationReadModel; sequence: number },
  command: unknown,
) {
  const decided = yield* Effect.result(
    decideOrchestrationCommand({
      command: command as OrchestrationCommand,
      readModel: state.model,
    }),
  );
  if (Result.isFailure(decided)) return { rejected: true as const, error: decided.failure };
  const events = Array.isArray(decided.success) ? decided.success : [decided.success];
  for (const event of events as ReadonlyArray<OrchestrationEvent>) {
    state.sequence += 1;
    state.model = yield* projectEvent(state.model, { ...event, sequence: state.sequence });
  }
  return { rejected: false as const, events };
});

const project = (state: { model: OrchestrationReadModel }) =>
  state.model.projects.find((candidate) => candidate.id === projectId);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-icon-decider-" });
  const movedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-icon-decider-moved-" });
  const created: OrchestrationEvent = {
    sequence: 1,
    eventId: EventId.make("evt-project-icon-discovery-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-project-icon-discovery-created"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-icon-discovery-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Icon discovery",
      workspaceRoot: root,
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  const state = {
    model: yield* projectEvent(createEmptyReadModel(NOW), created),
    sequence: 1,
  };
  return { state, root, movedRoot };
});

const request = (id: string) => ({
  type: "project.icon-discovery.request",
  commandId: CommandId.make(id),
  projectId,
  createdAt: NOW,
});
const start = (jobToken: string, id = `${jobToken}:start`) => ({
  type: "project.icon-discovery.start",
  commandId: CommandId.make(id),
  projectId,
  jobToken: CommandId.make(jobToken),
  createdAt: NOW,
});
const complete = (
  job: { jobToken: string | null; generation: number },
  outcome: { status: string; path: string | null; reason: string },
  id = `${job.jobToken}:complete`,
) => ({
  type: "project.icon-discovery.complete",
  commandId: CommandId.make(id),
  projectId,
  jobToken: job.jobToken,
  generation: job.generation,
  ...outcome,
  createdAt: NOW,
});
const SELECTED = { status: "selected", path: "web/public/brand-logo.svg", reason: "Brand mark." };

/** Requests and starts a job, returning the claim a worker would hold. */
const claim = Effect.fnUntraced(function* (
  state: { model: OrchestrationReadModel; sequence: number },
  id: string,
) {
  const requested = yield* apply(state, request(id));
  expect(requested.rejected, `request ${id} should be accepted`).toBe(false);
  const claimed = discoveryOf(project(state));
  expect(claimed, "a request records discovery state on the project").not.toBeNull();
  yield* apply(state, start(claimed!.jobToken!));
  return { jobToken: claimed!.jobToken, generation: claimed!.generation };
});

it.layer(NodeServices.layer)("project icon discovery decider fence", (it) => {
  describe("explicit requests", () => {
    it.effect("icon discovery fence: a request claims a pending job named by its command", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        expect(discoveryOf(project(state)), "a project starts with no discovery job").toBeNull();
        yield* apply(state, request("cmd-icon-request-1"));
        expect(discoveryOf(project(state))).toMatchObject({
          jobToken: "cmd-icon-request-1",
          status: "pending",
          path: null,
        });
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a second request joins the active job", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const job = yield* claim(state, "cmd-icon-request-join-1");
        yield* apply(state, request("cmd-icon-request-join-2"));
        expect(discoveryOf(project(state))).toMatchObject({
          jobToken: job.jobToken,
          generation: job.generation,
          status: "running",
        });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "icon discovery fence: a repeat after no-match claims a new token and generation",
      () =>
        Effect.gen(function* () {
          const { state } = yield* fixture;
          const first = yield* claim(state, "cmd-icon-request-retry-1");
          yield* apply(state, complete(first, { status: "none", path: null, reason: "No mark." }));
          expect(discoveryOf(project(state))).toMatchObject({ status: "none", path: null });

          const second = yield* claim(state, "cmd-icon-request-retry-2");
          expect(second.jobToken).toBe("cmd-icon-request-retry-2");
          expect(second.generation).toBeGreaterThan(first.generation);
          yield* apply(state, complete(second, SELECTED));
          expect(project(state)?.faviconPath).toBe(SELECTED.path);
          expect(discoveryOf(project(state))).toMatchObject({ status: "selected" });
        }).pipe(Effect.scoped),
    );
  });

  describe("completion guard", () => {
    it.effect("icon discovery fence: a matching completion saves the image with its outcome", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const job = yield* claim(state, "cmd-icon-complete-match");
        const completed = yield* apply(state, complete(job, SELECTED));
        expect(completed.rejected).toBe(false);
        // The image and the outcome land from one decision, so one event carries both.
        expect(completed.rejected ? 0 : completed.events.length).toBe(1);
        expect(project(state)?.faviconPath).toBe(SELECTED.path);
        expect(discoveryOf(project(state))).toMatchObject({
          jobToken: job.jobToken,
          status: "selected",
          path: SELECTED.path,
          reason: SELECTED.reason,
        });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "icon discovery fence: a manual image chosen during a search survives its completion",
      () =>
        Effect.gen(function* () {
          const { state } = yield* fixture;
          const job = yield* claim(state, "cmd-icon-race-manual");
          yield* apply(state, {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-icon-race-manual-update"),
            projectId,
            faviconPath: "manual.svg",
          });
          yield* apply(state, complete(job, SELECTED));
          expect(project(state)?.faviconPath).toBe("manual.svg");
          expect(discoveryOf(project(state))?.status).toBe("superseded");
        }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a null-to-null reset during a search supersedes it", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const job = yield* claim(state, "cmd-icon-race-reset");
        yield* apply(state, {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-race-reset-update"),
          projectId,
          faviconPath: null,
          projectIcon: null,
        });
        expect(
          discoveryOf(project(state))?.generation,
          "a reset that changes no value still advances the generation",
        ).toBeGreaterThan(job.generation);
        yield* apply(state, complete(job, SELECTED));
        expect(project(state)?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project(state))?.status).toBe("superseded");
      }).pipe(Effect.scoped),
    );

    it.effect(
      "icon discovery fence: a manual write of the same path still supersedes a search",
      () =>
        Effect.gen(function* () {
          const { state } = yield* fixture;
          yield* apply(state, {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-icon-stale-saved"),
            projectId,
            faviconPath: "stale/missing.svg",
          });
          const job = yield* claim(state, "cmd-icon-race-same-path");
          yield* apply(state, {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-icon-race-same-path-update"),
            projectId,
            faviconPath: "stale/missing.svg",
          });
          yield* apply(state, complete(job, SELECTED));
          expect(project(state)?.faviconPath).toBe("stale/missing.svg");
          expect(discoveryOf(project(state))?.status).toBe("superseded");
        }).pipe(Effect.scoped),
    );

    it.effect(
      "icon discovery fence: a stale saved path is replaced when nothing else changed",
      () =>
        Effect.gen(function* () {
          const { state } = yield* fixture;
          yield* apply(state, {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-icon-stale-only"),
            projectId,
            faviconPath: "stale/missing.svg",
          });
          const job = yield* claim(state, "cmd-icon-stale-replace");
          yield* apply(state, complete(job, SELECTED));
          expect(project(state)?.faviconPath).toBe(SELECTED.path);
          expect(discoveryOf(project(state))?.status).toBe("selected");
        }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a moved project root supersedes a search", () =>
      Effect.gen(function* () {
        const { state, movedRoot } = yield* fixture;
        const job = yield* claim(state, "cmd-icon-race-root");
        yield* apply(state, {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-race-root-update"),
          projectId,
          workspaceRoot: movedRoot,
        });
        yield* apply(state, complete(job, SELECTED));
        expect(project(state)?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project(state))?.status).toBe("superseded");
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: an older token cannot complete over a newer job", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const first = yield* claim(state, "cmd-icon-old-token-1");
        yield* apply(state, {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-old-token-reset"),
          projectId,
          faviconPath: null,
        });
        const second = yield* claim(state, "cmd-icon-old-token-2");
        yield* apply(state, complete(first, SELECTED));
        expect(project(state)?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project(state))).toMatchObject({
          jobToken: second.jobToken,
          generation: second.generation,
          status: "running",
        });
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a deleted project keeps no completed image", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const job = yield* claim(state, "cmd-icon-race-delete");
        yield* apply(state, {
          type: "project.delete",
          commandId: CommandId.make("cmd-icon-race-delete-project"),
          projectId,
        });
        yield* apply(state, complete(job, SELECTED));
        expect(project(state)?.deletedAt).not.toBeNull();
        expect(project(state)?.faviconPath ?? null).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: an interrupted job ends without an image", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const job = yield* claim(state, "cmd-icon-interrupted");
        yield* apply(
          state,
          complete(job, { status: "interrupted", path: null, reason: "The server restarted." }),
        );
        expect(project(state)?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project(state))).toMatchObject({ status: "interrupted", path: null });
      }).pipe(Effect.scoped),
    );
  });

  describe("guards", () => {
    it.effect("icon discovery guard: a manual image saves with no discovery job", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const updated = yield* apply(state, {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-guard-manual"),
          projectId,
          faviconPath: "assets/logo.svg",
        });
        expect(updated.rejected).toBe(false);
        expect(project(state)?.faviconPath).toBe("assets/logo.svg");
        yield* apply(state, {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-guard-reset"),
          projectId,
          faviconPath: null,
          projectIcon: null,
        });
        expect(project(state)?.faviconPath ?? null).toBeNull();
        expect(project(state)?.projectIcon ?? null).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery guard: a title change leaves the saved image alone", () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        yield* apply(state, {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-guard-before-title"),
          projectId,
          faviconPath: "assets/logo.svg",
        });
        yield* apply(state, {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-guard-title"),
          projectId,
          title: "Renamed",
        });
        expect(project(state)?.faviconPath).toBe("assets/logo.svg");
      }).pipe(Effect.scoped),
    );
  });
});
