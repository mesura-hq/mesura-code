/**
 * Mesura: bounded reads for agent thread search on the V2 projection tables: a
 * catalog of every undeleted thread (archived included) and per-message evidence.
 * Every page, cursor, title and excerpt is bounded, and each evidence request
 * scans at most THREAD_SEARCH_EVIDENCE_SCAN_BUDGET messages.
 */
import {
  IsoDateTime,
  MessageId,
  OrchestrationThreadSearchSource,
  ProjectId,
  THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
  THREAD_SEARCH_PROJECT_ID,
  THREAD_SEARCH_TITLE_MAX_LENGTH,
  ThreadId,
  type OrchestrationThreadSearchCatalogInput,
  type OrchestrationThreadSearchCatalogPage,
  type OrchestrationThreadSearchEvidenceInput,
  type OrchestrationThreadSearchEvidencePage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  decodeThreadSearchCatalogCursor,
  decodeThreadSearchEvidenceCursor,
  encodeThreadSearchCatalogCursor,
  encodeThreadSearchEvidenceCursor,
  threadSearchEvidenceKey,
  type ThreadSearchEvidencePosition,
} from "./threadSearchCursor.ts";

/** Carries no query text: search input is user content. */
export class ThreadSearchEvidenceError extends Schema.TaggedError<ThreadSearchEvidenceError>()(
  "ThreadSearchEvidenceError",
  {
    method: Schema.Literals(["listThreadSearchCatalog", "searchThreadEvidence"]),
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.method} ${this.operation} failed.`;
  }
}

const CatalogRequest = Schema.Struct({
  afterCreatedAt: Schema.NullOr(Schema.String),
  afterThreadId: Schema.NullOr(Schema.String),
  limit: Schema.Int,
});
const CatalogRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  projectTitle: Schema.String,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: Schema.String,
  updatedAt: IsoDateTime,
});
// The global route reads beforeScanId alone. The thread route reads the other
// two: no beforeCreatedAt means a first page, a beforeCreatedAt without a
// beforeMessageId means the boundary row is gone (see evidenceScan).
const EvidenceScanBound = {
  threadId: Schema.NullOr(Schema.String),
  beforeScanId: Schema.Number,
  beforeCreatedAt: Schema.NullOr(Schema.String),
  beforeMessageId: Schema.NullOr(Schema.String),
};
const EvidenceBoundaryRequest = Schema.Struct({
  threadId: Schema.String,
  scanId: Schema.Number,
  createdAt: Schema.String,
});
const EvidenceBoundaryRow = Schema.Struct({ messageId: Schema.String });
const EvidenceWindowRequest = Schema.Struct({ ...EvidenceScanBound, scanBudget: Schema.Int });
const EvidenceWindowRow = Schema.Struct({
  scanId: Schema.Number,
  createdAt: Schema.String,
  messageId: Schema.String,
});
const EvidenceRequest = Schema.Struct({
  ...EvidenceScanBound,
  pattern: Schema.String,
  query: Schema.String,
  floorScanId: Schema.Number,
  floorCreatedAt: Schema.String,
  floorMessageId: Schema.String,
  limit: Schema.Int,
});
const EvidenceRow = Schema.Struct({
  scanId: Schema.Number,
  messageId: MessageId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  projectTitle: Schema.String,
  archivedAt: Schema.NullOr(IsoDateTime),
  source: OrchestrationThreadSearchSource,
  messageCreatedAt: IsoDateTime,
  matchWindow: Schema.String,
  clippedBefore: Schema.Number,
  clippedAfter: Schema.Number,
});

const CATALOG_DEFAULT_PAGE_SIZE = 100;
const EVIDENCE_DEFAULT_PAGE_SIZE = 20;
/**
 * Messages one evidence request may examine, newest first. A leading-wildcard LIKE
 * cannot use an index, so LIMIT alone would let a rare term read the whole history.
 * The cursor resumes the scan, so a page can hold no matches yet return a `nextCursor`.
 */
export const THREAD_SEARCH_EVIDENCE_SCAN_BUDGET = 2_000;
// Exclusive upper rowid bound for a first global page; SQLite rowids are signed 64-bit.
const FIRST_SCAN_ID = Number.MAX_SAFE_INTEGER;
// One code point past the title limit, so truncateSearchTitle can tell a title
// SQLite cut from one that was exactly the limit, and mark the cut.
const TITLE_SQL_LENGTH = THREAD_SEARCH_TITLE_MAX_LENGTH + 1;
const EXCERPT_LEADING_CONTEXT = 160;
// SQLite returns only this many characters around each match, so a page never
// copies whole transcripts out of the database to build its excerpts.
const MATCH_WINDOW_LEAD = THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH;
const MATCH_WINDOW_LENGTH = THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH * 3;

// Same LIKE escaping and case folding as upstream's ThreadSearch.ts, which
// keeps its copies private. SQLite's LIKE, lower(), and this fold all ignore
// case for ASCII only, so the SQL match and the excerpt match agree.
function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * Caps a title at the contract limit, in UTF-16 units as the schema counts
 * them, and marks the cut without leaving half a surrogate pair behind. SQLite
 * already bounded the title to TITLE_SQL_LENGTH code points.
 */
function truncateSearchTitle(title: string): string {
  if (title.length <= THREAD_SEARCH_TITLE_MAX_LENGTH) {
    return title;
  }
  const cut = title.slice(0, THREAD_SEARCH_TITLE_MAX_LENGTH - 1);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const safeCut = lastCode >= 0xd800 && lastCode <= 0xdbff ? cut.slice(0, -1) : cut;
  return `${safeCut}…`;
}

/**
 * Cuts whitespace-normalized text to THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH
 * around the first match. `clippedBefore`/`clippedAfter` mark text that is
 * already a window of a longer message, so the ellipses stay honest about the
 * missing context.
 */
function buildEvidenceExcerpt(
  text: string,
  query: string,
  clipped: { readonly before: boolean; readonly after: boolean },
): string {
  const maxLength = THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH;
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (!clipped.before && !clipped.after && normalizedText.length <= maxLength) {
    return normalizedText;
  }

  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = maxLength - 4;
  const idealStart = Math.max(0, matchIndex - EXCERPT_LEADING_CONTEXT);
  const start = Math.max(0, Math.min(idealStart, normalizedText.length - bodyLength));
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 || clipped.before ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length || clipped.after ? "…" : ""
  }`;
}

const toThreadSearchEvidenceError =
  (method: ThreadSearchEvidenceError["method"]) => (cause: unknown) =>
    new ThreadSearchEvidenceError({
      method,
      operation: Schema.isSchemaError(cause) ? "decode" : "query",
      cause,
    });

/**
 * Agent thread search reads. Both include archived threads and leave out
 * deleted threads and threads of deleted projects. Legacy V1 transcripts that
 * have not been imported into V2 are not searched, as with `ThreadSearch`.
 */
export class ThreadSearchEvidence extends Context.Service<
  ThreadSearchEvidence,
  {
    /** Compact metadata of every undeleted thread, in a stable keyset order. */
    readonly listThreadSearchCatalog: (
      input: OrchestrationThreadSearchCatalogInput,
    ) => Effect.Effect<OrchestrationThreadSearchCatalogPage, ThreadSearchEvidenceError>;
    /** One page of matching messages from one bounded scan window. */
    readonly searchThreadEvidence: (
      input: OrchestrationThreadSearchEvidenceInput,
    ) => Effect.Effect<OrchestrationThreadSearchEvidencePage, ThreadSearchEvidenceError>;
  }
>()("t3/orchestration-v2/ThreadSearchEvidence") {}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keyset order on the immutable created_at, so a thread updated mid-walk
  // neither repeats nor slips past the cursor.
  const listCatalogRows = SqlSchema.findAll({
    Request: CatalogRequest,
    Result: CatalogRow,
    execute: ({ afterCreatedAt, afterThreadId, limit }) => sql`
      SELECT
        threads.thread_id AS "threadId",
        threads.project_id AS "projectId",
        substr(threads.title, 1, ${TITLE_SQL_LENGTH}) AS "title",
        substr(projects.title, 1, ${TITLE_SQL_LENGTH}) AS "projectTitle",
        threads.archived_at AS "archivedAt",
        threads.created_at AS "createdAt",
        threads.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.deleted_at IS NULL
        AND projects.deleted_at IS NULL
        -- Search conversations repeat the remembered words and would outrank
        -- the thread searched for (ADR-010). Filtered here, before LIMIT.
        AND threads.project_id <> ${THREAD_SEARCH_PROJECT_ID}
        AND (
          ${afterCreatedAt} IS NULL
          OR threads.created_at < ${afterCreatedAt}
          OR (threads.created_at = ${afterCreatedAt} AND threads.thread_id > ${afterThreadId})
        )
      ORDER BY threads.created_at DESC, threads.thread_id ASC
      LIMIT ${limit}
    `,
  });

  // A thread walk uses row-value bounds on messages_thread_created_idx; rowid order would
  // read the whole thread before LIMIT. Its cursor holds the boundary rowid (message_id is
  // unbounded). A lost boundary resumes at `created_at <=` (repeats, never skips): a U+FFFF
  // sentinel id fails, since SQLite compares UTF-8 bytes and ids from F0 up sort above it.
  const threadUpperBound = (bound: {
    readonly beforeCreatedAt: string | null;
    readonly beforeMessageId: string | null;
  }) =>
    bound.beforeCreatedAt === null
      ? sql``
      : bound.beforeMessageId === null
        ? sql`AND messages.created_at <= ${bound.beforeCreatedAt}`
        : sql`AND (messages.created_at, messages.message_id) < (${bound.beforeCreatedAt}, ${bound.beforeMessageId})`;

  const evidenceScan = (bound: {
    readonly threadId: string | null;
    readonly beforeScanId: number;
    readonly beforeCreatedAt: string | null;
    readonly beforeMessageId: string | null;
  }) =>
    bound.threadId === null
      ? {
          below: sql`messages.rowid < ${bound.beforeScanId}`,
          atOrAbove: (floor: { readonly scanId: number }) => sql`messages.rowid >= ${floor.scanId}`,
          order: sql`messages.rowid DESC`,
          pageOrder: sql`scan_id DESC`,
        }
      : {
          below: sql`
            messages.thread_id = ${bound.threadId}
            ${threadUpperBound(bound)}
          `,
          atOrAbove: (floor: { readonly createdAt: string; readonly messageId: string }) =>
            sql`(messages.created_at, messages.message_id) >= (${floor.createdAt}, ${floor.messageId})`,
          order: sql`messages.created_at DESC, messages.message_id DESC`,
          pageOrder: sql`created_at DESC, message_id DESC`,
        };

  // The message_id of a thread cursor's boundary row, by rowid. None when the
  // row is gone or no longer matches the cursor's thread and timestamp.
  const findBoundary = SqlSchema.findOneOption({
    Request: EvidenceBoundaryRequest,
    Result: EvidenceBoundaryRow,
    execute: ({ threadId, scanId, createdAt }) => sql`
      SELECT message_id AS "messageId"
      FROM orchestration_v2_projection_messages
      WHERE rowid = ${scanId}
        AND thread_id = ${threadId}
        AND created_at = ${createdAt}
    `,
  });

  // Lowest position of the next scan window: the scan-budget-th message below
  // the cursor. No row means the window reaches the start of the history.
  const findWindowFloor = SqlSchema.findOneOption({
    Request: EvidenceWindowRequest,
    Result: EvidenceWindowRow,
    execute: ({ scanBudget, ...bound }) => {
      const scan = evidenceScan(bound);
      return sql`
        SELECT
          messages.rowid AS "scanId",
          messages.created_at AS "createdAt",
          messages.message_id AS "messageId"
        FROM orchestration_v2_projection_messages AS messages
        WHERE ${scan.below}
        ORDER BY ${scan.order}
        LIMIT 1 OFFSET ${scanBudget - 1}
      `;
    },
  });

  // Only finished text is evidence: streaming messages wait, an assistant message waits for
  // its run to settle (runless ones count), and rolled-back runs are excluded because a
  // revert keeps them in the projection but the transcript hides them. Only the page's rows
  // are joined back for the match window.
  const searchEvidenceRows = SqlSchema.findAll({
    Request: EvidenceRequest,
    Result: EvidenceRow,
    execute: ({ pattern, query, floorScanId, floorCreatedAt, floorMessageId, limit, ...bound }) => {
      const scan = evidenceScan(bound);
      return sql`
        WITH page AS (
          SELECT
            messages.rowid AS scan_id,
            messages.message_id AS message_id,
            threads.thread_id AS thread_id,
            threads.project_id AS project_id,
            substr(threads.title, 1, ${TITLE_SQL_LENGTH}) AS thread_title,
            substr(projects.title, 1, ${TITLE_SQL_LENGTH}) AS project_title,
            threads.archived_at AS archived_at,
            messages.role AS role,
            messages.created_at AS created_at
          -- CROSS JOIN pins messages as the outer loop. With INNER JOIN the
          -- planner can start from undeleted threads and read every message of
          -- each through the thread index, which scans the whole history
          -- instead of the scan window.
          FROM orchestration_v2_projection_messages AS messages
          CROSS JOIN orchestration_v2_projection_threads AS threads
            ON threads.thread_id = messages.thread_id
          CROSS JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE ${scan.below}
            AND ${scan.atOrAbove({
              scanId: floorScanId,
              createdAt: floorCreatedAt,
              messageId: floorMessageId,
            })}
            AND threads.deleted_at IS NULL
            AND projects.deleted_at IS NULL
            -- A window of only search-conversation messages still advances the
            -- cursor, so the scan bound holds (ADR-010).
            AND threads.project_id <> ${THREAD_SEARCH_PROJECT_ID}
            AND messages.streaming = 0
            AND messages.role IN ('user', 'assistant')
            AND NOT EXISTS (
              SELECT 1
              FROM orchestration_v2_projection_runs AS runs
              WHERE runs.run_id = messages.run_id
                AND (
                  runs.status = 'rolled_back'
                  OR (
                    messages.role = 'assistant'
                    AND runs.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
                  )
                )
            )
            AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
          ORDER BY ${scan.order}
          LIMIT ${limit}
        ),
        located AS (
          SELECT
            page.*,
            json_extract(messages.payload_json, '$.text') AS text,
            length(json_extract(messages.payload_json, '$.text')) AS text_length,
            max(
              1,
              instr(lower(json_extract(messages.payload_json, '$.text')), lower(${query}))
                - ${MATCH_WINDOW_LEAD}
            ) AS window_start
          FROM page
          INNER JOIN orchestration_v2_projection_messages AS messages
            ON messages.message_id = page.message_id
        )
        SELECT
          scan_id AS "scanId",
          message_id AS "messageId",
          thread_id AS "threadId",
          project_id AS "projectId",
          thread_title AS "title",
          project_title AS "projectTitle",
          archived_at AS "archivedAt",
          role AS "source",
          created_at AS "messageCreatedAt",
          substr(text, window_start, ${MATCH_WINDOW_LENGTH}) AS "matchWindow",
          window_start > 1 AS "clippedBefore",
          window_start + ${MATCH_WINDOW_LENGTH} - 1 < text_length AS "clippedAfter"
        FROM located
        ORDER BY ${scan.pageOrder}
      `;
    },
  });

  const listThreadSearchCatalog: ThreadSearchEvidence["Service"]["listThreadSearchCatalog"] =
    Effect.fn("ThreadSearchEvidence.listThreadSearchCatalog")(function* (input) {
      const limit = input.limit ?? CATALOG_DEFAULT_PAGE_SIZE;
      const after = decodeThreadSearchCatalogCursor(input.cursor);
      // One extra row tells whether another page exists without a COUNT.
      const rows = yield* listCatalogRows({
        afterCreatedAt: after?.afterCreatedAt ?? null,
        afterThreadId: after?.afterThreadId ?? null,
        limit: limit + 1,
      }).pipe(Effect.mapError(toThreadSearchEvidenceError("listThreadSearchCatalog")));
      const pageRows = rows.slice(0, limit);
      const boundary = rows.length > limit ? pageRows.at(-1) : undefined;
      return {
        threads: pageRows.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          title: truncateSearchTitle(row.title),
          projectTitle: truncateSearchTitle(row.projectTitle),
          archivedAt: row.archivedAt,
          updatedAt: row.updatedAt,
        })),
        nextCursor:
          boundary === undefined
            ? null
            : encodeThreadSearchCatalogCursor({
                afterCreatedAt: boundary.createdAt,
                afterThreadId: boundary.threadId,
              }),
      };
    });

  const searchThreadEvidence: ThreadSearchEvidence["Service"]["searchThreadEvidence"] = Effect.fn(
    "ThreadSearchEvidence.searchThreadEvidence",
  )(function* (input) {
    const toError = toThreadSearchEvidenceError("searchThreadEvidence");
    const limit = input.limit ?? EVIDENCE_DEFAULT_PAGE_SIZE;
    const threadId = input.threadId ?? null;
    const searchKey = threadSearchEvidenceKey(foldAsciiCase(input.query), threadId);
    const positionOf = (row: {
      readonly scanId: number;
      readonly createdAt: string;
    }): ThreadSearchEvidencePosition =>
      threadId === null
        ? { kind: "rowid", beforeScanId: row.scanId }
        : { kind: "thread", beforeCreatedAt: row.createdAt, beforeScanId: row.scanId };
    // The search key covers the thread filter, so a decoded position always
    // belongs to this request's route; the kind check only narrows the type.
    const cursorPosition = decodeThreadSearchEvidenceCursor(input.cursor, searchKey)?.position;
    const threadBoundary =
      threadId !== null && cursorPosition?.kind === "thread" ? cursorPosition : undefined;
    const threadBoundaryMessageId =
      threadId === null || threadBoundary === undefined
        ? Option.none<string>()
        : yield* findBoundary({
            threadId,
            scanId: threadBoundary.beforeScanId,
            createdAt: threadBoundary.beforeCreatedAt,
          }).pipe(Effect.map(Option.map((row) => row.messageId)), Effect.mapError(toError));
    const bound = {
      threadId,
      beforeScanId: cursorPosition?.kind === "rowid" ? cursorPosition.beforeScanId : FIRST_SCAN_ID,
      beforeCreatedAt: threadBoundary?.beforeCreatedAt ?? null,
      beforeMessageId: Option.getOrNull(threadBoundaryMessageId),
    };
    const windowFloor = yield* findWindowFloor({
      ...bound,
      scanBudget: THREAD_SEARCH_EVIDENCE_SCAN_BUDGET,
    }).pipe(Effect.mapError(toError));
    // Without a floor the window runs to the start: rowid 0 and the empty key
    // sort below every row.
    const floor = Option.getOrElse(windowFloor, () => ({
      scanId: 0,
      createdAt: "",
      messageId: "",
    }));
    const rows = yield* searchEvidenceRows({
      ...bound,
      pattern: `%${escapeLikePattern(input.query)}%`,
      query: input.query,
      floorScanId: floor.scanId,
      floorCreatedAt: floor.createdAt,
      floorMessageId: floor.messageId,
      limit: limit + 1,
    }).pipe(Effect.mapError(toError));
    const pageRows = rows.slice(0, limit);
    // More matches in this window resume after the last one delivered; an
    // exhausted but full window resumes below its floor; otherwise the scan
    // reached the start of the history.
    const lastRow = rows.length > limit ? pageRows.at(-1) : undefined;
    const nextPosition =
      lastRow !== undefined
        ? positionOf({ scanId: lastRow.scanId, createdAt: lastRow.messageCreatedAt })
        : Option.isSome(windowFloor)
          ? positionOf(windowFloor.value)
          : undefined;
    return {
      matches: pageRows.map((row) => ({
        messageId: row.messageId,
        threadId: row.threadId,
        projectId: row.projectId,
        title: truncateSearchTitle(row.title),
        projectTitle: truncateSearchTitle(row.projectTitle),
        archivedAt: row.archivedAt,
        source: row.source,
        messageCreatedAt: row.messageCreatedAt,
        excerpt: buildEvidenceExcerpt(row.matchWindow, input.query, {
          before: row.clippedBefore === 1,
          after: row.clippedAfter === 1,
        }),
      })),
      nextCursor:
        nextPosition === undefined
          ? null
          : encodeThreadSearchEvidenceCursor({ position: nextPosition, searchKey }),
    };
  });

  return ThreadSearchEvidence.of({ listThreadSearchCatalog, searchThreadEvidence });
});

export const layer = Layer.effect(ThreadSearchEvidence, make);
