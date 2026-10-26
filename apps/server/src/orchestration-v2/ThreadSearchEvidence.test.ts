// Mesura: agent thread search reads on the V2 projection tables. The lexical
// guard at the end pins the behavior of upstream's ThreadSearch that the picker
// depends on, which the evidence API must leave unchanged.
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  OrchestrationThreadSearchCatalogPage,
  OrchestrationThreadSearchEvidencePage,
  ProjectId,
  ProviderInstanceId,
  RunId,
  THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE,
  THREAD_SEARCH_CURSOR_MAX_LENGTH,
  THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
  THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE,
  THREAD_SEARCH_PROJECT_ID,
  THREAD_SEARCH_TITLE_MAX_LENGTH,
  ThreadId,
  type OrchestrationThreadSearchEvidence,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { makeSqlStatementCounter } from "../../integration/SqlStatementCounter.integration.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import * as ThreadSearchEvidence from "./ThreadSearchEvidence.ts";

const layerTest = Layer.mergeAll(
  ThreadSearchEvidence.layer,
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

type TestServices = Layer.Success<typeof layerTest>;

// Every spec gets its own in-memory database, so no spec sees another's rows.
const withFreshDatabase = <A, E>(effect: Effect.Effect<A, E, TestServices>) =>
  effect.pipe(Effect.provide(layerTest));

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
const THREAD_CREATED_AT = "2026-06-01T00:00:00.000Z";
const asMessageId = (value: string): MessageId => MessageId.make(value);

const insertProject = (input: {
  readonly projectId: string;
  readonly title: string;
  readonly deletedAt?: string;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectId = ProjectId.make(input.projectId);
    const envelope = {
      sequence: 0,
      aggregateKind: "project",
      aggregateId: projectId,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    } as const;
    yield* projects.apply({
      ...envelope,
      eventId: EventId.make(`created:${input.projectId}`),
      occurredAt: THREAD_CREATED_AT,
      type: "project.created",
      payload: {
        projectId,
        title: input.title,
        workspaceRoot: `/work/${input.projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: THREAD_CREATED_AT,
        updatedAt: THREAD_CREATED_AT,
      },
    });
    if (input.deletedAt !== undefined) {
      yield* projects.apply({
        ...envelope,
        eventId: EventId.make(`deleted:${input.projectId}`),
        occurredAt: input.deletedAt,
        type: "project.deleted",
        payload: { projectId, deletedAt: input.deletedAt },
      });
    }
  });

const insertThread = (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(input.threadId);
    const createdAt = DateTime.makeUnsafe(THREAD_CREATED_AT);
    yield* projections.apply({
      id: EventId.make(`created:${input.threadId}`),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: createdAt,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(input.projectId),
        title: input.title,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt,
        updatedAt: DateTime.makeUnsafe(input.updatedAt),
        archivedAt: input.archivedAt === undefined ? null : DateTime.makeUnsafe(input.archivedAt),
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: input.deletedAt === undefined ? null : DateTime.makeUnsafe(input.deletedAt),
      },
    });
  });

const insertMessage = (input: {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
  readonly runId?: string;
  readonly streaming?: boolean;
}) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(input.threadId);
    const createdAt = DateTime.makeUnsafe(input.createdAt);
    yield* projections.apply({
      id: EventId.make(`message:${input.messageId}`),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt: createdAt,
      payload: {
        createdBy: input.role === "user" ? "user" : "agent",
        creationSource: input.role === "user" ? "web" : "provider",
        id: asMessageId(input.messageId),
        threadId,
        runId: input.runId === undefined ? null : RunId.make(input.runId),
        nodeId: null,
        role: input.role,
        text: input.text,
        attachments: [],
        streaming: input.streaming ?? false,
        createdAt,
        updatedAt: createdAt,
      },
    });
  });

const insertRun = (input: {
  readonly runId: string;
  readonly threadId: string;
  readonly ordinal: number;
  readonly status: OrchestrationV2RunStatus;
  readonly requestedAt: string;
}) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(input.threadId);
    const runId = RunId.make(input.runId);
    const requestedAt = DateTime.makeUnsafe(input.requestedAt);
    yield* projections.apply({
      id: EventId.make(`run:${input.runId}`),
      type: "run.created",
      threadId,
      runId,
      occurredAt: requestedAt,
      payload: {
        id: runId,
        threadId,
        ordinal: input.ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: asMessageId(`message:${input.runId}:user`),
        rootNodeId: NodeId.make(`node:${input.runId}`),
        activeAttemptId: null,
        status: input.status,
        requestedAt,
        startedAt: requestedAt,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  });

/**
 * Inserts `count` non-matching user messages straight into the projection
 * table; thousands of store events would only slow the spec down. With
 * `secondsApart` the n-th filler is n seconds after `createdAt`, otherwise
 * every filler shares `createdAt`.
 */
const insertFillerMessages = (input: {
  readonly threadId: string;
  readonly messageIdPrefix: string;
  readonly count: number;
  readonly createdAt: string;
  readonly secondsApart: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = input.secondsApart
      ? sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${input.createdAt}, '+' || n || ' seconds')`
      : sql`${input.createdAt}`;
    yield* sql`
      WITH RECURSIVE filler(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < ${input.count}
      )
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
        payload_json
      )
      SELECT
        ${input.messageIdPrefix} || n, ${input.threadId}, NULL, NULL, 'user', 0,
        ${createdAt}, ${createdAt}, json_object('text', 'Unrelated filler message number ' || n)
      FROM filler
    `;
  });

const deleteMessage = (messageId: string | undefined) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = ${messageId ?? ""}`,
  );

interface ThreadSearchPage<A> {
  readonly entries: ReadonlyArray<A>;
  readonly nextCursor: string | null;
}

// Follows `nextCursor` until the API reports the last page. The page ceiling
// turns a cursor that never advances into a failure instead of a hang.
const collectPages = <A, E, R>(
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

const withCursor = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

const readCatalogPage = (cursor: string | undefined, limit: number) =>
  Effect.gen(function* () {
    const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
    const page = yield* search.listThreadSearchCatalog({ ...withCursor(cursor), limit });
    return { entries: page.threads, nextCursor: page.nextCursor };
  });

const readEvidencePage = (cursor: string | undefined, query: string, limit?: number) =>
  Effect.gen(function* () {
    const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
    const page = yield* search.searchThreadEvidence({
      query,
      ...withCursor(cursor),
      ...(limit === undefined ? {} : { limit }),
    });
    return { entries: page.matches, nextCursor: page.nextCursor };
  });

const collectEvidence = (query: string, limit?: number) =>
  collectPages((cursor) => readEvidencePage(cursor, query, limit)).pipe(
    Effect.map((pages) => pages.flat()),
  );

const isCatalogPage = Schema.is(OrchestrationThreadSearchCatalogPage);
const isEvidencePage = Schema.is(OrchestrationThreadSearchEvidencePage);

// Walks one thread's evidence, checking every page against the contract the
// RPC encodes it with, so a page the wire would reject fails here too.
const collectThreadFilteredEvidencePages = (query: string, threadId: string, limit: number) =>
  collectPages((cursor) =>
    Effect.gen(function* () {
      const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
      const page = yield* search.searchThreadEvidence({
        query,
        threadId: ThreadId.make(threadId),
        limit,
        ...withCursor(cursor),
      });
      assert.isTrue(
        isEvidencePage(page),
        `evidence page violates its contract; nextCursor length ${page.nextCursor?.length}`,
      );
      return { entries: page.matches, nextCursor: page.nextCursor };
    }),
  );

/**
 * Runs `effect` and returns SQLite's plan for every statement it executed. The
 * SQL comes from the `db.query.text` attribute of each SQL client span, so the
 * plan is the one of the statement the service really sent. SQLite plans at
 * prepare time, so leaving the parameters unbound does not change it.
 */
const planStatementsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        if (options.kind === "client") spans.push(span);
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
      plan.some((detail) => /^SCAN (messages|threads|projects|runs)\b/.test(detail)),
      text,
    );
    assert.match(
      plan.find((detail) => / (messages|orchestration_v2_projection_messages) /.test(detail)) ?? "",
      /^SEARCH /,
      text,
    );
  }
};

/**
 * Pages one match at a time and deletes the first cursor's message before
 * resuming, as a rowid-renumbering rebuild would. The walk must still reach every
 * match below the boundary, repeating at most those sharing its timestamp.
 */
const walkThreadEvidencePastDeletedBoundary = (query: string, threadId: string) =>
  Effect.gen(function* () {
    const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
    const first = yield* search.searchThreadEvidence({
      query,
      threadId: ThreadId.make(threadId),
      limit: 1,
    });
    const boundary = first.matches[0];
    assert.isDefined(boundary);
    assert.isNotNull(first.nextCursor);
    yield* deleteMessage(boundary?.messageId);
    const later = yield* collectPages((cursor) =>
      Effect.gen(function* () {
        const page = yield* search.searchThreadEvidence({
          query,
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
    yield* insertProject({ projectId: `project-${threadId}`, title: "Boundary" });
    yield* insertThread({
      threadId,
      projectId: `project-${threadId}`,
      title: threadId,
      updatedAt: THREAD_CREATED_AT,
    });
    for (const message of messages) {
      yield* insertMessage({
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

it.effect(
  "lists compact thread search catalog entries from active and archived threads across stable pages",
  () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sameUpdatedAt = "2026-06-02T00:00:00.000Z";
        yield* insertProject({ projectId: "project-alpha", title: "Alpha" });
        for (const index of [1, 2, 3, 4, 5]) {
          yield* insertThread({
            threadId: `thread-catalog-${index}`,
            projectId: "project-alpha",
            title: `Catalog ${index}`,
            updatedAt: sameUpdatedAt,
          });
        }
        yield* insertThread({
          threadId: "thread-catalog-archived",
          projectId: "project-alpha",
          title: "Catalog archived",
          updatedAt: sameUpdatedAt,
          archivedAt: "2026-06-03T00:00:00.000Z",
        });

        const firstPage = yield* readCatalogPage(undefined, 2);
        assert.isAtMost(firstPage.entries.length, 2);
        assert.isNotNull(firstPage.nextCursor);
        // A thread that changes after the first page must not shift the
        // remaining pages: no entry is repeated and none is skipped.
        yield* insertThread({
          threadId: "thread-catalog-late",
          projectId: "project-alpha",
          title: "Catalog late",
          updatedAt: "2026-06-04T00:00:00.000Z",
        });
        const laterPages = yield* collectPages((cursor) =>
          readCatalogPage(cursor ?? firstPage.nextCursor ?? undefined, 2),
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
        assert.deepStrictEqual(archivedEntry, {
          threadId: ThreadId.make("thread-catalog-archived"),
          projectId: ProjectId.make("project-alpha"),
          title: "Catalog archived",
          projectTitle: "Alpha",
          archivedAt: "2026-06-03T00:00:00.000Z",
          updatedAt: sameUpdatedAt,
        });
      }),
    ),
);

it.effect("finds thread search evidence deep in long and archived threads", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      yield* insertProject({ projectId: "project-deep", title: "Deep project" });
      yield* insertThread({
        threadId: "thread-long",
        projectId: "project-deep",
        title: "Long conversation",
        updatedAt: "2026-06-05T00:00:00.000Z",
      });
      yield* insertThread({
        threadId: "thread-shelved",
        projectId: "project-deep",
        title: "Shelved conversation",
        updatedAt: "2026-06-01T00:00:00.000Z",
        archivedAt: "2026-06-02T00:00:00.000Z",
      });

      // The oldest message of a 400-message thread carries the only match.
      yield* insertMessage({
        messageId: "message-long-first",
        threadId: "thread-long",
        role: "user",
        text: "We decided on the quartzite migration plan before anything else.",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      yield* insertFillerMessages({
        threadId: "thread-long",
        messageIdPrefix: "message-long-filler-",
        count: 400,
        createdAt: "2026-06-01T00:00:00.000Z",
        secondsApart: true,
      });
      yield* insertRun({
        runId: "run-long-middle",
        threadId: "thread-long",
        ordinal: 1,
        status: "completed",
        requestedAt: "2026-06-01T00:03:20.000Z",
      });
      yield* insertMessage({
        messageId: "message-long-final",
        threadId: "thread-long",
        runId: "run-long-middle",
        role: "assistant",
        text: "Final answer: the basalt rollout finished cleanly.",
        createdAt: "2026-06-01T00:03:20.500Z",
      });

      yield* insertMessage({
        messageId: "message-shelved-user",
        threadId: "thread-shelved",
        role: "user",
        text: "Why does the obsidian cache evict too early?",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      yield* insertRun({
        runId: "run-shelved",
        threadId: "thread-shelved",
        ordinal: 1,
        status: "completed",
        requestedAt: "2026-06-01T00:00:00.500Z",
      });
      yield* insertMessage({
        messageId: "message-shelved-final",
        threadId: "thread-shelved",
        runId: "run-shelved",
        role: "assistant",
        text: "The obsidian cache used the wrong clock.",
        createdAt: "2026-06-01T00:00:01.000Z",
      });

      const oldest = yield* collectEvidence("QUARTZITE migration");
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
          projectId: ProjectId.make("project-deep"),
          title: "Long conversation",
          projectTitle: "Deep project",
          archivedAt: null,
          source: "user",
          messageCreatedAt: "2026-06-01T00:00:00.000Z",
        },
      );
      assert.match(oldest[0]?.excerpt ?? "", /quartzite migration/i);

      const finalAnswer = yield* collectEvidence("basalt rollout");
      assert.deepStrictEqual(
        finalAnswer.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-long"), "assistant"]],
      );

      const archived = yield* collectEvidence("obsidian cache");
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
  ),
);

it.effect(
  "keeps deleted, streaming, unsettled, and system text out of thread search evidence",
  () =>
    withFreshDatabase(
      Effect.gen(function* () {
        yield* insertProject({ projectId: "project-live", title: "Live project" });
        yield* insertProject({
          projectId: "project-gone",
          title: "Gone project",
          deletedAt: "2026-06-03T00:00:00.000Z",
        });
        yield* insertThread({
          threadId: "thread-safe",
          projectId: "project-live",
          title: "Safe thread",
          updatedAt: "2026-06-02T00:00:00.000Z",
        });
        yield* insertThread({
          threadId: "thread-deleted",
          projectId: "project-live",
          title: "Deleted thread",
          updatedAt: "2026-06-02T00:00:00.000Z",
          deletedAt: "2026-06-03T00:00:00.000Z",
        });
        yield* insertThread({
          threadId: "thread-in-deleted-project",
          projectId: "project-gone",
          title: "Thread in a deleted project",
          updatedAt: "2026-06-02T00:00:00.000Z",
        });

        const at = (second: number) => `2026-06-01T00:00:${String(second).padStart(2, "0")}.000Z`;
        yield* insertMessage({
          messageId: "message-visible",
          threadId: "thread-safe",
          role: "user",
          text: "The visible zircon note.",
          createdAt: at(1),
        });
        yield* insertMessage({
          messageId: "message-streaming-user",
          threadId: "thread-safe",
          role: "user",
          text: "Streaming zircon draft.",
          createdAt: at(2),
          streaming: true,
        });
        yield* insertRun({
          runId: "run-streaming",
          threadId: "thread-safe",
          ordinal: 1,
          status: "completed",
          requestedAt: at(3),
        });
        yield* insertMessage({
          messageId: "message-streaming-final",
          threadId: "thread-safe",
          runId: "run-streaming",
          role: "assistant",
          text: "Streaming zircon final answer.",
          createdAt: at(3),
          streaming: true,
        });
        yield* insertRun({
          runId: "run-in-progress",
          threadId: "thread-safe",
          ordinal: 2,
          status: "running",
          requestedAt: at(4),
        });
        yield* insertMessage({
          messageId: "message-interim",
          threadId: "thread-safe",
          runId: "run-in-progress",
          role: "assistant",
          text: "Interim zircon reasoning.",
          createdAt: at(4),
        });
        yield* insertMessage({
          messageId: "message-system",
          threadId: "thread-safe",
          role: "system",
          text: "System zircon instruction.",
          createdAt: at(5),
        });
        yield* insertMessage({
          messageId: "message-deleted-thread",
          threadId: "thread-deleted",
          role: "user",
          text: "Deleted zircon thread.",
          createdAt: at(8),
        });
        yield* insertMessage({
          messageId: "message-deleted-project",
          threadId: "thread-in-deleted-project",
          role: "user",
          text: "Deleted project zircon thread.",
          createdAt: at(9),
        });

        const evidence = yield* collectEvidence("zircon");
        assert.deepStrictEqual(
          evidence.map((match) => [match.threadId, match.source]),
          [[ThreadId.make("thread-safe"), "user"]],
        );
        assert.match(evidence[0]?.excerpt ?? "", /visible zircon note/);

        const catalog = yield* collectPages((cursor) => readCatalogPage(cursor, 50));
        assert.deepStrictEqual(
          catalog.flat().map((entry) => entry.threadId),
          [ThreadId.make("thread-safe")],
        );
      }),
    ),
);

it.effect(
  "pages thread search evidence beyond the first result limit with a fixed statement count per page",
  () =>
    withFreshDatabase(
      Effect.gen(function* () {
        yield* insertProject({ projectId: "project-paged", title: "Paged project" });
        // Every thread and message shares one timestamp, so only a cursor that
        // breaks ties by identity can page through them without gaps.
        const sharedTimestamp = "2026-06-01T00:00:00.000Z";
        const matchCount = THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE + 7;
        const expectedLabels: Array<string> = [];
        for (let index = 0; index < matchCount; index += 1) {
          const label = `paged pyrite ${String(index).padStart(3, "0")}`;
          expectedLabels.push(label);
          yield* insertThread({
            threadId: `thread-paged-${index}`,
            projectId: "project-paged",
            title: `Paged ${index}`,
            updatedAt: sharedTimestamp,
          });
          yield* insertMessage({
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
        yield* readEvidencePage(undefined, "paged pyrite", 1).pipe(
          Effect.withTracer(smallPageCounter.tracer),
        );
        const counter = makeSqlStatementCounter();
        const firstPage = yield* readEvidencePage(
          undefined,
          "paged pyrite",
          THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE,
        ).pipe(Effect.withTracer(counter.tracer));
        assert.strictEqual(counter.count(), smallPageCounter.count());
        assert.isAtMost(counter.count(), 2);
        assert.strictEqual(firstPage.entries.length, THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE);
        assert.isNotNull(firstPage.nextCursor);

        const defaultPage = yield* readEvidencePage(undefined, "paged pyrite");
        assert.isAtMost(defaultPage.entries.length, THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE);

        const everyMatch = yield* collectEvidence(
          "paged pyrite",
          THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE,
        );
        const labels = everyMatch.map(
          (match) => /paged pyrite \d{3}/.exec(match.excerpt)?.[0] ?? match.excerpt,
        );
        assert.strictEqual(new Set(labels).size, labels.length);
        assert.deepStrictEqual(labels.toSorted(), expectedLabels);

        const catalogCounter = makeSqlStatementCounter();
        const catalogPage = yield* readCatalogPage(
          undefined,
          THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE,
        ).pipe(Effect.withTracer(catalogCounter.tracer));
        assert.isAtMost(catalogCounter.count(), 2);
        assert.isAtMost(catalogPage.entries.length, THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE);

        yield* insertMessage({
          messageId: "message-paged-huge",
          threadId: "thread-paged-0",
          role: "user",
          text: `${"a".repeat(20_000)} buried beryl detail ${"b".repeat(20_000)}`,
          createdAt: sharedTimestamp,
        });
        const huge = yield* collectEvidence("buried beryl");
        assert.strictEqual(huge.length, 1);
        assert.isAtMost(
          huge[0]?.excerpt.length ?? Infinity,
          THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
        );
        assert.include(huge[0]?.excerpt ?? "", "buried beryl detail");
        assert.isTrue(huge[0]?.excerpt.startsWith("…"));
        assert.isTrue(huge[0]?.excerpt.endsWith("…"));
      }),
    ),
);

it.effect("narrows thread search evidence to one thread and restarts on a foreign cursor", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
      yield* insertProject({ projectId: "project-inspect", title: "Inspect" });
      for (const threadId of ["thread-inspect-a", "thread-inspect-b"]) {
        yield* insertThread({
          threadId,
          projectId: "project-inspect",
          title: threadId,
          updatedAt: "2026-06-01T00:00:00.000Z",
        });
        yield* insertMessage({
          messageId: `message-${threadId}`,
          threadId,
          role: "user",
          text: "An olivine clue.",
          createdAt: "2026-06-01T00:00:00.000Z",
        });
      }

      const narrowed = yield* search.searchThreadEvidence({
        query: "olivine",
        threadId: ThreadId.make("thread-inspect-b"),
      });
      assert.deepStrictEqual(
        narrowed.matches.map((match) => [match.threadId, match.messageId]),
        [[ThreadId.make("thread-inspect-b"), asMessageId("message-thread-inspect-b")]],
      );

      // A catalog cursor is not an evidence boundary: evidence restarts at page one.
      const catalogPage = yield* search.listThreadSearchCatalog({ limit: 1 });
      assert.isNotNull(catalogPage.nextCursor);
      const restarted = yield* search.searchThreadEvidence({
        query: "olivine",
        cursor: catalogPage.nextCursor ?? "",
      });
      assert.strictEqual(restarted.matches.length, 2);
    }),
  ),
);

it.effect(
  "keeps an unsettled or rolled-back run's text out of evidence but not out of lexical search",
  () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lexical = yield* ThreadSearch.ThreadSearch;
        yield* insertProject({ projectId: "project-running", title: "Running" });
        yield* insertThread({
          threadId: "thread-running",
          projectId: "project-running",
          title: "Running thread",
          updatedAt: "2026-06-01T00:00:00.000Z",
        });
        const runs = [
          ["running", "running"],
          ["interrupted", "interrupted"],
          ["failed", "failed"],
          ["rolled-back", "rolled_back"],
        ] as const;
        for (const [index, [runId, status]] of runs.entries()) {
          const createdAt = `2026-06-01T00:00:0${index}.000Z`;
          yield* insertRun({
            runId,
            threadId: "thread-running",
            ordinal: index + 1,
            status,
            requestedAt: createdAt,
          });
          yield* insertMessage({
            messageId: `message-${runId}`,
            threadId: "thread-running",
            runId,
            role: "assistant",
            text: `The ${status} spinel answer.`,
            createdAt,
          });
        }
        // A reverted user prompt is gone from the transcript too.
        yield* insertMessage({
          messageId: "message-rolled-back-user",
          threadId: "thread-running",
          runId: "rolled-back",
          role: "user",
          text: "A reverted spinel answer request.",
          createdAt: "2026-06-01T00:00:05.000Z",
        });

        const settled = yield* collectEvidence("spinel answer");
        assert.deepStrictEqual(settled.map((match) => match.messageId).toSorted(), [
          asMessageId("message-failed"),
          asMessageId("message-interrupted"),
        ]);
        // Upstream's lexical picker ignores run state.
        const lexicalResult = yield* lexical.search({ query: "running spinel" });
        assert.deepStrictEqual(
          lexicalResult.matches.map((match) => match.threadId),
          [ThreadId.make("thread-running")],
        );

        yield* sql`
          UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'running'
        `;
        const afterCompletion = yield* collectEvidence("running spinel");
        assert.deepStrictEqual(
          afterCompletion.map((match) => match.messageId),
          [asMessageId("message-running")],
        );
      }),
    ),
);

it.effect("caps thread and project titles in thread search catalog and evidence pages", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
      // Astral characters are two UTF-16 units each, the unit the schema counts.
      const longThreadTitle = "🪨".repeat(THREAD_SEARCH_TITLE_MAX_LENGTH + 5);
      const longProjectTitle = "p".repeat(THREAD_SEARCH_TITLE_MAX_LENGTH * 20);
      yield* insertProject({ projectId: "project-long", title: longProjectTitle });
      yield* insertThread({
        threadId: "thread-long-title",
        projectId: "project-long",
        title: longThreadTitle,
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message-long-title",
        threadId: "thread-long-title",
        role: "user",
        text: "A tourmaline note.",
        createdAt: "2026-06-01T00:00:00.000Z",
      });

      const catalog = (yield* readCatalogPage(undefined, 10)).entries;
      const evidence = yield* collectEvidence("tourmaline");
      // The RPC encodes each page with the contract schema, so a page the
      // schema rejects fails the whole request instead of arriving truncated.
      assert.isTrue(isCatalogPage(yield* search.listThreadSearchCatalog({ limit: 10 })));
      assert.isTrue(isEvidencePage(yield* search.searchThreadEvidence({ query: "tourmaline" })));
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
  ),
);

it.effect("scans at most one budget of messages per evidence request and resumes below it", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
      yield* insertProject({ projectId: "project-scan", title: "Scan" });
      yield* insertThread({
        threadId: "thread-scan",
        projectId: "project-scan",
        title: "Scan thread",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      // The only match is inserted first, so it sits below more than two scan
      // windows of newer non-matching messages.
      yield* insertMessage({
        messageId: "message-scan-match",
        threadId: "thread-scan",
        role: "user",
        text: "The lone chrysoberyl remark.",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      yield* insertFillerMessages({
        threadId: "thread-scan",
        messageIdPrefix: "message-scan-filler-",
        count: ThreadSearchEvidence.THREAD_SEARCH_EVIDENCE_SCAN_BUDGET * 2 + 10,
        createdAt: "2026-06-01T00:00:01.000Z",
        secondsApart: false,
      });

      const firstPage = yield* readEvidencePage(undefined, "chrysoberyl");
      assert.deepStrictEqual(firstPage.entries, []);
      assert.isNotNull(firstPage.nextCursor);

      const pages = yield* collectPages((cursor) => readEvidencePage(cursor, "chrysoberyl"));
      assert.strictEqual(pages.length, 3);
      assert.deepStrictEqual(
        pages.flat().map((match) => match.messageId),
        [asMessageId("message-scan-match")],
      );

      // The thread filter scans the same bounded windows within one thread.
      const narrowed = yield* collectPages((cursor) =>
        Effect.gen(function* () {
          const page = yield* search.searchThreadEvidence({
            query: "chrysoberyl",
            threadId: ThreadId.make("thread-scan"),
            ...withCursor(cursor),
          });
          return { entries: page.matches, nextCursor: page.nextCursor };
        }),
      );
      assert.strictEqual(narrowed.length, 3);
      assert.strictEqual(narrowed.flat().length, 1);
    }),
  ),
);

it.effect("binds an evidence cursor to its query and thread filter", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
      yield* insertProject({ projectId: "project-bound", title: "Bound" });
      yield* insertThread({
        threadId: "thread-bound",
        projectId: "project-bound",
        title: "Bound thread",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      // Oldest to newest: two garnet matches, then a beryl match that a garnet
      // cursor would skip if another search accepted it.
      for (const [index, text] of ["garnet one", "garnet two", "beryl newest"].entries()) {
        yield* insertMessage({
          messageId: `message-bound-${index}`,
          threadId: "thread-bound",
          role: "user",
          text,
          createdAt: `2026-06-01T00:00:0${index}.000Z`,
        });
      }

      const garnetFirst = yield* search.searchThreadEvidence({ query: "garnet", limit: 1 });
      assert.deepStrictEqual(
        garnetFirst.matches.map((match) => match.messageId),
        [asMessageId("message-bound-1")],
      );
      const garnetCursor = garnetFirst.nextCursor ?? "";

      // The same search, differing only in ASCII case, continues the walk.
      const garnetSecond = yield* search.searchThreadEvidence({
        query: "GARNET",
        cursor: garnetCursor,
      });
      assert.deepStrictEqual(
        garnetSecond.matches.map((match) => match.messageId),
        [asMessageId("message-bound-0")],
      );

      // Another query, or the same query narrowed to a thread, restarts at page one.
      const beryl = yield* search.searchThreadEvidence({ query: "beryl", cursor: garnetCursor });
      assert.deepStrictEqual(
        beryl.matches.map((match) => match.messageId),
        [asMessageId("message-bound-2")],
      );
      const narrowed = yield* search.searchThreadEvidence({
        query: "garnet",
        threadId: ThreadId.make("thread-bound"),
        cursor: garnetCursor,
      });
      assert.deepStrictEqual(
        narrowed.matches.map((match) => match.messageId),
        [asMessageId("message-bound-1"), asMessageId("message-bound-0")],
      );
    }),
  ),
);

it.effect("plans a global evidence request as a rowid window read without sorting history", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
      const plans = yield* planStatementsOf(search.searchThreadEvidence({ query: "plan probe" }));
      assertBoundedEvidencePlans(plans);
    }),
  ),
);

it.effect("plans a thread-filtered evidence request without sorting the thread's history", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
      const plans = yield* planStatementsOf(
        search.searchThreadEvidence({
          query: "plan probe",
          threadId: ThreadId.make("thread-plan-probe"),
        }),
      );
      assertBoundedEvidencePlans(plans);
    }),
  ),
);

it.effect("pages thread-filtered evidence through matches that share one timestamp", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      yield* insertProject({ projectId: "project-ties", title: "Ties" });
      for (const threadId of ["thread-ties", "thread-ties-other"]) {
        yield* insertThread({
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
        yield* insertMessage({
          messageId,
          threadId: "thread-ties",
          role: "user",
          text: `A tied lapis note ${index}.`,
          createdAt: "2026-06-01T00:00:00.000Z",
        });
      }
      // A match in another thread with the same timestamp must stay out.
      yield* insertMessage({
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
  ),
);

it.effect("keeps a thread-filtered evidence cursor within its limit for a long message id", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      yield* insertProject({ projectId: "project-long-id", title: "Long id" });
      yield* insertThread({
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
        yield* insertMessage({
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
  ),
);

it.effect("resumes a thread evidence walk after its boundary message is deleted", () =>
  withFreshDatabase(
    Effect.gen(function* () {
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
  ),
);

it.effect(
  "resumes a thread evidence walk after a deleted boundary with high-Unicode message ids",
  () =>
    withFreshDatabase(
      Effect.gen(function* () {
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
    ),
);

it.effect(
  "plans resumed thread evidence pages as bounded index reads with and without their boundary",
  () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const search = yield* ThreadSearchEvidence.ThreadSearchEvidence;
        yield* insertDeletedBoundaryFixture("thread-resume-plan", [
          { messageId: "m-a", createdAt: "2026-06-01T00:00:00.000Z" },
          { messageId: "m-b", createdAt: "2026-06-01T00:00:01.000Z" },
          { messageId: "m-c", createdAt: "2026-06-01T00:00:01.000Z" },
        ]);
        const threadId = ThreadId.make("thread-resume-plan");
        const first = yield* search.searchThreadEvidence({
          query: "boundary jasper",
          threadId,
          limit: 1,
        });
        const cursor = first.nextCursor ?? "";
        assert.notStrictEqual(cursor, "");
        const resume = search.searchThreadEvidence({
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
        yield* deleteMessage(first.matches[0]?.messageId);
        const missing = yield* planStatementsOf(resume);
        assertBoundedEvidencePlans(missing, 3);
        assert.notDeepEqual(missing, present);
      }),
    ),
);

it.effect("keeps lexical searchThreads active-only and capped at fifty threads", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const lexical = yield* ThreadSearch.ThreadSearch;
      yield* insertProject({ projectId: "project-lexical", title: "Lexical" });
      for (let index = 0; index < 55; index += 1) {
        yield* insertThread({
          threadId: `thread-lexical-${index}`,
          projectId: "project-lexical",
          title: `Lexical ${index}`,
          updatedAt: "2026-06-01T00:00:00.000Z",
        });
        yield* insertMessage({
          messageId: `message-lexical-${index}`,
          threadId: `thread-lexical-${index}`,
          role: "user",
          text: "A lexical garnet mention.",
          createdAt: "2026-06-01T00:00:00.000Z",
        });
      }
      yield* insertThread({
        threadId: "thread-lexical-archived",
        projectId: "project-lexical",
        title: "Lexical archived",
        updatedAt: "2026-06-09T00:00:00.000Z",
        archivedAt: "2026-06-09T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message-lexical-archived",
        threadId: "thread-lexical-archived",
        role: "user",
        text: "An archived lexical garnet mention.",
        createdAt: "2026-06-09T00:00:00.000Z",
      });

      const defaultResult = yield* lexical.search({ query: "lexical garnet" });
      assert.strictEqual(defaultResult.matches.length, 50);
      assert.isFalse(
        defaultResult.matches.some((match) => match.threadId === "thread-lexical-archived"),
      );
      assert.deepStrictEqual(Object.keys(defaultResult.matches[0] ?? {}).toSorted(), [
        "hits",
        "messageCreatedAt",
        "messageId",
        "projectId",
        "quality",
        "snippet",
        "source",
        "threadId",
      ]);
      const limited = yield* lexical.search({ query: "lexical garnet", limit: 3 });
      assert.strictEqual(limited.matches.length, 3);
    }),
  ),
);

// Mesura: search conversations repeat the words the user remembers, so they
// would outrank the conversation being searched for. The hidden search project
// stays out of every search read (ADR-010). Search threads sort first by id
// here, so a filter applied after the page cut would leave a short first page.
const seedSearchAndOrdinaryThreads = Effect.gen(function* () {
  assert.isDefined(THREAD_SEARCH_PROJECT_ID);
  yield* insertProject({ projectId: THREAD_SEARCH_PROJECT_ID, title: "Thread searches" });
  yield* insertProject({ projectId: "project-ordinary", title: "Ordinary" });
  for (const index of [1, 2, 3, 4, 5]) {
    yield* insertThread({
      threadId: `thread-a-search-${index}`,
      projectId: THREAD_SEARCH_PROJECT_ID,
      title: `Search ${index}`,
      updatedAt: "2026-06-09T00:00:00.000Z",
    });
    yield* insertMessage({
      messageId: `message-a-search-${index}`,
      threadId: `thread-a-search-${index}`,
      role: "user",
      text: "Find the thread about the obsidian lantern refactor.",
      createdAt: `2026-06-09T00:00:0${index}.000Z`,
    });
  }
  yield* insertThread({
    threadId: "thread-z-ordinary-active",
    projectId: "project-ordinary",
    title: "Lantern refactor",
    updatedAt: "2026-06-02T00:00:00.000Z",
  });
  yield* insertMessage({
    messageId: "message-z-ordinary-active",
    threadId: "thread-z-ordinary-active",
    role: "user",
    text: "Let us start the obsidian lantern refactor today.",
    createdAt: "2026-06-02T00:00:00.000Z",
  });
  yield* insertThread({
    threadId: "thread-z-ordinary-archived",
    projectId: "project-ordinary",
    title: "Lantern follow-up",
    updatedAt: "2026-06-03T00:00:00.000Z",
    archivedAt: "2026-06-04T00:00:00.000Z",
  });
  yield* insertMessage({
    messageId: "message-z-ordinary-archived",
    threadId: "thread-z-ordinary-archived",
    role: "assistant",
    text: "The obsidian lantern refactor shipped.",
    createdAt: "2026-06-03T00:00:00.000Z",
  });
});

it.effect("search project exclusion spec: thread search catalog pages skip search threads", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      yield* seedSearchAndOrdinaryThreads;
      const firstPage = yield* readCatalogPage(undefined, 2);
      assert.deepStrictEqual(
        firstPage.entries.map((entry) => entry.threadId as string).toSorted(),
        ["thread-z-ordinary-active", "thread-z-ordinary-archived"],
      );
      const everyEntry = (yield* collectPages((cursor) => readCatalogPage(cursor, 2))).flat();
      assert.isFalse(everyEntry.some((entry) => entry.projectId === THREAD_SEARCH_PROJECT_ID));
    }),
  ),
);

it.effect("search project exclusion spec: thread search evidence pages skip search threads", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      yield* seedSearchAndOrdinaryThreads;
      const evidence = yield* collectEvidence("obsidian lantern");
      assert.deepStrictEqual(
        [...new Set(evidence.map((match) => match.threadId as string))].toSorted(),
        ["thread-z-ordinary-active", "thread-z-ordinary-archived"],
      );
    }),
  ),
);

it.effect("search project exclusion spec: lexical searchThreads skips search threads", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      yield* seedSearchAndOrdinaryThreads;
      const lexical = yield* ThreadSearch.ThreadSearch;
      const result = yield* lexical.search({ query: "obsidian lantern" });
      assert.deepStrictEqual(
        result.matches.map((match) => match.threadId as string),
        ["thread-z-ordinary-active"],
      );
    }),
  ),
);
