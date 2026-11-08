// Mesura: the agent icon search on the v2 project path. A completion saves its
// image only while its job token, generation, captured root and starting icon
// fields still hold; a manual write naming a stale root is refused.
import { describe, expect, it } from "@effect/vitest";
import {
  type ApplicationProjectEvent,
  CommandId,
  EventId,
  ProjectId,
  type ProjectIconDiscoveryState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import { MESURA_SCHEMA_STATEMENTS } from "../persistence/mesuraSchema.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  planProjectCommand,
  type ProjectCommand,
  type ProjectMetaUpdateCommand,
} from "./ProjectCommands.ts";
import * as ProjectStore from "./ProjectStore.ts";

const NOW = "2026-10-11T00:00:00.000Z";
const LATER = "2026-10-11T00:05:00.000Z";
const SELECTED = { status: "selected", path: "web/public/brand-logo.svg", reason: "Brand mark." };

/** The in-memory database already has the fork table; the DDL is idempotent. */
const ensureForkTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of MESURA_SCHEMA_STATEMENTS) yield* sql.unsafe(statement);
});

const testLayer = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

/**
 * One project, created through the planner. `dispatch` plans a command against
 * the stored rows and folds an accepted event into the store, as
 * `ProjectService.commit` does; a rejected command changes nothing.
 */
const fixture = Effect.fnUntraced(function* (name: string, options?: { readonly at?: string }) {
  yield* ensureForkTables;
  const store = yield* ProjectStore.ProjectStoreV2;
  const projectId = ProjectId.make(`project-icon-${name}`);
  const root = `/tmp/mesura-icon/${name}`;
  const movedRoot = `/tmp/mesura-icon/${name}-moved`;
  let sequence = 0;
  let now = DateTime.makeUnsafe(options?.at ?? NOW);

  const dispatch = Effect.fnUntraced(function* (command: ProjectCommand) {
    const project = Option.getOrUndefined(yield* store.get(projectId, { includeDeleted: true }));
    const workspaceRoot =
      command.type === "project.create" || command.type === "project.meta.update"
        ? command.workspaceRoot
        : undefined;
    const workspaceOwner =
      workspaceRoot === undefined
        ? undefined
        : Option.getOrUndefined(yield* store.findActiveByWorkspaceRoot(workspaceRoot));
    const planned = planProjectCommand({
      command,
      state: { project, workspaceOwner },
      eventId: EventId.make(`event:${command.commandId}`),
      now,
    });
    if (Result.isFailure(planned)) {
      return { rejected: true as const, error: planned.failure };
    }
    sequence += 1;
    yield* store.apply({ ...planned.success, sequence } as ApplicationProjectEvent);
    return { rejected: false as const, event: planned.success };
  });

  const project = store
    .get(projectId, { includeDeleted: true })
    .pipe(Effect.map(Option.getOrUndefined));
  const discovery = project.pipe(Effect.map((row) => row?.iconDiscovery ?? null));

  const created = yield* dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-${name}-create`),
    projectId,
    title: "Icon discovery",
    workspaceRoot: root,
  });
  expect(created.rejected).toBe(false);

  const update = (
    id: string,
    fields: Omit<ProjectMetaUpdateCommand, "type" | "commandId" | "projectId">,
  ) =>
    dispatch({ type: "project.meta.update", commandId: CommandId.make(id), projectId, ...fields });
  const request = (id: string) =>
    dispatch({ type: "project.icon-discovery.request", commandId: CommandId.make(id), projectId });
  const start = (jobToken: string) =>
    dispatch({
      type: "project.icon-discovery.start",
      commandId: CommandId.make(`${jobToken}:start`),
      projectId,
      jobToken: CommandId.make(jobToken),
    });
  const complete = (
    job: Pick<ProjectIconDiscoveryState, "jobToken" | "generation">,
    outcome: { readonly status: string; readonly path: string | null; readonly reason: string },
  ) =>
    dispatch({
      type: "project.icon-discovery.complete",
      commandId: CommandId.make(`${job.jobToken}:complete`),
      projectId,
      jobToken: job.jobToken,
      generation: job.generation,
      status: outcome.status as ProjectIconDiscoveryState["status"],
      path: outcome.path,
      reason: outcome.reason,
    });
  /** Requests and starts a job, returning the claim a worker would hold. */
  const claim = Effect.fnUntraced(function* (id: string) {
    const requested = yield* request(id);
    expect(requested.rejected, `request ${id} should be accepted`).toBe(false);
    const claimed = yield* discovery;
    expect(claimed, "a request records discovery state on the project").not.toBeNull();
    yield* start(claimed!.jobToken);
    return { jobToken: claimed!.jobToken, generation: claimed!.generation };
  });

  return {
    projectId,
    root,
    movedRoot,
    project,
    discovery,
    dispatch,
    update,
    request,
    start,
    complete,
    claim,
    setNow: (iso: string) => {
      now = DateTime.makeUnsafe(iso);
    },
  };
});

it.layer(testLayer)("project icon discovery on the v2 project planner", (it) => {
  describe("explicit requests", () => {
    it.effect("icon discovery fence: a request claims a pending job named by its command", () =>
      Effect.gen(function* () {
        const t = yield* fixture("request-claims");
        expect(yield* t.discovery, "a project starts with no discovery job").toBeNull();
        yield* t.request("cmd-icon-request-1");
        expect(yield* t.discovery).toMatchObject({
          jobToken: "cmd-icon-request-1",
          workspaceRoot: t.root,
          status: "pending",
          path: null,
        });
      }),
    );

    it.effect("icon discovery fence: a second request joins the active job", () =>
      Effect.gen(function* () {
        const t = yield* fixture("request-joins");
        const job = yield* t.claim("cmd-icon-request-join-1");
        const joined = yield* t.request("cmd-icon-request-join-2");
        expect(joined.rejected).toBe(false);
        expect(yield* t.discovery).toMatchObject({
          jobToken: job.jobToken,
          generation: job.generation,
          status: "running",
        });
      }),
    );

    it.effect(
      "icon discovery fence: a repeat after no-match claims a new token and generation",
      () =>
        Effect.gen(function* () {
          const t = yield* fixture("request-retry");
          const first = yield* t.claim("cmd-icon-request-retry-1");
          yield* t.complete(first, { status: "none", path: null, reason: "No mark." });
          expect(yield* t.discovery).toMatchObject({ status: "none", path: null });

          const second = yield* t.claim("cmd-icon-request-retry-2");
          expect(second.jobToken).toBe("cmd-icon-request-retry-2");
          expect(second.generation).toBeGreaterThan(first.generation);
          yield* t.complete(second, SELECTED);
          expect((yield* t.project)?.faviconPath).toBe(SELECTED.path);
          expect(yield* t.discovery).toMatchObject({ status: "selected" });
        }),
    );

    it.effect("icon discovery guard: a request for a deleted project is rejected", () =>
      Effect.gen(function* () {
        const t = yield* fixture("request-deleted");
        yield* t.dispatch({
          type: "project.delete",
          commandId: CommandId.make("cmd-icon-request-deleted-project"),
          projectId: t.projectId,
        });
        const requested = yield* t.request("cmd-icon-request-deleted");
        expect(requested.rejected).toBe(true);
        expect(requested.rejected ? requested.error._tag : null).toBe(
          "ProjectCommandMissingProjectError",
        );
        expect(yield* t.discovery).toBeNull();
      }),
    );

    it.effect("icon discovery guard: a search stage keeps the project's recency", () =>
      Effect.gen(function* () {
        const t = yield* fixture("recency");
        t.setNow(LATER);
        const job = yield* t.claim("cmd-icon-recency");
        yield* t.complete(job, SELECTED);
        const project = yield* t.project;
        expect(project?.updatedAt).toBe(NOW);
        expect(project?.iconDiscovery?.updatedAt).toBe(LATER);
      }),
    );
  });

  describe("completion guard", () => {
    it.effect("icon discovery fence: a matching completion saves the image with its outcome", () =>
      Effect.gen(function* () {
        const t = yield* fixture("complete-match");
        const job = yield* t.claim("cmd-icon-complete-match");
        const completed = yield* t.complete(job, SELECTED);
        expect(completed.rejected).toBe(false);
        // The image and the outcome land from one decision, so one event carries both.
        const payload = completed.rejected ? null : completed.event.payload;
        expect(payload).toMatchObject({
          faviconPath: SELECTED.path,
          iconDiscovery: { status: "selected" },
        });
        expect((yield* t.project)?.faviconPath).toBe(SELECTED.path);
        expect(yield* t.discovery).toMatchObject({
          jobToken: job.jobToken,
          status: "selected",
          path: SELECTED.path,
          reason: SELECTED.reason,
        });
      }),
    );

    it.effect(
      "icon discovery fence: a manual image chosen during a search survives its completion",
      () =>
        Effect.gen(function* () {
          const t = yield* fixture("race-manual");
          const job = yield* t.claim("cmd-icon-race-manual");
          yield* t.update("cmd-icon-race-manual-update", { faviconPath: "manual.svg" });
          yield* t.complete(job, SELECTED);
          expect((yield* t.project)?.faviconPath).toBe("manual.svg");
          expect((yield* t.discovery)?.status).toBe("superseded");
        }),
    );

    it.effect("icon discovery fence: a null-to-null reset during a search supersedes it", () =>
      Effect.gen(function* () {
        const t = yield* fixture("race-reset");
        const job = yield* t.claim("cmd-icon-race-reset");
        yield* t.update("cmd-icon-race-reset-update", { faviconPath: null, projectIcon: null });
        expect(
          (yield* t.discovery)?.generation,
          "a reset that changes no value still advances the generation",
        ).toBeGreaterThan(job.generation);
        yield* t.complete(job, SELECTED);
        expect((yield* t.project)?.faviconPath ?? null).toBeNull();
        expect((yield* t.discovery)?.status).toBe("superseded");
      }),
    );

    it.effect(
      "icon discovery fence: a manual write of the same path still supersedes a search",
      () =>
        Effect.gen(function* () {
          const t = yield* fixture("race-same-path");
          yield* t.update("cmd-icon-stale-saved", { faviconPath: "stale/missing.svg" });
          const job = yield* t.claim("cmd-icon-race-same-path");
          yield* t.update("cmd-icon-race-same-path-update", { faviconPath: "stale/missing.svg" });
          yield* t.complete(job, SELECTED);
          expect((yield* t.project)?.faviconPath).toBe("stale/missing.svg");
          expect((yield* t.discovery)?.status).toBe("superseded");
        }),
    );

    it.effect(
      "icon discovery fence: a stale saved path is replaced when nothing else changed",
      () =>
        Effect.gen(function* () {
          const t = yield* fixture("stale-replace");
          yield* t.update("cmd-icon-stale-only", { faviconPath: "stale/missing.svg" });
          const job = yield* t.claim("cmd-icon-stale-replace");
          yield* t.complete(job, SELECTED);
          expect((yield* t.project)?.faviconPath).toBe(SELECTED.path);
          expect((yield* t.discovery)?.status).toBe("selected");
        }),
    );

    it.effect("icon discovery fence: a moved project root supersedes a search", () =>
      Effect.gen(function* () {
        const t = yield* fixture("race-root");
        const job = yield* t.claim("cmd-icon-race-root");
        yield* t.update("cmd-icon-race-root-update", { workspaceRoot: t.movedRoot });
        yield* t.complete(job, SELECTED);
        expect((yield* t.project)?.faviconPath ?? null).toBeNull();
        expect((yield* t.discovery)?.status).toBe("superseded");
      }),
    );

    it.effect("icon discovery fence: an older token cannot complete over a newer job", () =>
      Effect.gen(function* () {
        const t = yield* fixture("old-token");
        const first = yield* t.claim("cmd-icon-old-token-1");
        yield* t.update("cmd-icon-old-token-reset", { faviconPath: null });
        const second = yield* t.claim("cmd-icon-old-token-2");
        yield* t.complete(first, SELECTED);
        expect((yield* t.project)?.faviconPath ?? null).toBeNull();
        expect(yield* t.discovery).toMatchObject({
          jobToken: second.jobToken,
          generation: second.generation,
          status: "running",
        });
      }),
    );

    it.effect("icon discovery fence: a deleted project keeps no completed image", () =>
      Effect.gen(function* () {
        const t = yield* fixture("race-delete");
        const job = yield* t.claim("cmd-icon-race-delete");
        yield* t.dispatch({
          type: "project.delete",
          commandId: CommandId.make("cmd-icon-race-delete-project"),
          projectId: t.projectId,
        });
        const completed = yield* t.complete(job, SELECTED);
        expect(completed.rejected, "the job still ends on a deleted project").toBe(false);
        const project = yield* t.project;
        expect(project?.deletedAt).not.toBeNull();
        expect(project?.faviconPath ?? null).toBeNull();
        expect((yield* t.discovery)?.status).toBe("superseded");
      }),
    );

    it.effect("icon discovery fence: an interrupted job ends without an image", () =>
      Effect.gen(function* () {
        const t = yield* fixture("interrupted");
        const job = yield* t.claim("cmd-icon-interrupted");
        yield* t.complete(job, {
          status: "interrupted",
          path: null,
          reason: "The server restarted.",
        });
        expect((yield* t.project)?.faviconPath ?? null).toBeNull();
        expect(yield* t.discovery).toMatchObject({ status: "interrupted", path: null });
      }),
    );
  });

  describe("guards", () => {
    it.effect("icon discovery guard: a manual image saves with no discovery job", () =>
      Effect.gen(function* () {
        const t = yield* fixture("guard-manual");
        const updated = yield* t.update("cmd-icon-guard-manual", {
          faviconPath: "assets/logo.svg",
        });
        expect(updated.rejected).toBe(false);
        expect((yield* t.project)?.faviconPath).toBe("assets/logo.svg");
        expect(yield* t.discovery, "a manual write starts no search").toBeNull();
        yield* t.update("cmd-icon-guard-reset", { faviconPath: null, projectIcon: null });
        const project = yield* t.project;
        expect(project?.faviconPath ?? null).toBeNull();
        expect(project?.projectIcon ?? null).toBeNull();
      }),
    );

    it.effect("icon discovery guard: a title change leaves the saved image alone", () =>
      Effect.gen(function* () {
        const t = yield* fixture("guard-title");
        yield* t.update("cmd-icon-guard-before-title", { faviconPath: "assets/logo.svg" });
        yield* t.update("cmd-icon-guard-title", { title: "Renamed" });
        expect((yield* t.project)?.faviconPath).toBe("assets/logo.svg");
      }),
    );
  });

  // A file-based icon write names the root it inspected; the planner refuses
  // it once the project has moved or was deleted.
  describe("expected workspace root", () => {
    it.effect("icon manual fence: an icon write for the old root is rejected after a move", () =>
      Effect.gen(function* () {
        const t = yield* fixture("root-stale-write");
        yield* t.update("cmd-icon-root-move", { workspaceRoot: t.movedRoot });
        const generation = (yield* t.discovery)?.generation ?? 0;
        const stale = yield* t.update("cmd-icon-root-stale-write", {
          faviconPath: ".mesura/project-icons/old-root.svg",
          projectIcon: null,
          expectedWorkspaceRoot: t.root,
        });
        expect(stale.rejected, "a write prepared against the old root must fail").toBe(true);
        const project = yield* t.project;
        expect(project?.faviconPath ?? null).toBeNull();
        expect(project?.workspaceRoot).toBe(t.movedRoot);
        expect((yield* t.discovery)?.generation ?? 0).toBe(generation);
      }),
    );

    it.effect("icon manual fence: a reset for the old root is rejected after a move", () =>
      Effect.gen(function* () {
        const t = yield* fixture("root-stale-reset");
        yield* t.update("cmd-icon-root-reset-before", { faviconPath: "assets/logo.svg" });
        yield* t.update("cmd-icon-root-reset-move", { workspaceRoot: t.movedRoot });
        const stale = yield* t.update("cmd-icon-root-reset-stale", {
          faviconPath: null,
          projectIcon: null,
          expectedWorkspaceRoot: t.root,
        });
        expect(stale.rejected).toBe(true);
        expect((yield* t.project)?.faviconPath).toBe("assets/logo.svg");
      }),
    );

    it.effect("icon manual guard: a write naming the current root saves the image", () =>
      Effect.gen(function* () {
        const t = yield* fixture("root-current");
        const updated = yield* t.update("cmd-icon-root-current", {
          faviconPath: ".mesura/project-icons/current.svg",
          projectIcon: null,
          expectedWorkspaceRoot: t.root,
        });
        expect(updated.rejected).toBe(false);
        expect((yield* t.project)?.faviconPath).toBe(".mesura/project-icons/current.svg");
      }),
    );

    it.effect(
      "icon manual guard: a guarded null-to-null reset still supersedes a running search",
      () =>
        Effect.gen(function* () {
          const t = yield* fixture("root-guarded-reset");
          const job = yield* t.claim("cmd-icon-root-guarded-reset");
          const reset = yield* t.update("cmd-icon-root-guarded-reset-update", {
            faviconPath: null,
            projectIcon: null,
            expectedWorkspaceRoot: t.root,
          });
          expect(reset.rejected).toBe(false);
          expect((yield* t.discovery)?.generation).toBeGreaterThan(job.generation);
          yield* t.complete(job, SELECTED);
          expect((yield* t.project)?.faviconPath ?? null).toBeNull();
          expect((yield* t.discovery)?.status).toBe("superseded");
        }),
    );

    it.effect("icon manual fence: an icon write for a deleted project is rejected", () =>
      Effect.gen(function* () {
        const t = yield* fixture("root-deleted");
        yield* t.dispatch({
          type: "project.delete",
          commandId: CommandId.make("cmd-icon-root-delete"),
          projectId: t.projectId,
        });
        const write = yield* t.update("cmd-icon-root-deleted-write", {
          faviconPath: ".mesura/project-icons/deleted.svg",
          projectIcon: null,
          expectedWorkspaceRoot: t.root,
        });
        expect(write.rejected).toBe(true);
      }),
    );
  });

  // The search state lives in the fork table `mesura_project_icon_discovery`,
  // not in `projection_projects`; the store reads it back onto rows and shells.
  describe("ProjectStoreV2 round trip", () => {
    it.effect("icon discovery store: state written by apply reads back on rows and shells", () =>
      Effect.gen(function* () {
        const t = yield* fixture("store-round-trip");
        const store = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const stored = () =>
          sql<{ readonly stateJson: string }>`
            SELECT state_json AS "stateJson"
            FROM mesura_project_icon_discovery
            WHERE project_id = ${t.projectId}
          `;

        expect(yield* stored(), "no row before a search").toHaveLength(0);
        expect(Option.getOrNull(yield* store.getShell(t.projectId))?.iconDiscovery).toBeNull();

        yield* t.request("cmd-icon-store-request");
        const state = yield* t.discovery;
        expect(state).toMatchObject({ jobToken: "cmd-icon-store-request", status: "pending" });
        const rows = yield* stored();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.stateJson)).toMatchObject({
          jobToken: "cmd-icon-store-request",
          generation: state!.generation,
          workspaceRoot: t.root,
        });
        expect(Option.getOrNull(yield* store.getShell(t.projectId))?.iconDiscovery).toEqual(state);
        const shells = yield* store.listShells({ projectIds: [t.projectId] });
        expect(shells[0]?.iconDiscovery).toEqual(state);

        // An event without the field leaves the stored search alone.
        yield* t.update("cmd-icon-store-title", { title: "Renamed" });
        expect(yield* t.discovery).toEqual(state);

        // An explicit null clears the row.
        yield* store.apply({
          sequence: 100,
          eventId: EventId.make("event-icon-store-clear"),
          aggregateKind: "project",
          aggregateId: t.projectId,
          occurredAt: NOW,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.meta-updated",
          payload: { projectId: t.projectId, iconDiscovery: null, updatedAt: NOW },
        });
        expect(yield* stored()).toHaveLength(0);
        expect(yield* t.discovery).toBeNull();
      }),
    );
  });
});
