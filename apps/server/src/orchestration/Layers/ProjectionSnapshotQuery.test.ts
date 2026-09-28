import {
  type AgentSessionImportSource,
  ChatAttachment,
  ComposerContextId,
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type ThreadPullRequestLink,
  ThreadLinkedPullRequest,
  TurnId,
  ProviderInstanceId,
  OrchestrationMessageContext,
  type OrchestrationThreadActivity,
  THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE,
  THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
  THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE,
  THREAD_SEARCH_TITLE_MAX_LENGTH,
  THREAD_SEARCH_CURSOR_MAX_LENGTH,
  OrchestrationThreadSearchCatalogPage,
  OrchestrationThreadSearchEvidencePage,
  type OrchestrationThreadSearchEvidence,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  enrichContextCompactionActivityDetails,
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_SEARCH_EVIDENCE_SCAN_BUDGET,
} from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { encodeThreadDetailPageCursor } from "../threadDetailCursor.ts";
import { projectThreadDetailSnapshot } from "../ActivityPayloadProjection.ts";
import { makeSqlStatementCounter } from "../../../integration/SqlStatementCounter.integration.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);
const encodeChatAttachments = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ChatAttachment)),
);
const encodeThreadLinkedPullRequest = Schema.encodeSync(
  Schema.fromJsonString(ThreadLinkedPullRequest),
);
const encodeMessageContext = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationMessageContext),
);

it.effect("reads project shells without loading threads or resolving excluded projects", () => {
  const resolved: string[] = [];
  const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (root) =>
          Effect.sync(() => {
            resolved.push(root);
            return null;
          }),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
      VALUES
      ('p1', 'First', '/first', '[]', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', NULL),
      ('p2', 'Second', '/second', '[]', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', NULL),
      ('p3', 'Deleted', '/deleted', '[]', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', '2026-09-04T00:00:00Z')`;
    const expected = (yield* query.getShellSnapshot()).projects;
    resolved.length = 0;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('t1', 'p1', 'Thread', 'invalid-json', 'full-access', 'default', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;

    const counter = makeSqlStatementCounter();
    const projects = yield* query.getProjectShells().pipe(Effect.withTracer(counter.tracer));
    assert.deepStrictEqual(projects, expected);
    assert.strictEqual(counter.count(), 1);
    assert.deepStrictEqual(resolved.toSorted(), ["/first", "/second"]);
    resolved.length = 0;
    yield* sql`UPDATE projection_projects SET scripts_json = 'invalid-json' WHERE project_id IN ('p1', 'p3')`;
    assert.deepStrictEqual(yield* query.getProjectShells([asProjectId("p2")]), [expected[1]!]);
    assert.deepStrictEqual(resolved, ["/second"]);
    resolved.length = 0;
    const beforeEmpty = counter.count();
    assert.deepStrictEqual(
      yield* query.getProjectShells([]).pipe(Effect.withTracer(counter.tracer)),
      [],
    );
    assert.strictEqual(counter.count(), beforeEmpty);
    assert.deepStrictEqual(yield* query.getProjectShells([asProjectId("p3")]), []);
    assert.deepStrictEqual(resolved, []);
  }).pipe(Effect.provide(layer));
});

it("enriches historical compaction rows from persisted context snapshots", () => {
  const activities = [
    {
      id: asEventId("unrelated"),
      tone: "info",
      kind: "tool.completed",
      summary: "Unrelated activity",
      payload: { status: "completed" },
      turnId: null,
      sequence: 36,
      createdAt: "2026-08-22T17:44:20.000Z",
    },
    {
      id: asEventId("context-before"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      turnId: null,
      sequence: 37,
      createdAt: "2026-08-22T17:44:27.990Z",
      payload: { usedTokens: 26_826 },
    },
    {
      id: asEventId("context-after"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      turnId: null,
      sequence: 45,
      createdAt: "2026-08-22T17:44:43.614Z",
      payload: { usedTokens: 4_707 },
    },
    {
      id: asEventId("context-compaction"),
      tone: "info",
      kind: "context-compaction",
      summary: "Context compacted",
      turnId: null,
      sequence: 46,
      createdAt: "2026-08-22T17:44:43.615Z",
      payload: {},
    },
  ] satisfies ReadonlyArray<OrchestrationThreadActivity>;

  const enriched = enrichContextCompactionActivityDetails(activities);
  assert.strictEqual(enriched[0], activities[0]);
  assert.equal(
    (enriched[3]?.payload as { detail?: string } | undefined)?.detail,
    "The provider did not expose the compaction summary for this earlier event.\n\n" +
      "Compaction details\n" +
      "Before: 26,826 tokens\n" +
      "After: 4,707 tokens\n" +
      "Reduced: 22,119 tokens (82%)",
  );
});

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const branchPullRequest = {
        projectId: asProjectId("project-1"),
        repository: "pingdotgg/t3code",
        number: 43,
        url: "https://github.com/pingdotgg/t3code/pull/43",
      };

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_pull_requests`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      // A merged link plus a newer open one: the multi-link projection must
      // resolve to the open pull request, not the stale JSON column below.
      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id,
          host,
          repository,
          number,
          url,
          source,
          linked_at,
          snapshot_json,
          stack_json
        )
        VALUES
          (
            'thread-1',
            'github.com',
            'pingdotgg/t3code',
            41,
            'https://github.com/pingdotgg/t3code/pull/41',
            'created',
            '2026-02-24T00:00:02.500Z',
            '{"state":"merged","title":"Groundwork","headBranch":"feat/groundwork","baseBranch":"main","isDraft":false,"updatedAt":"2026-02-24T00:00:02.600Z","syncedAt":"2026-02-24T00:00:02.700Z"}',
            NULL
          ),
          (
            'thread-1',
            'github.com',
            'pingdotgg/t3code',
            42,
            'https://github.com/pingdotgg/t3code/pull/42',
            'manual',
            '2026-02-24T00:00:03.000Z',
            NULL,
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          linked_pull_request_json,
          branch_pull_request_json,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          pinned_at,
          pin_order_key,
          active_order_key,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '{"projectId":"project-1","repository":"pingdotgg/t3code","number":41,"url":"https://github.com/pingdotgg/t3code/pull/41"}',
          ${encodeThreadLinkedPullRequest(branchPullRequest)},
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:01.000Z',
          'gm',
          'hq',
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const expectedPullRequests: ReadonlyArray<ThreadPullRequestLink> = [
        {
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 41,
          url: "https://github.com/pingdotgg/t3code/pull/41",
          source: "created",
          linkedAt: "2026-02-24T00:00:02.500Z",
          snapshot: {
            state: "merged",
            title: "Groundwork",
            headBranch: "feat/groundwork",
            baseBranch: "main",
            isDraft: false,
            updatedAt: "2026-02-24T00:00:02.600Z",
            syncedAt: "2026-02-24T00:00:02.700Z",
          },
          stack: null,
        },
        {
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 42,
          url: "https://github.com/pingdotgg/t3code/pull/42",
          source: "manual",
          linkedAt: "2026-02-24T00:00:03.000Z",
          snapshot: null,
          stack: null,
        },
      ];

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          defaultThreadEnvMode: null,
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          pullRequests: expectedPullRequests,
          branchPullRequest,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            userMessageId: null,
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: "2026-02-24T00:00:01.000Z",
          pinOrderKey: "gm",
          activeOrderKey: "hq",
          titleRegeneration: null,
          titleState: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          defaultThreadEnvMode: null,
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          pullRequests: expectedPullRequests,
          branchPullRequest,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            userMessageId: null,
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: "2026-02-24T00:00:01.000Z",
          pinOrderKey: "gm",
          activeOrderKey: "hq",
          titleRegeneration: null,
          titleState: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          backgroundLiveness: null,
          planProgress: null,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.deepEqual(threadShell.value, shellSnapshot.threads[0]);
      }

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.deepEqual(commandReadModel.threads[0]?.pullRequests, expectedPullRequests);
      assert.deepEqual(
        commandReadModel.threads[0]?.linkedPullRequest,
        snapshot.threads[0]?.linkedPullRequest,
      );

      // Without link rows the legacy field is omitted, whatever the old JSON
      // column still holds.
      yield* sql`DELETE FROM projection_thread_pull_requests`;
      const unlinkedShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(unlinkedShell._tag, "Some");
      if (unlinkedShell._tag === "Some") {
        assert.deepEqual(unlinkedShell.value.pullRequests, []);
        assert.equal("linkedPullRequest" in unlinkedShell.value, false);
      }

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-task-started',
            'thread-1',
            'turn-1',
            'info',
            'task.started',
            'Ship the query filter',
            '{"taskId":"task-1","detail":"Ship the query filter"}',
            '2026-02-24T00:00:06.100Z'
          ),
          (
            'activity-malformed-tool',
            'thread-1',
            'turn-1',
            'info',
            'tool.completed',
            'Malformed tool output',
            'not-json',
            '2026-02-24T00:00:06.200Z'
          )
      `;

      const detailWithoutActivities = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-1"),
        { activityKinds: [] },
      );
      assert.equal(detailWithoutActivities._tag, "Some");
      if (detailWithoutActivities._tag === "Some") {
        assert.equal(detailWithoutActivities.value.activeOrderKey, "hq");
        assert.deepEqual(detailWithoutActivities.value.activities, []);
        assert.deepEqual(detailWithoutActivities.value.messages, snapshot.threads[0]?.messages);
        assert.deepEqual(
          detailWithoutActivities.value.proposedPlans,
          snapshot.threads[0]?.proposedPlans,
        );
        assert.deepEqual(
          detailWithoutActivities.value.checkpoints,
          snapshot.threads[0]?.checkpoints,
        );
      }

      const detailWithTaskActivities = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-1"),
        { activityKinds: ["task.started", "task.progress"] },
      );
      assert.equal(detailWithTaskActivities._tag, "Some");
      if (detailWithTaskActivities._tag === "Some") {
        assert.deepEqual(detailWithTaskActivities.value.activities, [
          {
            id: asEventId("activity-task-started"),
            tone: "info",
            kind: "task.started",
            summary: "Ship the query filter",
            payload: { taskId: "task-1", detail: "Ship the query filter" },
            turnId: asTurnId("turn-1"),
            createdAt: "2026-02-24T00:00:06.100Z",
          },
        ]);
      }

      const counter = makeSqlStatementCounter();
      const context = yield* snapshotQuery
        .getThreadRuntimeContext(ThreadId.make("thread-1"))
        .pipe(Effect.withTracer(counter.tracer));
      assert.equal(counter.count(), 1);
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          titleState: null,
          session: snapshot.threads[0]?.session ?? null,
        });
      }

      yield* sql`
        UPDATE projection_thread_sessions
        SET status = 'starting', active_turn_id = NULL, provider_name = 'claudeAgent',
            provider_instance_id = 'claude-secondary', last_error = 'Starting another session'
        WHERE thread_id = 'thread-1'
      `;
      const changedContext = yield* snapshotQuery.getThreadRuntimeContext(
        ThreadId.make("thread-1"),
      );
      assert.equal(changedContext._tag, "Some");
      if (changedContext._tag === "Some") {
        assert.equal(changedContext.value.session?.status, "starting");
        assert.equal(changedContext.value.session?.activeTurnId, null);
        assert.equal(changedContext.value.session?.providerName, "claudeAgent");
        assert.equal(changedContext.value.session?.providerInstanceId, "claude-secondary");
        assert.equal(changedContext.value.session?.lastError, "Starting another session");
      }
    }),
  );

  it.effect("reads one turn-start message without decoding unrelated history", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-turn-start-read");
      const messageId = MessageId.make("message-turn-start-read");
      const createdAt = "2026-09-05T00:00:00.000Z";
      const attachments = [
        {
          type: "file" as const,
          id: "notes",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        },
      ];
      const attachmentsJson = yield* encodeChatAttachments(attachments);
      const messageContext: OrchestrationMessageContext = {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("notes-context"),
            kind: "file",
            label: "notes.txt",
            attachmentId: "notes",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 8,
          },
        ],
      };
      const contextJson = yield* encodeMessageContext(messageContext);
      yield* sql`
        WITH RECURSIVE history(n) AS (
          VALUES (1) UNION ALL SELECT n + 1 FROM history WHERE n < 2000
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json, context_json,
          is_streaming, created_at, updated_at
        )
        SELECT 'turn-start-history:' || n, ${threadId}, 'old-turn:' || n, 'assistant',
          'Unrelated assistant output', 'not-json', 'not-json', 0, ${createdAt}, ${createdAt}
        FROM history
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, context_json, is_streaming, created_at, updated_at
        ) VALUES (${messageId}, ${threadId}, 'user', 'Read these notes',
          ${attachmentsJson}, ${contextJson}, 0, ${createdAt}, ${createdAt})
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('turn-start-unrelated-user', 'thread-turn-start-unrelated', 'user', 'Unrelated prompt',
          'not-json', 0, ${createdAt}, ${createdAt})
      `;

      const counter = makeSqlStatementCounter();
      const context = yield* query
        .getTurnStartMessage({ threadId, messageId })
        .pipe(Effect.withTracer(counter.tracer));
      assert.equal(counter.count(), 1);
      assert.deepEqual(
        context,
        Option.some({
          message: {
            id: messageId,
            role: "user",
            text: "Read these notes",
            turnId: null,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
            attachments,
            context: messageContext,
          },
          hasOtherUserMessages: false,
        }),
      );
      assert.equal(
        (yield* query.getTurnStartMessage({
          threadId: ThreadId.make("thread-turn-start-unrelated"),
          messageId,
        }))._tag,
        "None",
      );
      assert.equal(
        (yield* query.getTurnStartMessage({ threadId, messageId: MessageId.make("missing") }))._tag,
        "None",
      );
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            DELETE FROM projection_thread_messages
            WHERE thread_id IN ('thread-turn-start-read', 'thread-turn-start-unrelated')
          `;
        }).pipe(Effect.orDie),
      ),
    ),
  );

  it.effect("keeps compaction and queued-message eligibility in the turn-start query", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-turn-start-eligibility");
      const messageId = MessageId.make("message-turn-start-eligibility");
      const createdAt = "2026-09-05T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${messageId}, ${threadId}, 'user', 'Start a turn', 0, ${createdAt}, ${createdAt})
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('turn-start-other-user', ${threadId}, 'user', '/compact', NULL, 0,
          '2026-09-05T00:00:01.000Z', '2026-09-05T00:00:01.000Z')
      `;

      for (const { text, attachments, hasOtherUserMessages } of [
        { text: "/compact", attachments: null, hasOtherUserMessages: false },
        {
          text: "\t\n\r /CoMpAcT\u00a0\u2028\ufeff",
          attachments: "[ ]",
          hasOtherUserMessages: false,
        },
        { text: "/compact keep recent errors", attachments: "[]", hasOtherUserMessages: true },
        { text: "", attachments: null, hasOtherUserMessages: true },
        { text: "Queued prompt", attachments: null, hasOtherUserMessages: true },
        {
          text: "/compact",
          attachments:
            '[{"type":"file","id":"notes","name":"notes.txt","mimeType":"text/plain","sizeBytes":8}]',
          hasOtherUserMessages: true,
        },
      ]) {
        yield* sql`
          UPDATE projection_thread_messages SET text = ${text}, attachments_json = ${attachments}
          WHERE message_id = 'turn-start-other-user'
        `;
        const context = yield* query.getTurnStartMessage({ threadId, messageId });
        assert.equal(context._tag, "Some");
        if (context._tag === "Some") {
          assert.equal(context.value.hasOtherUserMessages, hasOtherUserMessages);
        }
      }
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const branchPullRequest = {
        projectId: asProjectId("project-archive-test"),
        repository: "pingdotgg/t3code",
        number: 43,
        url: "https://github.com/pingdotgg/t3code/pull/43",
      };

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );
      assert.equal(shellSnapshot.threads[0]?.branchPullRequest, null);

      yield* sql`
        UPDATE projection_threads
        SET branch_pull_request_json = ${encodeThreadLinkedPullRequest(branchPullRequest)}
        WHERE thread_id = 'thread-archived'
      `;

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
      assert.deepEqual(archivedShellSnapshot.threads[0]?.branchPullRequest, branchPullRequest);
      const activeContext = yield* snapshotQuery.getThreadRuntimeContext(
        ThreadId.make("thread-active"),
      );
      assert.equal(activeContext._tag, "Some");
      if (activeContext._tag === "Some") assert.equal(activeContext.value.session, null);
      for (const threadId of ["thread-archived", "thread-missing"]) {
        assert.equal(
          (yield* snapshotQuery.getThreadRuntimeContext(ThreadId.make(threadId)))._tag,
          "None",
        );
      }
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-04-06T00:00:08.000Z' WHERE thread_id = 'thread-active'`;
      assert.equal(
        (yield* snapshotQuery.getThreadRuntimeContext(ThreadId.make("thread-active")))._tag,
        "None",
      );
    }),
  );

  it.effect("keeps settled threads in the shell snapshot with non-null settlement fields", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-settled-test',
          'Settled Test',
          '/tmp/settled-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES (
          'thread-settled',
          'project-settled-test',
          'Settled Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-06T00:00:02.000Z',
          '2026-04-06T00:00:05.000Z',
          NULL,
          'settled',
          '2026-04-06T00:00:04.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      // Settled ≠ archived: the thread must appear in the LIVE shell
      // snapshot, carrying its settlement fields through the row aliases.
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-settled")],
      );
      assert.equal(shellSnapshot.threads[0]?.settledOverride, "settled");
      assert.equal(shellSnapshot.threads[0]?.settledAt, "2026-04-06T00:00:04.000Z");

      // And the full command read model carries them too.
      const readModel = yield* snapshotQuery.getCommandReadModel();
      const thread = readModel.threads.find(
        (candidate) => candidate.id === ThreadId.make("thread-settled"),
      );
      assert.equal(thread?.settledOverride, "settled");
      assert.equal(thread?.settledAt, "2026-04-06T00:00:04.000Z");
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("measures replay payload bytes without decoding event bodies", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES
          (
            'replay-event-1', 'thread', 'thread-replay', 1, 'thread.activity-appended',
            '2026-03-01T00:00:00.000Z', NULL, NULL, NULL, 'provider',
            json_object('output', printf('%.*c', 1000, 'x')), '{}'
          ),
          (
            'replay-event-2', 'thread', 'thread-replay', 2, 'thread.activity-appended',
            '2026-03-01T00:00:01.000Z', NULL, NULL, NULL, 'provider',
            json_object('output', printf('%.*c', 2000, 'x')), '{}'
          ),
          (
            'replay-event-3', 'thread', 'thread-replay', 3, 'thread.activity-appended',
            '2026-03-01T00:00:02.000Z', NULL, NULL, NULL, 'provider',
            json_object('output', printf('%.*c', 3000, 'x')), '{}'
          ),
          (
            'replay-event-4', 'thread', 'thread-replay', 4, 'thread.activity-appended',
            '2026-03-01T00:00:03.000Z', NULL, NULL, NULL, 'provider',
            json_object('output', '😀'), '{}'
          )
      `;

      // Bytes, not code points: the 4-byte emoji row is {"output":"😀"}, 17 bytes.
      const stats = yield* snapshotQuery.getEventReplayStats({
        fromSequenceExclusive: 1,
        toSequenceInclusive: 4,
      });
      assert.deepStrictEqual(stats, {
        eventCount: 3,
        payloadBytes: 5043,
      });
    }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.userMessageId, "message-user-2");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.userMessageId, "message-user-2");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );

  it.effect("searches active user messages and canonical assistant outputs", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-search',
          'Project Needle',
          '/tmp/project-search',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-search',
            'Literal 100% fix',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'search-branch',
            NULL,
            'turn-active',
            '2026-05-01T00:00:02.000Z',
            0,
            0,
            0,
            '2026-05-01T00:00:02.000Z',
            '2026-05-01T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-percent-decoy',
            'project-search',
            'Literal 100x fix',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-05-01T00:00:04.000Z',
            '2026-05-01T00:00:05.000Z',
            NULL,
            NULL
          ),
          (
            'thread-hidden',
            'project-search',
            'Archived search',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-05-01T00:00:06.000Z',
            '2026-05-01T00:00:07.000Z',
            '2026-05-01T00:00:08.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-user',
            'thread-active',
            'turn-active',
            'user',
            'Please find this USER needle in an old prompt.',
            0,
            '2026-05-01T00:00:12.000Z',
            '2026-05-01T00:00:12.000Z'
          ),
          (
            'message-percent',
            'thread-active',
            NULL,
            'user',
            'Literal 100% fix in a prompt.',
            0,
            '2026-05-01T00:00:11.000Z',
            '2026-05-01T00:00:11.000Z'
          ),
          (
            'message-percent-decoy',
            'thread-percent-decoy',
            NULL,
            'user',
            'Literal 100x fix in a prompt.',
            0,
            '2026-05-01T00:00:11.000Z',
            '2026-05-01T00:00:11.000Z'
          ),
          (
            'message-final',
            'thread-active',
            'turn-active',
            'assistant',
            'The canonical final needle appears in this completed answer.',
            0,
            '2026-05-01T00:00:13.000Z',
            '2026-05-01T00:00:13.000Z'
          ),
          (
            'message-interim',
            'thread-active',
            'turn-active',
            'assistant',
            'Interim needle must not be searchable.',
            0,
            '2026-05-01T00:00:14.000Z',
            '2026-05-01T00:00:14.000Z'
          ),
          (
            'message-system',
            'thread-active',
            NULL,
            'system',
            'System needle must not be searchable.',
            0,
            '2026-05-01T00:00:15.000Z',
            '2026-05-01T00:00:15.000Z'
          ),
          (
            'message-hidden',
            'thread-hidden',
            NULL,
            'user',
            'Hidden needle in archive.',
            0,
            '2026-05-01T00:00:16.000Z',
            '2026-05-01T00:00:16.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES (
          'thread-active',
          'turn-active',
          'message-user',
          'message-final',
          'completed',
          '2026-05-01T00:00:12.000Z',
          '2026-05-01T00:00:12.000Z',
          '2026-05-01T00:00:13.000Z',
          '[]'
        )
      `;

      const literalPercent = yield* snapshotQuery.searchThreads({ query: "100%" });
      assert.deepStrictEqual(
        literalPercent.matches.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-active"), "user"]],
      );

      const user = yield* snapshotQuery.searchThreads({ query: "user needle" });
      assert.equal(user.matches[0]?.source, "user");
      assert.match(user.matches[0]?.snippet ?? "", /USER needle/);

      const assistant = yield* snapshotQuery.searchThreads({ query: "FINAL NEEDLE" });
      assert.equal(assistant.matches[0]?.source, "assistant");

      const deduped = yield* snapshotQuery.searchThreads({ query: "needle" });
      assert.deepStrictEqual(
        deduped.matches.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-active"), "user"]],
      );

      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "interim needle" })).matches,
        [],
      );
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "system needle" })).matches,
        [],
      );
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "hidden needle" })).matches,
        [],
      );
      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-05-01T00:00:20.000Z'
        WHERE thread_id = 'thread-active'
      `;
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "user needle" })).matches,
        [],
      );
    }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 2);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);

projectionSnapshotLayer("ProjectionSnapshotQuery windowed thread detail", (it) => {
  // A thread shaped like real fan-out usage: user turns interleaved with
  // subagent turns (no user pending message), plus a turnless straggler user
  // message and a turnless activity anchored between turns.
  //
  //   row  turn      pending msg        anchor (requested_at)
  //   1    turn-1    user-msg-1         T00
  //   2    turn-2    (subagent)         T01
  //   3    turn-3    (subagent)         T02
  //   4    turn-4    user-msg-4         T03
  //   5    turn-5    user-msg-5         T04
  //
  // Straggler user message at T03.5 (turn_id NULL, not any pending_message_id)
  // and a turnless activity at T03.6 — both belong to the page containing T03+.
  const seedFanOutThread = Effect.fnUntraced(function* (options?: {
    readonly importedMessageCount?: number;
  }) {
    const sql = yield* SqlClient.SqlClient;

    // Tests in this block share one in-memory database; reset before seeding.
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_state`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES ('project-w', 'Windowed', '/tmp/project-w', '[]',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        latest_turn_id, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, created_at, updated_at, deleted_at
      )
      VALUES ('thread-w', 'project-w', 'Windowed thread',
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
        'turn-5', 0, 0, 0, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:10.000Z', NULL)
    `;

    if (options?.importedMessageCount) {
      for (let index = 0; index < options.importedMessageCount; index += 1) {
        const messageId = `import:codex:session-w:${String(index).padStart(6, "0")}`;
        const role = index % 2 === 0 ? "user" : "assistant";
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          )
          VALUES (${messageId}, 'thread-w', NULL, ${role}, ${"imported message " + index}, 0,
            '2026-02-28T00:00:00.000Z', '2026-02-28T00:00:00.000Z')
        `;
      }
    }

    const turns: ReadonlyArray<{
      turn: string;
      pendingMessage: string | null;
      at: string;
    }> = [
      { turn: "turn-1", pendingMessage: "user-msg-1", at: "2026-03-01T00:00:00.000Z" },
      { turn: "turn-2", pendingMessage: null, at: "2026-03-01T00:01:00.000Z" },
      { turn: "turn-3", pendingMessage: null, at: "2026-03-01T00:02:00.000Z" },
      { turn: "turn-4", pendingMessage: "user-msg-4", at: "2026-03-01T00:03:00.000Z" },
      { turn: "turn-5", pendingMessage: "user-msg-5", at: "2026-03-01T00:04:00.000Z" },
    ];
    for (const { turn, pendingMessage, at } of turns) {
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
          checkpoint_files_json
        )
        VALUES ('thread-w', ${turn}, ${pendingMessage}, 'completed', ${at}, ${at}, ${at}, '[]')
      `;
      if (pendingMessage !== null) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          )
          VALUES (${pendingMessage}, 'thread-w', NULL, 'user', ${"prompt for " + turn}, 0, ${at}, ${at})
        `;
      }
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES (${turn + "-reply"}, 'thread-w', ${turn}, 'assistant', ${"reply from " + turn}, 0, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        )
        VALUES (${turn + "-activity"}, 'thread-w', ${turn}, 'tool', 'tool.completed',
          'ran tool', '{"ok":true}', ${at})
      `;
    }

    // Straggler user message sent while turn-4 ran: turn_id NULL and not any
    // turn's pending_message_id.
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES ('user-msg-straggler', 'thread-w', NULL, 'user', 'while you are at it',
        0, '2026-03-01T00:03:30.000Z', '2026-03-01T00:03:30.000Z')
    `;
    // Turnless activity in the same time range.
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      )
      VALUES ('turnless-activity', 'thread-w', NULL, 'info', 'context-window.updated',
        'usage', '{"usedTokens":1}', '2026-03-01T00:03:36.000Z')
    `;

    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projector}, 42, '2026-03-01T00:00:10.000Z')
      `;
    }
  });

  const threadW = ThreadId.make("thread-w");
  const messageIds = (snapshot: { thread: { messages: ReadonlyArray<{ id: string }> } }) =>
    snapshot.thread.messages.map((message) => message.id).toSorted();
  const activityIds = (snapshot: { thread: { activities: ReadonlyArray<{ id: string }> } }) =>
    snapshot.thread.activities.map((activity) => activity.id).toSorted();

  it.effect("returns the full thread with no page metadata when no window is requested", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW);
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.equal(snapshot.value.page, undefined);
        assert.equal(snapshot.value.thread.messages.length, 9);
        assert.equal(snapshot.value.thread.activities.length, 6);
        assert.equal(snapshot.value.snapshotSequence, 42);
      }
    }),
  );

  it.effect("windows to the last N user-anchored turns with subagent turns riding along", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // turnLimit 2 walks back: turn-5 (user), turn-4 (user) -> window is
      // rows 4..5. Subagent turns 2-3 are older than the 2nd user turn and
      // stay out; the straggler message and turnless activity (T03.5/T03.6,
      // after turn-4's anchor) ride along.
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.deepEqual(messageIds(snapshot.value), [
          "turn-4-reply",
          "turn-5-reply",
          "user-msg-4",
          "user-msg-5",
          "user-msg-straggler",
        ]);
        assert.deepEqual(activityIds(snapshot.value), [
          "turn-4-activity",
          "turn-5-activity",
          "turnless-activity",
        ]);
        assert.equal(snapshot.value.page?.hasMore, true);
        assert.notEqual(snapshot.value.page?.beforeCursor, null);
        assert.equal(snapshot.value.page?.snapshotSequence, 42);
      }
    }),
  );

  it.effect("subagent turns between user turns ride along inside the window", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // turnLimit 3 reaches user turn-1, dragging subagent turns 2-3 along:
      // the full thread, so no further pages.
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 3 });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.equal(snapshot.value.thread.messages.length, 9);
        assert.equal(snapshot.value.thread.activities.length, 6);
        assert.equal(snapshot.value.page?.hasMore, false);
        assert.equal(snapshot.value.page?.beforeCursor, null);
      }
    }),
  );

  it.effect("cursors survive a projection rewrite that reassigns turn row ids", () =>
    Effect.gen(function* () {
      // The revert projector (and any projection rebuild) deletes and
      // re-upserts projection_turns, assigning fresh autoincrement row ids.
      // The keyset cursor is derived from event content, so a page cursor
      // minted before the rewrite must keep working after it.
      yield* seedFanOutThread();
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");
      if (firstPage._tag !== "Some") return;
      const cursor = firstPage.value.page?.beforeCursor;
      assert.notEqual(cursor, null);
      if (cursor === null || cursor === undefined) return;

      // Simulate the rewrite: delete and re-insert every turn row with the
      // same content, which reassigns all row ids.
      const turnRows = yield* sql`
        SELECT thread_id, turn_id, pending_message_id, state, requested_at, started_at,
          completed_at, checkpoint_files_json
        FROM projection_turns WHERE thread_id = 'thread-w' ORDER BY row_id
      `;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = 'thread-w'`;
      for (const row of turnRows) {
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, started_at,
            completed_at, checkpoint_files_json
          )
          VALUES (${row.thread_id as string}, ${row.turn_id as string},
            ${row.pending_message_id as string | null}, ${row.state as string},
            ${row.requested_at as string}, ${row.started_at as string},
            ${row.completed_at as string}, ${row.checkpoint_files_json as string})
        `;
      }

      const olderPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 1,
        beforeCursor: cursor,
      });
      assert.equal(olderPage._tag, "Some");
      if (olderPage._tag === "Some") {
        // Identical older slice to what the pre-rewrite cursor would return.
        assert.deepEqual(messageIds(olderPage.value), [
          "turn-1-reply",
          "turn-2-reply",
          "turn-3-reply",
          "user-msg-1",
        ]);
        assert.equal(olderPage.value.page?.hasMore, false);
      }
    }),
  );

  it.effect("beforeCursor returns the disjoint adjacent older slice", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");
      if (firstPage._tag !== "Some") return;
      const cursor = firstPage.value.page?.beforeCursor;
      assert.notEqual(cursor, null);
      assert.notEqual(cursor, undefined);
      if (cursor === null || cursor === undefined) return;

      // Older page: user turn-1 plus subagent turns 2-3 riding along. Disjoint
      // from the first page: no turn-4/5 rows, no straggler.
      const olderPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 1,
        beforeCursor: cursor,
      });
      assert.equal(olderPage._tag, "Some");
      if (olderPage._tag === "Some") {
        assert.deepEqual(messageIds(olderPage.value), [
          "turn-1-reply",
          "turn-2-reply",
          "turn-3-reply",
          "user-msg-1",
        ]);
        assert.deepEqual(activityIds(olderPage.value), [
          "turn-1-activity",
          "turn-2-activity",
          "turn-3-activity",
        ]);
        assert.equal(olderPage.value.page?.hasMore, false);
        assert.equal(olderPage.value.page?.beforeCursor, null);
      }
    }),
  );

  it.effect("keeps imported history on the oldest page after resumed turns", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread({ importedMessageCount: 12 });
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const completePage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 50 });
      assert.equal(completePage._tag, "Some");
      if (completePage._tag !== "Some") return;
      assert.equal(
        completePage.value.thread.messages.filter((message) => message.id.startsWith("import:"))
          .length,
        12,
      );
      assert.equal(completePage.value.page?.hasMore, false);
      assert.equal(completePage.value.page?.beforeCursor, null);

      const recentPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(recentPage._tag, "Some");
      if (recentPage._tag !== "Some") return;
      assert.equal(
        recentPage.value.thread.messages.some((message) => message.id.startsWith("import:")),
        false,
      );
      const cursor = recentPage.value.page?.beforeCursor;
      assert.notEqual(cursor, null);
      assert.notEqual(cursor, undefined);
      if (cursor === null || cursor === undefined) return;

      const oldestPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 1,
        beforeCursor: cursor,
      });
      assert.equal(oldestPage._tag, "Some");
      if (oldestPage._tag !== "Some") return;

      const importedIds = oldestPage.value.thread.messages
        .map((message) => message.id)
        .filter((messageId) => messageId.startsWith("import:"));
      assert.equal(importedIds.length, 12);
      assert.equal(new Set(importedIds).size, 12);
      assert.equal(oldestPage.value.page?.hasMore, false);
      assert.equal(oldestPage.value.page?.beforeCursor, null);
    }),
  );

  it.effect("a cursor for a different thread degrades to the first page", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");
      if (firstPage._tag !== "Some") return;

      const foreign = encodeThreadDetailPageCursor({
        threadId: ThreadId.make("thread-other"),
        beforeAnchorAt: "2026-03-01T00:01:00.000Z",
        beforeTurnId: "turn-2",
      });
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
        beforeCursor: foreign,
      });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.deepEqual(messageIds(snapshot.value), messageIds(firstPage.value));
      }
    }),
  );

  it.effect("a malformed cursor degrades to the first page instead of failing", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
        beforeCursor: "not-a-cursor",
      });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.equal(snapshot.value.page?.hasMore, true);
        assert.equal(snapshot.value.thread.messages.length, 5);
      }
    }),
  );

  it.effect("windows never split below the raw-turn ceiling boundary contiguously", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // Page repeatedly with turnLimit 1 and assert the union of all pages is
      // exactly the full thread with no duplicates (disjointness + coverage).
      const seenMessages: string[] = [];
      const seenActivities: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
          turnLimit: 1,
          ...(cursor !== undefined ? { beforeCursor: cursor } : {}),
        });
        assert.equal(snapshot._tag, "Some");
        if (snapshot._tag !== "Some") return;
        seenMessages.push(...snapshot.value.thread.messages.map((message) => message.id));
        seenActivities.push(...snapshot.value.thread.activities.map((activity) => activity.id));
        const next = snapshot.value.page?.beforeCursor;
        if (next === null || next === undefined) break;
        cursor = next;
      }
      assert.equal(new Set(seenMessages).size, seenMessages.length);
      assert.equal(new Set(seenActivities).size, seenActivities.length);
      assert.equal(seenMessages.length, 9);
      assert.equal(seenActivities.length, 6);
    }),
  );

  it.effect("bounds activity hydration and preserves unresolved requests", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`
        WITH RECURSIVE activity_rows(sequence) AS (
          SELECT 1
          UNION ALL
          SELECT sequence + 1 FROM activity_rows WHERE sequence < 501
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        SELECT
          printf('activity-%04d', sequence),
          'thread-w',
          'turn-5',
          'tool',
          CASE
            WHEN sequence = 2 THEN 'tool.updated'
            WHEN sequence IN (3, 70) THEN 'context-window.updated'
            ELSE 'tool.completed'
          END,
          'ran tool',
          CASE
            WHEN sequence IN (2, 80) THEN json_object(
              'itemType', 'command_execution',
              'toolCallId', 'cross-batch-call',
              'title', CASE WHEN sequence = 80 THEN 'Build completed' ELSE 'Build' END,
              'status', 'completed',
              'data', json_object(
                'toolCallId', 'cross-batch-call',
                'item', json_object(
                  'command', 'vp test run',
                  'aggregatedOutput', printf(
                    'command output%s%s',
                    char(10),
                    replace(hex(zeroblob(8192)), '00', 'x')
                  )
                ),
                'rawOutput', printf(
                  'raw output%s%s',
                  char(10),
                  replace(hex(zeroblob(8192)), '00', 'y')
                ),
                'files', json_array(json_object('path', 'apps/server/src/snapshot.ts'))
              )
            )
            WHEN sequence = 10 THEN json_object(
              'itemType', 'mcp_tool_call',
              'status', 'completed',
              'data', json_object(
                'item', json_object(
                  'type', 'mcpToolCall',
                  'id', 'mcp-item-10',
                  'tool', 'fetch_pr',
                  'server', 'github',
                  'status', 'completed',
                  'arguments', json_object('pr', 42),
                  'result', json_object(
                    'content', json_array(json_object(
                      'type', 'text',
                      'text', printf(
                        'PR body line one%s%s',
                        char(10),
                        replace(hex(zeroblob(8192)), '00', 'z')
                      )
                    ))
                  ),
                  '_meta', json_object('raw', replace(hex(zeroblob(8192)), '00', 'q'))
                )
              )
            )
            WHEN sequence = 11 THEN json_object(
              'itemType', 'command_execution',
              'status', 'completed',
              'data', json_object(
                'item', json_object(
                  'status', 'failed',
                  'command', 'vp test run',
                  'aggregatedOutput', printf(
                    'failed command%s%s',
                    char(10),
                    replace(hex(zeroblob(8192)), '00', 'w')
                  )
                ),
                'rawOutput', json_object('stdout', 'failed output'),
                'files', json_array(json_object('path', 'apps/server/src/failed.ts'))
              )
            )
            WHEN sequence IN (3, 70) THEN json_object(
              'usedTokens', sequence * 100,
              'modelContextWindow', 100000
            )
            ELSE json_object('sequence', sequence)
          END,
          sequence,
          '2026-03-01T00:04:00.000Z'
        FROM activity_rows
      `;

      const fullDetail = yield* snapshotQuery.getThreadDetailById(threadW);
      assert.equal(fullDetail._tag, "Some");
      if (fullDetail._tag === "Some") {
        assert.equal(fullDetail.value.activities.length, 500);
        assert.equal(fullDetail.value.activities[0]?.id, asEventId("activity-0002"));
        assert.equal(fullDetail.value.activities.at(-1)?.id, asEventId("activity-0501"));
      }

      const windowedDetail = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
      });
      assert.equal(windowedDetail._tag, "Some");
      if (windowedDetail._tag === "Some") {
        assert.equal(windowedDetail.value.thread.activities.length, 500);
        assert.equal(windowedDetail.value.thread.activities[0]?.id, asEventId("activity-0002"));
        assert.equal(windowedDetail.value.thread.activities.at(-1)?.id, asEventId("activity-0501"));
      }

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'approval-old', 'thread-w', NULL, 'approval', 'approval.requested',
            'Approve old command', '{"requestId":"approval-1"}', NULL,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'user-input-old', 'thread-w', NULL, 'approval', 'user-input.requested',
            'Answer old question', '{"requestId":"input-1"}', NULL,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'user-input-closed', 'thread-w', NULL, 'approval', 'user-input.requested',
            'Closed question', '{"requestId":"input-closed"}', NULL,
            '2026-03-01T00:00:03.000Z'
          ),
          (
            'user-input-closed-resolution', 'thread-w', NULL, 'info', 'user-input.resolved',
            'Closed question', '{"requestId":"input-closed"}', NULL,
            '2026-03-01T00:00:04.000Z'
          ),
          (
            'user-input-tied-z-request', 'thread-w', NULL, 'approval', 'user-input.requested',
            'Tied open question', '{"requestId":"input-tied-open"}', NULL,
            '2026-03-01T00:00:05.000Z'
          ),
          (
            'user-input-tied-a-resolution', 'thread-w', NULL, 'info', 'user-input.resolved',
            'Tied open question', '{"requestId":"input-tied-open"}', NULL,
            '2026-03-01T00:00:05.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
        )
        VALUES (
          'approval-1', 'thread-w', NULL, 'pending', NULL,
          '2026-03-01T00:00:01.000Z', NULL
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET pending_approval_count = 1, pending_user_input_count = 1
        WHERE thread_id = 'thread-w'
      `;

      const detailWithPinnedRequests = yield* snapshotQuery.getThreadDetailById(threadW);
      assert.equal(detailWithPinnedRequests._tag, "Some");
      if (detailWithPinnedRequests._tag === "Some") {
        const ids = new Set(
          detailWithPinnedRequests.value.activities.map((activity) => activity.id),
        );
        assert.equal(detailWithPinnedRequests.value.activities.length, 503);
        assert.equal(ids.has(asEventId("approval-old")), true);
        assert.equal(ids.has(asEventId("user-input-old")), true);
        assert.equal(ids.has(asEventId("user-input-closed")), false);
        assert.equal(ids.has(asEventId("user-input-tied-z-request")), true);
      }

      const windowWithPinnedRequests = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
      });
      assert.equal(windowWithPinnedRequests._tag, "Some");
      if (windowWithPinnedRequests._tag === "Some") {
        const ids = new Set(
          windowWithPinnedRequests.value.thread.activities.map((activity) => activity.id),
        );
        assert.equal(windowWithPinnedRequests.value.thread.activities.length, 503);
        assert.equal(ids.has(asEventId("approval-old")), true);
        assert.equal(ids.has(asEventId("user-input-old")), true);
        assert.equal(ids.has(asEventId("user-input-closed")), false);
        assert.equal(ids.has(asEventId("user-input-tied-z-request")), true);
      }

      const fullSnapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW);
      assert.equal(fullSnapshot._tag, "Some");
      if (
        detailWithPinnedRequests._tag === "Some" &&
        fullSnapshot._tag === "Some" &&
        windowWithPinnedRequests._tag === "Some"
      ) {
        const projectedFullSnapshot = projectThreadDetailSnapshot(fullSnapshot.value);
        const projectedRawBaseline = projectThreadDetailSnapshot({
          snapshotSequence: fullSnapshot.value.snapshotSequence,
          thread: detailWithPinnedRequests.value,
        });
        assert.deepStrictEqual(projectedFullSnapshot, projectedRawBaseline);

        const rawActivitiesById = new Map(
          detailWithPinnedRequests.value.activities.map((activity) => [activity.id, activity]),
        );
        const projectedWindowSnapshot = projectThreadDetailSnapshot(windowWithPinnedRequests.value);
        const projectedWindowBaseline = projectThreadDetailSnapshot({
          ...windowWithPinnedRequests.value,
          thread: {
            ...windowWithPinnedRequests.value.thread,
            activities: windowWithPinnedRequests.value.thread.activities.map(
              (activity) => rawActivitiesById.get(activity.id) ?? activity,
            ),
          },
        });
        assert.deepStrictEqual(projectedWindowSnapshot, projectedWindowBaseline);

        const projectedIds = new Set(
          projectedFullSnapshot.thread.activities.map((activity) => activity.id),
        );
        assert.equal(projectedIds.has(asEventId("activity-0002")), false);
        assert.equal(projectedIds.has(asEventId("activity-0003")), false);
        assert.equal(projectedIds.has(asEventId("activity-0070")), true);

        const failedCommand = projectedFullSnapshot.thread.activities.find(
          (activity) => activity.id === asEventId("activity-0011"),
        );
        assert.deepStrictEqual(failedCommand?.payload, {
          itemType: "command_execution",
          status: "failed",
          data: {
            item: {
              command: "vp test run",
              aggregatedOutput: "failed command",
            },
            files: [{ path: "apps/server/src/failed.ts" }],
            rawOutput: { content: "failed output" },
          },
        });
      }
    }),
  );

  it.effect("a thread with no turns returns its content unwindowed on the first page", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        )
        VALUES ('project-e', 'Empty', '/tmp/project-e', '[]',
          '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        )
        VALUES ('thread-e', 'project-e', 'Turnless thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          0, 0, 0, '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES ('pre-turn-msg', 'thread-e', NULL, 'user', 'first prompt', 0,
          '2026-03-02T00:00:01.000Z', '2026-03-02T00:00:01.000Z')
      `;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, '2026-03-02T00:00:01.000Z')
        `;
      }

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-e"), {
        turnLimit: 5,
      });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.deepEqual(messageIds(snapshot.value), ["pre-turn-msg"]);
        assert.equal(snapshot.value.page?.hasMore, false);
        assert.equal(snapshot.value.page?.beforeCursor, null);
      }
    }),
  );
});

projectionSnapshotLayer("ProjectionSnapshotQuery imported sources", (it) => {
  const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
  const source: AgentSessionImportSource = {
    provider: "codex",
    providerInstanceId: ProviderInstanceId.make("codex-home"),
    providerSessionId: "native-session",
    filePath: "/tmp/transcript.jsonl",
    size: 128,
    mtimeMs: 1_700_000_000_000,
    device: 1,
    inode: 2,
    birthtimeMs: 1_699_000_000_000,
  };

  const seedImportedSession = Effect.fn("seedImportedSession")(function* (
    projectId: ProjectId,
    source: AgentSessionImportSource,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make(
      `import:${source.providerInstanceId}:${source.providerSessionId}`,
    );
    const timestamp = "2026-03-02T00:00:00.000Z";
    yield* sql`
      INSERT OR IGNORE INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (${projectId}, 'Imported project', '/tmp/imported-project', '[]',
        ${timestamp}, ${timestamp})
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at
      ) VALUES (${threadId}, ${projectId}, 'Imported thread',
        ${encodeJson({ instanceId: source.providerInstanceId, model: "gpt-5-codex" })},
        'full-access', 'default',
        ${timestamp}, ${timestamp})
    `;
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json
      ) VALUES (${threadId}, ${source.provider}, ${source.providerInstanceId},
        ${source.provider}, 'full-access', 'stopped', ${timestamp},
        ${encodeJson({ threadId: source.providerSessionId })},
        ${encodeJson({ importedTranscripts: [source] })})
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (${`${threadId}:000000`}, ${threadId}, 'user', 'Imported history', 0,
        ${timestamp}, ${timestamp})
    `;
    return { threadId, source };
  });

  it.effect("reads completed source copies without decoding message bodies", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("project-import-metadata");
      const imported = yield* seedImportedSession(projectId, source);
      const copiedSource = {
        ...source,
        filePath: "/tmp/transcript-copy.jsonl",
        mtimeMs: null,
        inode: null,
        birthtimeMs: null,
      };
      yield* sql`
        UPDATE provider_session_runtime
        SET runtime_payload_json = ${encodeJson({
          cwd: "/tmp/imported-project",
          importedTranscripts: [source, copiedSource],
        })}
        WHERE thread_id = ${imported.threadId}
      `;
      yield* sql`
        UPDATE projection_thread_messages SET attachments_json = 'not-json'
        WHERE thread_id = ${imported.threadId}
      `;

      const counter = makeSqlStatementCounter();
      const sources = yield* query
        .getImportedAgentSessionSources(projectId)
        .pipe(Effect.withTracer(counter.tracer));
      assert.deepEqual(sources, [imported, { threadId: imported.threadId, source: copiedSource }]);
      assert.equal(counter.count(), 1);
    }),
  );

  it.effect("requires active project threads, a binding, and an imported message", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("project-import-completion");
      const completed = yield* seedImportedSession(projectId, {
        ...source,
        providerSessionId: "completed",
      });
      yield* sql`
        UPDATE projection_thread_messages SET message_id = ${`${completed.threadId}:legacy`}
        WHERE thread_id = ${completed.threadId}
      `;
      const partials = yield* Effect.forEach(
        [
          "no-binding",
          "no-history",
          "no-imported-message",
          "wrong-message-thread",
          "archived",
          "deleted",
        ],
        (providerSessionId) => seedImportedSession(projectId, { ...source, providerSessionId }),
      );
      const [noBinding, noHistory, noImportedMessage, wrongMessageThread, archived, deleted] =
        partials;
      assert.isDefined(noBinding);
      assert.isDefined(noHistory);
      assert.isDefined(noImportedMessage);
      assert.isDefined(wrongMessageThread);
      assert.isDefined(archived);
      assert.isDefined(deleted);
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${noBinding.threadId}`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${noHistory.threadId}`;
      yield* sql`
        UPDATE projection_thread_messages SET message_id = ${`normal:${noImportedMessage.threadId}`}
        WHERE thread_id = ${noImportedMessage.threadId}
      `;
      yield* sql`
        UPDATE projection_thread_messages SET thread_id = 'unrelated-thread'
        WHERE thread_id = ${wrongMessageThread.threadId}
      `;
      yield* sql`
        UPDATE projection_threads SET archived_at = '2026-03-03T00:00:00.000Z'
        WHERE thread_id = ${archived.threadId}
      `;
      yield* sql`
        UPDATE projection_threads SET deleted_at = '2026-03-03T00:00:00.000Z'
        WHERE thread_id = ${deleted.threadId}
      `;
      const otherProjectId = ProjectId.make("project-import-other");
      const otherProject = yield* seedImportedSession(otherProjectId, {
        ...source,
        providerSessionId: "other-project",
      });
      const deletedProjectId = ProjectId.make("project-import-deleted");
      yield* seedImportedSession(deletedProjectId, {
        ...source,
        providerSessionId: "deleted-project",
      });
      yield* sql`
        UPDATE projection_projects SET deleted_at = '2026-03-03T00:00:00.000Z'
        WHERE project_id = ${deletedProjectId}
      `;

      assert.deepEqual(yield* query.getImportedAgentSessionSources(projectId), [completed]);
      assert.deepEqual(yield* query.getImportedAgentSessionSources(otherProjectId), [otherProject]);
      assert.deepEqual(yield* query.getImportedAgentSessionSources(deletedProjectId), []);
      assert.deepEqual(
        yield* query.getImportedAgentSessionSources(ProjectId.make("project-import-missing")),
        [],
      );
    }),
  );

  it.effect("keeps original sources when the current runtime provider and cursor change", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("project-import-switched");
      const imported = yield* seedImportedSession(projectId, {
        ...source,
        provider: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claude-original"),
        providerSessionId: "original-session",
      });
      yield* sql`
        UPDATE provider_session_runtime
        SET provider_name = 'codex', provider_instance_id = 'codex-new', adapter_key = 'codex',
          resume_cursor_json = '{"threadId":"new-session"}'
        WHERE thread_id = ${imported.threadId}
      `;

      assert.deepEqual(yield* query.getImportedAgentSessionSources(projectId), [imported]);
    }),
  );

  it.effect("skips invalid source payloads and entries without dropping valid sources", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("project-import-invalid");
      const imported = yield* seedImportedSession(projectId, {
        ...source,
        providerSessionId: "a-invalid",
      });
      const valid = yield* seedImportedSession(projectId, {
        ...source,
        providerSessionId: "z-valid",
      });
      for (const payload of [null, "not-json", "null", "[]", "{}", '{"importedTranscripts":{}}']) {
        yield* sql`
          UPDATE provider_session_runtime SET runtime_payload_json = ${payload}
          WHERE thread_id = ${imported.threadId}
        `;
        assert.deepEqual(yield* query.getImportedAgentSessionSources(projectId), [valid]);
      }
      yield* sql`
        UPDATE provider_session_runtime SET runtime_payload_json = X'FF'
        WHERE thread_id = ${imported.threadId}
      `;
      assert.deepEqual(yield* query.getImportedAgentSessionSources(projectId), [valid]);

      yield* sql`
        UPDATE provider_session_runtime
        SET runtime_payload_json = ${encodeJson({
          importedTranscripts: [
            null,
            {},
            { ...imported.source, size: -1 },
            { ...imported.source, provider: "cursor" },
            { ...imported.source, providerInstanceId: "wrong-instance" },
            { ...imported.source, providerSessionId: "wrong-session" },
            imported.source,
          ],
        })}
        WHERE thread_id = ${imported.threadId}
      `;
      assert.deepEqual(yield* query.getImportedAgentSessionSources(projectId), [imported, valid]);
    }),
  );
});

it.effect("omits foreign-host PRs from legacy snapshots while preserving native links", () => {
  const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () =>
          Effect.succeed({
            canonicalKey: "github.com/acme/web",
            provider: "github",
            displayName: "acme/web",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://github.com/acme/web.git",
            },
          }),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project-1', 'Project', '/repo', '[]', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')`;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('thread-1', 'project-1', 'Thread', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')`;
    yield* sql`INSERT INTO projection_thread_pull_requests (thread_id, host, repository, number, url, source, linked_at)
      VALUES ('thread-1', 'github.enterprise.test', 'acme/web', 42, 'https://github.enterprise.test/acme/web/pull/42', 'manual', '2026-09-09T00:00:00Z')`;
    const readThreads = Effect.gen(function* () {
      const full = yield* query.getSnapshot();
      const shell = yield* query.getShellSnapshot();
      const detail = yield* query.getThreadDetailById(ThreadId.make("thread-1"));
      const individual = yield* query.getThreadShellById(ThreadId.make("thread-1"));
      return [
        full.threads[0]!,
        shell.threads[0]!,
        Option.getOrThrow(detail),
        Option.getOrThrow(individual),
      ];
    });
    for (const thread of yield* readThreads) {
      assert.equal(thread.linkedPullRequest ?? null, null);
      assert.equal(thread.pullRequests[0]?.host, "github.enterprise.test");
    }
    yield* sql`UPDATE projection_thread_pull_requests SET host = 'github.com', url = 'https://github.com/acme/web/pull/42'`;
    for (const thread of yield* readThreads) {
      assert.equal(thread.linkedPullRequest?.url, "https://github.com/acme/web/pull/42");
    }
  }).pipe(Effect.provide(layer));
});

projectionSnapshotLayer("ProjectionSnapshotQuery activities by kind", (it) => {
  it.effect("lists one kind across active threads only, without hydrating the threads", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const timestamp = "2026-03-02T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-kinds', 'Project', '/tmp/project-kinds', '[]', ${timestamp}, ${timestamp})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        ) VALUES
          ('thread-live', 'project-kinds', 'Live', '{"instanceId":"codex","model":"gpt-5"}',
            'full-access', 'default', ${timestamp}, ${timestamp}, NULL),
          ('thread-gone', 'project-kinds', 'Gone', '{"instanceId":"codex","model":"gpt-5"}',
            'full-access', 'default', ${timestamp}, ${timestamp}, ${timestamp}),
          ('thread-shelved', 'project-kinds', 'Shelved', '{"instanceId":"codex","model":"gpt-5"}',
            'full-access', 'default', ${timestamp}, ${timestamp}, NULL)
      `;
      yield* sql`UPDATE projection_threads SET archived_at = ${timestamp} WHERE thread_id = 'thread-shelved'`;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES
          ('setup-live', 'thread-live', NULL, 'info', 'worktree-setup', 'Setting up',
            '{"phase":"running"}', ${timestamp}),
          ('other-live', 'thread-live', NULL, 'info', 'tool.completed', 'Other',
            '{}', ${timestamp}),
          ('setup-gone', 'thread-gone', NULL, 'info', 'worktree-setup', 'Setting up',
            '{"phase":"running"}', ${timestamp}),
          ('setup-shelved', 'thread-shelved', NULL, 'info', 'worktree-setup', 'Setting up',
            '{"phase":"running"}', ${timestamp})
      `;

      const setups = yield* query.listActivitiesByKind("worktree-setup");
      assert.deepEqual(
        setups.map((activity) => [activity.id, activity.kind, activity.payload]),
        [["setup-live", "worktree-setup", { phase: "running" }]],
      );
      assert.deepEqual(yield* query.listActivitiesByKind("nope"), []);
    }),
  );
});

// Agent thread search, phase 1. These specs drive the read-only evidence API
// through the live ProjectionSnapshotQuery layer against in-memory SQLite. The
// lexical `searchThreads` guard beside them pins the behavior the existing
// picker depends on, which the evidence API must leave unchanged.
const THREAD_SEARCH_MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5"}';

const resetThreadSearchTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_activities`;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_turns`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
});

const insertThreadSearchProject = (input: {
  readonly projectId: string;
  readonly title: string;
  readonly deletedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${input.projectId}, ${input.title}, ${`/tmp/${input.projectId}`}, '[]',
        '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', ${input.deletedAt ?? null}
      )
    `;
  });

const insertThreadSearchThread = (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${input.threadId}, ${input.projectId}, ${input.title}, ${THREAD_SEARCH_MODEL_SELECTION},
        'full-access', 'default', '2026-06-01T00:00:00.000Z', ${input.updatedAt},
        ${input.archivedAt ?? null}, ${input.deletedAt ?? null}
      )
    `;
  });

const insertThreadSearchMessage = (input: {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly turnId?: string;
  readonly isStreaming?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (
        ${input.messageId}, ${input.threadId}, ${input.turnId ?? null}, ${input.role},
        ${input.text}, ${input.isStreaming === true ? 1 : 0}, ${input.createdAt}, ${input.createdAt}
      )
    `;
  });

// A turn whose `assistant_message_id` marks its assistant answer; completed unless stated.
const insertThreadSearchTurn = (input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly requestedAt: string;
  readonly state?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state,
        requested_at, started_at, completed_at, checkpoint_files_json
      ) VALUES (
        ${input.threadId}, ${input.turnId}, NULL, ${input.assistantMessageId},
        ${input.state ?? "completed"},
        ${input.requestedAt}, ${input.requestedAt}, ${input.requestedAt}, '[]'
      )
    `;
  });

interface ThreadSearchPage<A> {
  readonly entries: ReadonlyArray<A>;
  readonly nextCursor: string | null;
}

// Follows `nextCursor` until the API reports the last page. The page ceiling
// turns a cursor that never advances into a failure instead of a hang.
const collectThreadSearchPages = <A, E, R>(
  readPage: (cursor: string | undefined) => Effect.Effect<ThreadSearchPage<A>, E, R>,
) =>
  Effect.gen(function* () {
    const pages: Array<ReadonlyArray<A>> = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
      const page = yield* readPage(cursor);
      pages.push(page.entries);
      if (page.nextCursor === null) return pages;
      cursor = page.nextCursor;
    }
    return assert.fail("thread search pagination did not reach a final page");
  });

const withThreadSearchCursor = (cursor: string | undefined) =>
  cursor === undefined ? {} : { cursor };

const readThreadSearchCatalogPage = (cursor: string | undefined, limit: number) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const page = yield* query.listThreadSearchCatalog({ ...withThreadSearchCursor(cursor), limit });
    return { entries: page.threads, nextCursor: page.nextCursor };
  });

const readThreadSearchEvidencePage = (
  cursor: string | undefined,
  queryText: string,
  limit?: number,
) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const page = yield* query.searchThreadEvidence({
      query: queryText,
      ...withThreadSearchCursor(cursor),
      ...(limit === undefined ? {} : { limit }),
    });
    return { entries: page.matches, nextCursor: page.nextCursor };
  });

const isThreadSearchCatalogPage = Schema.is(OrchestrationThreadSearchCatalogPage);
const isThreadSearchEvidencePage = Schema.is(OrchestrationThreadSearchEvidencePage);

/**
 * Runs `effect` and returns SQLite's plan for every statement it executed. The
 * SQL comes from the `db.query.text` attribute of each `sql.execute` span, so
 * the plan is the one of the statement the query layer really sent. SQLite
 * plans at prepare time, so leaving the parameters unbound does not change it.
 */
const planStatementsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        if (options.name === "sql.execute") spans.push(span);
        return span;
      },
    });
    yield* effect.pipe(Effect.withTracer(tracer));
    const plans: Array<ReadonlyArray<string>> = [];
    for (const span of spans) {
      const statement = span.attributes.get("db.query.text");
      assert.isString(statement);
      const rows = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${String(statement)}`,
      );
      plans.push(rows.map((row) => row.detail));
    }
    return plans;
  });

// An evidence statement reads a bounded window only if SQLite can walk the
// messages in scan order and stop at LIMIT: no full scan of a base table and
// no sort of every candidate row first. `SCAN page` walks the bounded CTE. A
// resumed thread page adds a third statement, the boundary rowid lookup.
const assertBoundedEvidencePlans = (
  plans: ReadonlyArray<ReadonlyArray<string>>,
  expectedStatements = 2,
) => {
  assert.strictEqual(plans.length, expectedStatements);
  for (const plan of plans) {
    const text = plan.join("\n");
    assert.notInclude(text, "USE TEMP B-TREE", text);
    assert.isFalse(
      plan.some((detail) => /^SCAN (messages|threads|projects|turns)\b/.test(detail)),
      text,
    );
    assert.match(
      plan.find((detail) => / (messages|projection_thread_messages) /.test(detail)) ?? "",
      /^SEARCH /,
      text,
    );
  }
};

// Walks one thread's evidence, checking every page against the contract the
// RPC encodes it with, so a page the wire would reject fails here too.
const collectThreadFilteredEvidencePages = (queryText: string, threadId: string, limit: number) =>
  collectThreadSearchPages((cursor) =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const page = yield* query.searchThreadEvidence({
        query: queryText,
        threadId: ThreadId.make(threadId),
        limit,
        ...withThreadSearchCursor(cursor),
      });
      assert.isTrue(
        isThreadSearchEvidencePage(page),
        `evidence page violates its contract; nextCursor length ${page.nextCursor?.length}`,
      );
      return { entries: page.matches, nextCursor: page.nextCursor };
    }),
  );

/**
 * Walks one thread's evidence one match per page and deletes the message the
 * first cursor names before resuming, as a revert would. Returns the ids
 * delivered after the deletion; the walk must still reach every match below
 * the boundary, repeating at most matches that share the boundary timestamp.
 */
const walkThreadEvidencePastDeletedBoundary = (queryText: string, threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const first = yield* query.searchThreadEvidence({
      query: queryText,
      threadId: ThreadId.make(threadId),
      limit: 1,
    });
    const boundary = first.matches[0];
    assert.isDefined(boundary);
    assert.isNotNull(first.nextCursor);
    yield* sql`DELETE FROM projection_thread_messages WHERE message_id = ${boundary?.messageId ?? ""}`;
    const later = yield* collectThreadSearchPages((cursor) =>
      Effect.gen(function* () {
        const page = yield* query.searchThreadEvidence({
          query: queryText,
          threadId: ThreadId.make(threadId),
          limit: 1,
          cursor: cursor ?? first.nextCursor ?? "",
        });
        return { entries: page.matches, nextCursor: page.nextCursor };
      }),
    );
    return { boundary, later: later.flat() };
  });

const insertDeletedBoundaryFixture = (
  threadId: string,
  messages: ReadonlyArray<{ readonly messageId: string; readonly createdAt: string }>,
) =>
  Effect.gen(function* () {
    yield* insertThreadSearchProject({ projectId: `project-${threadId}`, title: "Boundary" });
    yield* insertThreadSearchThread({
      threadId,
      projectId: `project-${threadId}`,
      title: threadId,
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    for (const message of messages) {
      yield* insertThreadSearchMessage({
        ...message,
        threadId,
        role: "user",
        text: `A boundary jasper note ${message.messageId}.`,
      });
    }
  });

// Every match below the deleted boundary arrives, and every repeat shares the
// boundary's timestamp.
const assertDeletedBoundaryWalk = (
  walk: {
    readonly boundary: OrchestrationThreadSearchEvidence | undefined;
    readonly later: ReadonlyArray<OrchestrationThreadSearchEvidence>;
  },
  expectedBelowBoundary: ReadonlyArray<string>,
) => {
  const delivered = walk.later.map((match) => match.messageId ?? "");
  for (const messageId of expectedBelowBoundary) {
    assert.include(delivered, messageId, `skipped ${messageId}; delivered ${delivered.join(", ")}`);
  }
  assert.notInclude(delivered, walk.boundary?.messageId);
  const counts = new Map<string, number>();
  for (const messageId of delivered) counts.set(messageId, (counts.get(messageId) ?? 0) + 1);
  for (const match of walk.later) {
    const repeated =
      (counts.get(match.messageId ?? "") ?? 0) > 1 ||
      !expectedBelowBoundary.includes(match.messageId ?? "");
    if (repeated) {
      assert.strictEqual(match.messageCreatedAt, walk.boundary?.messageCreatedAt);
    }
  }
};

const collectThreadSearchEvidence = (queryText: string, limit?: number) =>
  collectThreadSearchPages((cursor) => readThreadSearchEvidencePage(cursor, queryText, limit)).pipe(
    Effect.map((pages) => pages.flat()),
  );

projectionSnapshotLayer("ProjectionSnapshotQuery agent thread search evidence", (it) => {
  it.effect(
    "lists compact thread search catalog entries from active and archived threads across stable pages",
    () =>
      Effect.gen(function* () {
        yield* resetThreadSearchTables;
        const sameUpdatedAt = "2026-06-02T00:00:00.000Z";
        yield* insertThreadSearchProject({ projectId: "project-alpha", title: "Alpha" });
        for (const index of [1, 2, 3, 4, 5]) {
          yield* insertThreadSearchThread({
            threadId: `thread-catalog-${index}`,
            projectId: "project-alpha",
            title: `Catalog ${index}`,
            updatedAt: sameUpdatedAt,
          });
        }
        yield* insertThreadSearchThread({
          threadId: "thread-catalog-archived",
          projectId: "project-alpha",
          title: "Catalog archived",
          updatedAt: sameUpdatedAt,
          archivedAt: "2026-06-03T00:00:00.000Z",
        });

        const firstPage = yield* readThreadSearchCatalogPage(undefined, 2);
        assert.isAtMost(firstPage.entries.length, 2);
        assert.isNotNull(firstPage.nextCursor);
        // A thread that changes after the first page must not shift the
        // remaining pages: no entry is repeated and none is skipped.
        yield* insertThreadSearchThread({
          threadId: "thread-catalog-late",
          projectId: "project-alpha",
          title: "Catalog late",
          updatedAt: "2026-06-04T00:00:00.000Z",
        });
        const laterPages = yield* collectThreadSearchPages((cursor) =>
          readThreadSearchCatalogPage(cursor ?? firstPage.nextCursor ?? undefined, 2),
        );
        const entries = [...firstPage.entries, ...laterPages.flat()];
        for (const page of laterPages) assert.isAtMost(page.length, 2);

        const originalIds = entries
          .map((entry) => entry.threadId as string)
          .filter((threadId) => threadId !== "thread-catalog-late");
        assert.strictEqual(new Set(originalIds).size, originalIds.length);
        assert.deepStrictEqual(originalIds.toSorted(), [
          "thread-catalog-1",
          "thread-catalog-2",
          "thread-catalog-3",
          "thread-catalog-4",
          "thread-catalog-5",
          "thread-catalog-archived",
        ]);
        const archivedEntry = entries.find((entry) => entry.threadId === "thread-catalog-archived");
        assert.deepStrictEqual(
          {
            threadId: archivedEntry?.threadId,
            projectId: archivedEntry?.projectId,
            title: archivedEntry?.title,
            projectTitle: archivedEntry?.projectTitle,
            archivedAt: archivedEntry?.archivedAt,
            updatedAt: archivedEntry?.updatedAt,
          },
          {
            threadId: ThreadId.make("thread-catalog-archived"),
            projectId: asProjectId("project-alpha"),
            title: "Catalog archived",
            projectTitle: "Alpha",
            archivedAt: "2026-06-03T00:00:00.000Z",
            updatedAt: sameUpdatedAt,
          },
        );
      }),
  );

  it.effect("finds thread search evidence deep in long and archived threads", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      const sql = yield* SqlClient.SqlClient;
      yield* insertThreadSearchProject({ projectId: "project-deep", title: "Deep project" });
      yield* insertThreadSearchThread({
        threadId: "thread-long",
        projectId: "project-deep",
        title: "Long conversation",
        updatedAt: "2026-06-05T00:00:00.000Z",
      });
      yield* insertThreadSearchThread({
        threadId: "thread-shelved",
        projectId: "project-deep",
        title: "Shelved conversation",
        updatedAt: "2026-06-01T00:00:00.000Z",
        archivedAt: "2026-06-02T00:00:00.000Z",
      });

      // The oldest message of a 400-message thread carries the only match.
      yield* insertThreadSearchMessage({
        messageId: "message-long-first",
        threadId: "thread-long",
        role: "user",
        text: "We decided on the quartzite migration plan before anything else.",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      yield* sql`
        WITH RECURSIVE filler(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < 400)
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          'message-long-filler-' || n,
          'thread-long',
          NULL,
          'user',
          'Unrelated filler message number ' || n,
          0,
          strftime('%Y-%m-%dT%H:%M:%fZ', '2026-06-01T00:00:00.000Z', '+' || n || ' seconds'),
          strftime('%Y-%m-%dT%H:%M:%fZ', '2026-06-01T00:00:00.000Z', '+' || n || ' seconds')
        FROM filler
      `;
      yield* insertThreadSearchMessage({
        messageId: "message-long-final",
        threadId: "thread-long",
        turnId: "turn-long-middle",
        role: "assistant",
        text: "Final answer: the basalt rollout finished cleanly.",
        createdAt: "2026-06-01T00:03:20.500Z",
      });
      yield* insertThreadSearchTurn({
        threadId: "thread-long",
        turnId: "turn-long-middle",
        assistantMessageId: "message-long-final",
        requestedAt: "2026-06-01T00:03:20.000Z",
      });

      yield* insertThreadSearchMessage({
        messageId: "message-shelved-user",
        threadId: "thread-shelved",
        role: "user",
        text: "Why does the obsidian cache evict too early?",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      yield* insertThreadSearchMessage({
        messageId: "message-shelved-final",
        threadId: "thread-shelved",
        turnId: "turn-shelved",
        role: "assistant",
        text: "The obsidian cache used the wrong clock.",
        createdAt: "2026-06-01T00:00:01.000Z",
      });
      yield* insertThreadSearchTurn({
        threadId: "thread-shelved",
        turnId: "turn-shelved",
        assistantMessageId: "message-shelved-final",
        requestedAt: "2026-06-01T00:00:00.500Z",
      });

      const oldest = yield* collectThreadSearchEvidence("QUARTZITE migration");
      assert.strictEqual(oldest.length, 1);
      assert.deepStrictEqual(
        {
          threadId: oldest[0]?.threadId,
          projectId: oldest[0]?.projectId,
          title: oldest[0]?.title,
          projectTitle: oldest[0]?.projectTitle,
          archivedAt: oldest[0]?.archivedAt,
          source: oldest[0]?.source,
          messageCreatedAt: oldest[0]?.messageCreatedAt,
        },
        {
          threadId: ThreadId.make("thread-long"),
          projectId: asProjectId("project-deep"),
          title: "Long conversation",
          projectTitle: "Deep project",
          archivedAt: null,
          source: "user",
          messageCreatedAt: "2026-06-01T00:00:00.000Z",
        },
      );
      assert.match(oldest[0]?.excerpt ?? "", /quartzite migration/i);

      const finalAnswer = yield* collectThreadSearchEvidence("basalt rollout");
      assert.deepStrictEqual(
        finalAnswer.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-long"), "assistant"]],
      );

      const archived = yield* collectThreadSearchEvidence("obsidian cache");
      assert.deepStrictEqual(
        archived
          .map((match) => [match.threadId, match.source, match.archivedAt] as const)
          .toSorted(([, left], [, right]) => left.localeCompare(right)),
        [
          [ThreadId.make("thread-shelved"), "assistant", "2026-06-02T00:00:00.000Z"],
          [ThreadId.make("thread-shelved"), "user", "2026-06-02T00:00:00.000Z"],
        ],
      );
    }),
  );

  it.effect(
    "keeps deleted, streaming, interim, tool, and system text out of thread search evidence",
    () =>
      Effect.gen(function* () {
        yield* resetThreadSearchTables;
        const sql = yield* SqlClient.SqlClient;
        yield* insertThreadSearchProject({ projectId: "project-live", title: "Live project" });
        yield* insertThreadSearchProject({
          projectId: "project-gone",
          title: "Gone project",
          deletedAt: "2026-06-03T00:00:00.000Z",
        });
        yield* insertThreadSearchThread({
          threadId: "thread-safe",
          projectId: "project-live",
          title: "Safe thread",
          updatedAt: "2026-06-02T00:00:00.000Z",
        });
        yield* insertThreadSearchThread({
          threadId: "thread-deleted",
          projectId: "project-live",
          title: "Deleted thread",
          updatedAt: "2026-06-02T00:00:00.000Z",
          deletedAt: "2026-06-03T00:00:00.000Z",
        });
        yield* insertThreadSearchThread({
          threadId: "thread-in-deleted-project",
          projectId: "project-gone",
          title: "Thread in a deleted project",
          updatedAt: "2026-06-02T00:00:00.000Z",
        });

        const at = (second: number) => `2026-06-01T00:00:${String(second).padStart(2, "0")}.000Z`;
        yield* insertThreadSearchMessage({
          messageId: "message-visible",
          threadId: "thread-safe",
          role: "user",
          text: "The visible zircon note.",
          createdAt: at(1),
        });
        yield* insertThreadSearchMessage({
          messageId: "message-streaming-user",
          threadId: "thread-safe",
          role: "user",
          text: "Streaming zircon draft.",
          createdAt: at(2),
          isStreaming: true,
        });
        yield* insertThreadSearchMessage({
          messageId: "message-streaming-final",
          threadId: "thread-safe",
          turnId: "turn-streaming",
          role: "assistant",
          text: "Streaming zircon final answer.",
          createdAt: at(3),
          isStreaming: true,
        });
        yield* insertThreadSearchTurn({
          threadId: "thread-safe",
          turnId: "turn-streaming",
          assistantMessageId: "message-streaming-final",
          requestedAt: at(3),
        });
        yield* insertThreadSearchMessage({
          messageId: "message-interim",
          threadId: "thread-safe",
          turnId: "turn-streaming",
          role: "assistant",
          text: "Interim zircon reasoning.",
          createdAt: at(4),
        });
        yield* insertThreadSearchMessage({
          messageId: "message-system",
          threadId: "thread-safe",
          role: "system",
          text: "System zircon instruction.",
          createdAt: at(5),
        });
        yield* insertThreadSearchMessage({
          messageId: "message-tool",
          threadId: "thread-safe",
          role: "tool",
          text: "Tool zircon output.",
          createdAt: at(6),
        });
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            'activity-tool-output', 'thread-safe', 'turn-streaming', 'tool', 'tool.completed',
            'Ran grep for zircon', '{"output":"zircon appears in tool output"}', ${at(7)}
          )
        `;
        yield* insertThreadSearchMessage({
          messageId: "message-deleted-thread",
          threadId: "thread-deleted",
          role: "user",
          text: "Deleted zircon thread.",
          createdAt: at(8),
        });
        yield* insertThreadSearchMessage({
          messageId: "message-deleted-project",
          threadId: "thread-in-deleted-project",
          role: "user",
          text: "Deleted project zircon thread.",
          createdAt: at(9),
        });

        const evidence = yield* collectThreadSearchEvidence("zircon");
        assert.deepStrictEqual(
          evidence.map((match) => [match.threadId, match.source]),
          [[ThreadId.make("thread-safe"), "user"]],
        );
        assert.match(evidence[0]?.excerpt ?? "", /visible zircon note/);

        const catalog = yield* collectThreadSearchPages((cursor) =>
          readThreadSearchCatalogPage(cursor, 50),
        );
        assert.deepStrictEqual(
          catalog.flat().map((entry) => entry.threadId),
          [ThreadId.make("thread-safe")],
        );
      }),
  );

  it.effect(
    "pages thread search evidence beyond the first result limit with a fixed statement count per page",
    () =>
      Effect.gen(function* () {
        yield* resetThreadSearchTables;
        yield* insertThreadSearchProject({ projectId: "project-paged", title: "Paged project" });
        // Every thread and message shares one timestamp, so only a cursor that
        // breaks ties by identity can page through them without gaps.
        const sharedTimestamp = "2026-06-01T00:00:00.000Z";
        const matchCount = THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE + 7;
        const expectedLabels: Array<string> = [];
        for (let index = 0; index < matchCount; index += 1) {
          const label = `paged pyrite ${String(index).padStart(3, "0")}`;
          expectedLabels.push(label);
          yield* insertThreadSearchThread({
            threadId: `thread-paged-${index}`,
            projectId: "project-paged",
            title: `Paged ${index}`,
            updatedAt: sharedTimestamp,
          });
          yield* insertThreadSearchMessage({
            messageId: `message-paged-${index}`,
            threadId: `thread-paged-${index}`,
            role: "user",
            text: `Remember the ${label} decision.`,
            createdAt: sharedTimestamp,
          });
        }

        // Database work per page is a fixed number of statements: it does not
        // grow with the page size or with the number of matching threads.
        const smallPageCounter = makeSqlStatementCounter();
        yield* readThreadSearchEvidencePage(undefined, "paged pyrite", 1).pipe(
          Effect.withTracer(smallPageCounter.tracer),
        );
        const counter = makeSqlStatementCounter();
        const firstPage = yield* readThreadSearchEvidencePage(
          undefined,
          "paged pyrite",
          THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE,
        ).pipe(Effect.withTracer(counter.tracer));
        assert.strictEqual(counter.count(), smallPageCounter.count());
        assert.isAtMost(counter.count(), 2);
        assert.strictEqual(firstPage.entries.length, THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE);
        assert.isNotNull(firstPage.nextCursor);

        const defaultPage = yield* readThreadSearchEvidencePage(undefined, "paged pyrite");
        assert.isAtMost(defaultPage.entries.length, THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE);

        const everyMatch = yield* collectThreadSearchEvidence(
          "paged pyrite",
          THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE,
        );
        const labels = everyMatch.map(
          (match) => /paged pyrite \d{3}/.exec(match.excerpt)?.[0] ?? match.excerpt,
        );
        assert.strictEqual(new Set(labels).size, labels.length);
        assert.deepStrictEqual(labels.toSorted(), expectedLabels);

        const catalogCounter = makeSqlStatementCounter();
        const catalogPage = yield* readThreadSearchCatalogPage(
          undefined,
          THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE,
        ).pipe(Effect.withTracer(catalogCounter.tracer));
        assert.isAtMost(catalogCounter.count(), 2);
        assert.isAtMost(catalogPage.entries.length, THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE);

        yield* insertThreadSearchMessage({
          messageId: "message-paged-huge",
          threadId: "thread-paged-0",
          role: "user",
          text: `${"a".repeat(20_000)} buried beryl detail ${"b".repeat(20_000)}`,
          createdAt: sharedTimestamp,
        });
        const huge = yield* collectThreadSearchEvidence("buried beryl");
        assert.strictEqual(huge.length, 1);
        assert.isAtMost(
          huge[0]?.excerpt.length ?? Infinity,
          THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
        );
        assert.include(huge[0]?.excerpt ?? "", "buried beryl detail");
      }),
  );

  it.effect("narrows thread search evidence to one thread and restarts on a foreign cursor", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* insertThreadSearchProject({ projectId: "project-inspect", title: "Inspect" });
      for (const threadId of ["thread-inspect-a", "thread-inspect-b"]) {
        yield* insertThreadSearchThread({
          threadId,
          projectId: "project-inspect",
          title: threadId,
          updatedAt: "2026-06-01T00:00:00.000Z",
        });
        yield* insertThreadSearchMessage({
          messageId: `message-${threadId}`,
          threadId,
          role: "user",
          text: "An olivine clue.",
          createdAt: "2026-06-01T00:00:00.000Z",
        });
      }

      const narrowed = yield* snapshotQuery.searchThreadEvidence({
        query: "olivine",
        threadId: ThreadId.make("thread-inspect-b"),
      });
      assert.deepStrictEqual(
        narrowed.matches.map((match) => [match.threadId, match.messageId]),
        [[ThreadId.make("thread-inspect-b"), asMessageId("message-thread-inspect-b")]],
      );

      // A catalog cursor is not an evidence boundary: evidence restarts at page one.
      const catalogPage = yield* snapshotQuery.listThreadSearchCatalog({ limit: 1 });
      assert.isNotNull(catalogPage.nextCursor);
      const restarted = yield* snapshotQuery.searchThreadEvidence({
        query: "olivine",
        cursor: catalogPage.nextCursor ?? "",
      });
      assert.strictEqual(restarted.matches.length, 2);
    }),
  );

  it.effect(
    "keeps a running turn's linked assistant text out of evidence but not out of lexical search",
    () =>
      Effect.gen(function* () {
        yield* resetThreadSearchTables;
        const sql = yield* SqlClient.SqlClient;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* insertThreadSearchProject({ projectId: "project-running", title: "Running" });
        yield* insertThreadSearchThread({
          threadId: "thread-running",
          projectId: "project-running",
          title: "Running thread",
          updatedAt: "2026-06-01T00:00:00.000Z",
        });
        const turns = [
          ["running", "running"],
          ["interrupted", "interrupted"],
          ["error", "error"],
        ] as const;
        for (const [index, [turnId, state]] of turns.entries()) {
          const createdAt = `2026-06-01T00:00:0${index}.000Z`;
          yield* insertThreadSearchMessage({
            messageId: `message-${turnId}`,
            threadId: "thread-running",
            turnId,
            role: "assistant",
            text: `The ${state} spinel answer.`,
            createdAt,
          });
          yield* insertThreadSearchTurn({
            threadId: "thread-running",
            turnId,
            assistantMessageId: `message-${turnId}`,
            requestedAt: createdAt,
            state,
          });
        }

        const settled = yield* collectThreadSearchEvidence("spinel answer");
        assert.deepStrictEqual(settled.map((match) => match.messageId).toSorted(), [
          asMessageId("message-error"),
          asMessageId("message-interrupted"),
        ]);
        // The lexical picker keeps its original predicate, which ignores turn state.
        const lexical = yield* snapshotQuery.searchThreads({ query: "running spinel" });
        assert.deepStrictEqual(
          lexical.matches.map((match) => match.threadId),
          [ThreadId.make("thread-running")],
        );

        yield* sql`UPDATE projection_turns SET state = 'completed' WHERE turn_id = 'running'`;
        const afterCompletion = yield* collectThreadSearchEvidence("running spinel");
        assert.deepStrictEqual(
          afterCompletion.map((match) => match.messageId),
          [asMessageId("message-running")],
        );
      }),
  );

  it.effect("caps thread and project titles in thread search catalog and evidence pages", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      // Astral characters are two UTF-16 units each, the unit the schema counts.
      const longThreadTitle = "🪨".repeat(THREAD_SEARCH_TITLE_MAX_LENGTH + 5);
      const longProjectTitle = "p".repeat(THREAD_SEARCH_TITLE_MAX_LENGTH * 20);
      yield* insertThreadSearchProject({ projectId: "project-long", title: longProjectTitle });
      yield* insertThreadSearchThread({
        threadId: "thread-long-title",
        projectId: "project-long",
        title: longThreadTitle,
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      yield* insertThreadSearchMessage({
        messageId: "message-long-title",
        threadId: "thread-long-title",
        role: "user",
        text: "A tourmaline note.",
        createdAt: "2026-06-01T00:00:00.000Z",
      });

      const catalog = (yield* readThreadSearchCatalogPage(undefined, 10)).entries;
      const evidence = yield* collectThreadSearchEvidence("tourmaline");
      // The RPC encodes each page with the contract schema, so a page the
      // schema rejects fails the whole request instead of arriving truncated.
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      assert.isTrue(
        isThreadSearchCatalogPage(yield* snapshotQuery.listThreadSearchCatalog({ limit: 10 })),
      );
      assert.isTrue(
        isThreadSearchEvidencePage(
          yield* snapshotQuery.searchThreadEvidence({ query: "tourmaline" }),
        ),
      );
      for (const entry of [...catalog, ...evidence]) {
        assert.isAtMost(entry.title.length, THREAD_SEARCH_TITLE_MAX_LENGTH);
        assert.isAtMost(entry.projectTitle.length, THREAD_SEARCH_TITLE_MAX_LENGTH);
        assert.isTrue(entry.title.startsWith("🪨"));
        assert.isTrue(entry.title.endsWith("…"));
        assert.notMatch(entry.title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        assert.isTrue(entry.projectTitle.endsWith("…"));
      }
      assert.strictEqual(catalog.length, 1);
      assert.strictEqual(evidence.length, 1);
    }),
  );

  it.effect("scans at most one budget of messages per evidence request and resumes below it", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      const sql = yield* SqlClient.SqlClient;
      yield* insertThreadSearchProject({ projectId: "project-scan", title: "Scan" });
      yield* insertThreadSearchThread({
        threadId: "thread-scan",
        projectId: "project-scan",
        title: "Scan thread",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      // The only match is inserted first, so it sits below more than two scan
      // windows of newer non-matching messages.
      yield* insertThreadSearchMessage({
        messageId: "message-scan-match",
        threadId: "thread-scan",
        role: "user",
        text: "The lone chrysoberyl remark.",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      const fillerCount = THREAD_SEARCH_EVIDENCE_SCAN_BUDGET * 2 + 10;
      yield* sql`
          WITH RECURSIVE filler(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < ${fillerCount}
          )
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          )
          SELECT
            'message-scan-filler-' || n, 'thread-scan', NULL, 'user', 'Filler ' || n, 0,
            '2026-06-01T00:00:01.000Z', '2026-06-01T00:00:01.000Z'
          FROM filler
        `;

      const firstPage = yield* readThreadSearchEvidencePage(undefined, "chrysoberyl");
      assert.deepStrictEqual(firstPage.entries, []);
      assert.isNotNull(firstPage.nextCursor);

      const pages = yield* collectThreadSearchPages((cursor) =>
        readThreadSearchEvidencePage(cursor, "chrysoberyl"),
      );
      assert.strictEqual(pages.length, 3);
      assert.deepStrictEqual(
        pages.flat().map((match) => match.messageId),
        [asMessageId("message-scan-match")],
      );

      // The thread filter scans the same bounded windows within one thread.
      const narrowed = yield* collectThreadSearchPages((cursor) =>
        Effect.gen(function* () {
          const query = yield* ProjectionSnapshotQuery;
          const page = yield* query.searchThreadEvidence({
            query: "chrysoberyl",
            threadId: ThreadId.make("thread-scan"),
            ...withThreadSearchCursor(cursor),
          });
          return { entries: page.matches, nextCursor: page.nextCursor };
        }),
      );
      assert.strictEqual(narrowed.length, 3);
      assert.strictEqual(narrowed.flat().length, 1);
    }),
  );

  it.effect("binds an evidence cursor to its query and thread filter", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* insertThreadSearchProject({ projectId: "project-bound", title: "Bound" });
      yield* insertThreadSearchThread({
        threadId: "thread-bound",
        projectId: "project-bound",
        title: "Bound thread",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      // Oldest to newest: two garnet matches, then a beryl match that a garnet
      // cursor would skip if another search accepted it.
      for (const [index, text] of ["garnet one", "garnet two", "beryl newest"].entries()) {
        yield* insertThreadSearchMessage({
          messageId: `message-bound-${index}`,
          threadId: "thread-bound",
          role: "user",
          text,
          createdAt: `2026-06-01T00:00:0${index}.000Z`,
        });
      }

      const garnetFirst = yield* snapshotQuery.searchThreadEvidence({ query: "garnet", limit: 1 });
      assert.deepStrictEqual(
        garnetFirst.matches.map((match) => match.messageId),
        [asMessageId("message-bound-1")],
      );
      const garnetCursor = garnetFirst.nextCursor ?? "";

      // The same search, differing only in ASCII case, continues the walk.
      const garnetSecond = yield* snapshotQuery.searchThreadEvidence({
        query: "GARNET",
        cursor: garnetCursor,
      });
      assert.deepStrictEqual(
        garnetSecond.matches.map((match) => match.messageId),
        [asMessageId("message-bound-0")],
      );

      // Another query, or the same query narrowed to a thread, restarts at page one.
      const beryl = yield* snapshotQuery.searchThreadEvidence({
        query: "beryl",
        cursor: garnetCursor,
      });
      assert.deepStrictEqual(
        beryl.matches.map((match) => match.messageId),
        [asMessageId("message-bound-2")],
      );
      const narrowed = yield* snapshotQuery.searchThreadEvidence({
        query: "garnet",
        threadId: ThreadId.make("thread-bound"),
        cursor: garnetCursor,
      });
      assert.deepStrictEqual(
        narrowed.matches.map((match) => match.messageId),
        [asMessageId("message-bound-1"), asMessageId("message-bound-0")],
      );
    }),
  );

  it.effect("plans a global evidence request as a rowid window read without sorting history", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const plans = yield* planStatementsOf(
        snapshotQuery.searchThreadEvidence({ query: "plan probe" }),
      );
      assertBoundedEvidencePlans(plans);
    }),
  );

  it.effect("plans a thread-filtered evidence request without sorting the thread's history", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const plans = yield* planStatementsOf(
        snapshotQuery.searchThreadEvidence({
          query: "plan probe",
          threadId: ThreadId.make("thread-plan-probe"),
        }),
      );
      assertBoundedEvidencePlans(plans);
    }),
  );

  it.effect("pages thread-filtered evidence through matches that share one timestamp", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      yield* insertThreadSearchProject({ projectId: "project-ties", title: "Ties" });
      for (const threadId of ["thread-ties", "thread-ties-other"]) {
        yield* insertThreadSearchThread({
          threadId,
          projectId: "project-ties",
          title: threadId,
          updatedAt: "2026-06-01T00:00:00.000Z",
        });
      }
      const expected: Array<MessageId> = [];
      for (let index = 0; index < 7; index += 1) {
        const messageId = `message-ties-${index}`;
        expected.push(asMessageId(messageId));
        yield* insertThreadSearchMessage({
          messageId,
          threadId: "thread-ties",
          role: "user",
          text: `A tied lapis note ${index}.`,
          createdAt: "2026-06-01T00:00:00.000Z",
        });
      }
      // A match in another thread with the same timestamp must stay out.
      yield* insertThreadSearchMessage({
        messageId: "message-ties-elsewhere",
        threadId: "thread-ties-other",
        role: "user",
        text: "A tied lapis note elsewhere.",
        createdAt: "2026-06-01T00:00:00.000Z",
      });

      const pages = yield* collectThreadFilteredEvidencePages("lapis note", "thread-ties", 3);
      for (const page of pages) assert.isAtMost(page.length, 3);
      const delivered = pages.flat().map((match) => match.messageId ?? "");
      assert.strictEqual(new Set(delivered).size, delivered.length);
      assert.deepStrictEqual(delivered.toSorted(), expected.toSorted());
    }),
  );

  it.effect("keeps a thread-filtered evidence cursor within its limit for a long message id", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      yield* insertThreadSearchProject({ projectId: "project-long-id", title: "Long id" });
      yield* insertThreadSearchThread({
        threadId: "thread-long-id",
        projectId: "project-long-id",
        title: "Long id thread",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      // MessageId has no length limit, and a thread cursor carries the
      // boundary message id. This one alone outgrows the cursor limit.
      const expected: Array<MessageId> = [];
      for (let index = 0; index < 3; index += 1) {
        const messageId = `message-long-id-${index}-${"x".repeat(THREAD_SEARCH_CURSOR_MAX_LENGTH)}`;
        expected.push(asMessageId(messageId));
        yield* insertThreadSearchMessage({
          messageId,
          threadId: "thread-long-id",
          role: "user",
          text: `A sodalite remark ${index}.`,
          createdAt: `2026-06-01T00:00:0${index}.000Z`,
        });
      }

      const pages = yield* collectThreadFilteredEvidencePages(
        "sodalite remark",
        "thread-long-id",
        1,
      );
      assert.deepStrictEqual(
        pages
          .flat()
          .map((match) => match.messageId ?? "")
          .toSorted(),
        expected.toSorted(),
      );
    }),
  );

  it.effect("resumes a thread evidence walk after its boundary message is deleted", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      // Walk order is (created_at, message_id) descending: m-d, m-c, m-b, then
      // the older m-a. m-d is delivered first and becomes the boundary.
      yield* insertDeletedBoundaryFixture("thread-deleted-boundary", [
        { messageId: "m-a", createdAt: "2026-06-01T00:00:00.000Z" },
        { messageId: "m-b", createdAt: "2026-06-01T00:00:01.000Z" },
        { messageId: "m-c", createdAt: "2026-06-01T00:00:01.000Z" },
        { messageId: "m-d", createdAt: "2026-06-01T00:00:01.000Z" },
      ]);
      const walk = yield* walkThreadEvidencePastDeletedBoundary(
        "boundary jasper",
        "thread-deleted-boundary",
      );
      assert.strictEqual(walk.boundary?.messageId, "m-d");
      assertDeletedBoundaryWalk(walk, ["m-c", "m-b", "m-a"]);
    }),
  );

  it.effect(
    "resumes a thread evidence walk after a deleted boundary with high-Unicode message ids",
    () =>
      Effect.gen(function* () {
        yield* resetThreadSearchTables;
        // SQLite compares TEXT as UTF-8 bytes. Code points above U+FFFF encode
        // from 0xF0, above the fallback U+FFFF (0xEF 0xBF 0xBF), so these ids
        // sort above it: walk order is 😀-b, 😀-a, then m-c, then the older m-a.
        yield* insertDeletedBoundaryFixture("thread-unicode-boundary", [
          { messageId: "m-a", createdAt: "2026-06-01T00:00:00.000Z" },
          { messageId: "m-c", createdAt: "2026-06-01T00:00:01.000Z" },
          { messageId: "😀-a", createdAt: "2026-06-01T00:00:01.000Z" },
          { messageId: "😀-b", createdAt: "2026-06-01T00:00:01.000Z" },
        ]);
        const walk = yield* walkThreadEvidencePastDeletedBoundary(
          "boundary jasper",
          "thread-unicode-boundary",
        );
        assert.strictEqual(walk.boundary?.messageId, "😀-b");
        assertDeletedBoundaryWalk(walk, ["😀-a", "m-c", "m-a"]);
      }),
  );

  it.effect(
    "plans resumed thread evidence pages as bounded index reads with and without their boundary",
    () =>
      Effect.gen(function* () {
        yield* resetThreadSearchTables;
        const sql = yield* SqlClient.SqlClient;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* insertDeletedBoundaryFixture("thread-resume-plan", [
          { messageId: "m-a", createdAt: "2026-06-01T00:00:00.000Z" },
          { messageId: "m-b", createdAt: "2026-06-01T00:00:01.000Z" },
          { messageId: "m-c", createdAt: "2026-06-01T00:00:01.000Z" },
        ]);
        const threadId = ThreadId.make("thread-resume-plan");
        const first = yield* snapshotQuery.searchThreadEvidence({
          query: "boundary jasper",
          threadId,
          limit: 1,
        });
        const cursor = first.nextCursor ?? "";
        assert.notStrictEqual(cursor, "");
        const resume = snapshotQuery.searchThreadEvidence({
          query: "boundary jasper",
          threadId,
          limit: 1,
          cursor,
        });

        // Boundary present: rowid lookup, then the keyset range on the index.
        const present = yield* planStatementsOf(resume);
        assertBoundedEvidencePlans(present, 3);

        // Boundary gone: the lookup finds nothing and the walk resumes on
        // created_at alone, still a range on the same index.
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id = ${first.matches[0]?.messageId ?? ""}`;
        const missing = yield* planStatementsOf(resume);
        assertBoundedEvidencePlans(missing, 3);
        assert.notDeepEqual(missing, present);
      }),
  );

  it.effect("keeps lexical searchThreads active-only and capped at fifty threads", () =>
    Effect.gen(function* () {
      yield* resetThreadSearchTables;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* insertThreadSearchProject({ projectId: "project-lexical", title: "Lexical" });
      for (let index = 0; index < 55; index += 1) {
        yield* insertThreadSearchThread({
          threadId: `thread-lexical-${index}`,
          projectId: "project-lexical",
          title: `Lexical ${index}`,
          updatedAt: "2026-06-01T00:00:00.000Z",
        });
        yield* insertThreadSearchMessage({
          messageId: `message-lexical-${index}`,
          threadId: `thread-lexical-${index}`,
          role: "user",
          text: "A lexical garnet mention.",
          createdAt: "2026-06-01T00:00:00.000Z",
        });
      }
      yield* insertThreadSearchThread({
        threadId: "thread-lexical-archived",
        projectId: "project-lexical",
        title: "Lexical archived",
        updatedAt: "2026-06-09T00:00:00.000Z",
        archivedAt: "2026-06-09T00:00:00.000Z",
      });
      yield* insertThreadSearchMessage({
        messageId: "message-lexical-archived",
        threadId: "thread-lexical-archived",
        role: "user",
        text: "An archived lexical garnet mention.",
        createdAt: "2026-06-09T00:00:00.000Z",
      });

      const defaultResult = yield* snapshotQuery.searchThreads({ query: "lexical garnet" });
      assert.strictEqual(defaultResult.matches.length, 50);
      assert.isFalse(
        defaultResult.matches.some((match) => match.threadId === "thread-lexical-archived"),
      );
      assert.deepStrictEqual(Object.keys(defaultResult.matches[0] ?? {}).toSorted(), [
        "messageCreatedAt",
        "projectId",
        "snippet",
        "source",
        "threadId",
      ]);
      const limited = yield* snapshotQuery.searchThreads({ query: "lexical garnet", limit: 3 });
      assert.strictEqual(limited.matches.length, 3);
    }),
  );
});
