import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ProjectId, ThreadId, TrimmedString } from "./baseSchemas.ts";
import { OrchestrationThreadSearchSource } from "./threadSearch.ts";

/**
 * Mesura: agent thread search. These RPCs sit beside upstream's lexical
 * `orchestration.searchThreads` (threadSearch.ts) in a file of our own, so the
 * upstream contracts stay untouched. The wire method names keep the
 * `orchestration.` prefix they had before the v2 orchestrator.
 */
export const THREAD_SEARCH_WS_METHODS = {
  listThreadSearchCatalog: "orchestration.listThreadSearchCatalog",
  searchThreadEvidence: "orchestration.searchThreadEvidence",
  reasonThreadSearch: "orchestration.reasonThreadSearch",
} as const;

// Agent thread search reads history page by page instead of widening
// searchThreads, which the lexical picker depends on staying active-only. The
// same single-connection constraint applies: every page, cursor, and excerpt is
// bounded so no request scans or returns an unbounded share of the history.
export const THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE = 200;
export const THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE = 50;
export const THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH = 480;
export const THREAD_SEARCH_CURSOR_MAX_LENGTH = 512;
export const THREAD_SEARCH_TITLE_MAX_LENGTH = 200;
const ThreadSearchTitle = Schema.String.check(Schema.isMaxLength(THREAD_SEARCH_TITLE_MAX_LENGTH));

/** Opaque keyset cursor returned as `nextCursor`; clients pass it back unchanged. */
export const OrchestrationThreadSearchCursor = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THREAD_SEARCH_CURSOR_MAX_LENGTH),
);

export const OrchestrationThreadSearchCatalogInput = Schema.Struct({
  cursor: Schema.optionalKey(OrchestrationThreadSearchCursor),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE }),
    ),
  ),
});
export type OrchestrationThreadSearchCatalogInput =
  typeof OrchestrationThreadSearchCatalogInput.Type;

export const OrchestrationThreadSearchCatalogEntry = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: ThreadSearchTitle,
  projectTitle: ThreadSearchTitle,
  archivedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type OrchestrationThreadSearchCatalogEntry =
  typeof OrchestrationThreadSearchCatalogEntry.Type;

export const OrchestrationThreadSearchCatalogPage = Schema.Struct({
  threads: Schema.Array(OrchestrationThreadSearchCatalogEntry).check(
    Schema.isMaxLength(THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE),
  ),
  nextCursor: Schema.NullOr(OrchestrationThreadSearchCursor),
});
export type OrchestrationThreadSearchCatalogPage = typeof OrchestrationThreadSearchCatalogPage.Type;

export const OrchestrationThreadSearchEvidenceInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  /** Restricts evidence to one thread, to inspect a candidate in depth. */
  threadId: Schema.optionalKey(ThreadId),
  cursor: Schema.optionalKey(OrchestrationThreadSearchCursor),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE }),
    ),
  ),
});
export type OrchestrationThreadSearchEvidenceInput =
  typeof OrchestrationThreadSearchEvidenceInput.Type;

export const OrchestrationThreadSearchEvidence = Schema.Struct({
  messageId: Schema.optionalKey(MessageId),
  threadId: ThreadId,
  projectId: ProjectId,
  title: ThreadSearchTitle,
  projectTitle: ThreadSearchTitle,
  archivedAt: Schema.NullOr(IsoDateTime),
  source: OrchestrationThreadSearchSource,
  messageCreatedAt: IsoDateTime,
  excerpt: Schema.String.check(Schema.isMaxLength(THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH)),
});
export type OrchestrationThreadSearchEvidence = typeof OrchestrationThreadSearchEvidence.Type;

/**
 * Each request scans a bounded slice of history, so `matches` can be empty
 * while `nextCursor` is set: the walk is over only when `nextCursor` is null.
 */
export const OrchestrationThreadSearchEvidencePage = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchEvidence).check(
    Schema.isMaxLength(THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE),
  ),
  nextCursor: Schema.NullOr(OrchestrationThreadSearchCursor),
});
export type OrchestrationThreadSearchEvidencePage =
  typeof OrchestrationThreadSearchEvidencePage.Type;

// One bounded reasoning step of agent thread search. The caller labels each
// piece of evidence with an opaque `ref` and maps the model's refs back itself,
// so the model never sees or returns environment or thread IDs. The request
// names no model: the answering environment uses its own configured
// textGenerationModelSelection.
export const THREAD_SEARCH_DESCRIPTION_MAX_LENGTH = 1_000;
export const THREAD_SEARCH_REASONING_MAX_EVIDENCE = 60;
export const THREAD_SEARCH_REASONING_MAX_TERMS = 24;
export const THREAD_SEARCH_STEP_MAX_TERMS = 8;
export const THREAD_SEARCH_STEP_MAX_INSPECT = 5;
export const THREAD_SEARCH_STEP_MAX_RANKED = 10;
export const THREAD_SEARCH_REASON_MAX_LENGTH = 280;
export const THREAD_SEARCH_REF_MAX_LENGTH = 64;
/**
 * Strict UTF-8 byte cap on the full prompt a reasoning step sends to the model;
 * a larger prompt fails with TextGenerationError instead of reaching a provider.
 */
export const THREAD_SEARCH_REASONING_MAX_PROMPT_BYTES = 96_000;
/**
 * Byte budget for the serialized reasoning input a caller sends. The prompt
 * adds fixed instructions to the same JSON-escaped values, so an input within
 * this budget stays below THREAD_SEARCH_REASONING_MAX_PROMPT_BYTES.
 */
export const THREAD_SEARCH_REASONING_MAX_INPUT_BYTES = 64_000;

const ThreadSearchRef = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THREAD_SEARCH_REF_MAX_LENGTH),
);
/** A term the caller can pass straight to searchThreadEvidence as its query. */
const ThreadSearchTerm = TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200));

export const OrchestrationThreadSearchReasoningEvidence = Schema.Struct({
  ref: ThreadSearchRef,
  threadTitle: ThreadSearchTitle,
  projectTitle: ThreadSearchTitle,
  environmentLabel: ThreadSearchTitle,
  archived: Schema.Boolean,
  /** Null for a catalog entry offered by title alone, with an empty excerpt. */
  source: Schema.NullOr(OrchestrationThreadSearchSource),
  excerpt: Schema.String.check(Schema.isMaxLength(THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH)),
});
export type OrchestrationThreadSearchReasoningEvidence =
  typeof OrchestrationThreadSearchReasoningEvidence.Type;

export const OrchestrationThreadSearchReasoningInput = Schema.Struct({
  description: TrimmedString.check(
    Schema.isPattern(/\S/),
    Schema.isMaxLength(THREAD_SEARCH_DESCRIPTION_MAX_LENGTH),
  ),
  searchedTerms: Schema.Array(ThreadSearchTerm).check(
    Schema.isMaxLength(THREAD_SEARCH_REASONING_MAX_TERMS),
  ),
  evidence: Schema.Array(OrchestrationThreadSearchReasoningEvidence).check(
    Schema.isMaxLength(THREAD_SEARCH_REASONING_MAX_EVIDENCE),
  ),
  /**
   * The caller will perform no further read: the model must finish now,
   * ranking what the evidence supports. Optional so an older caller that
   * never sends it keeps decoding.
   */
  finalStep: Schema.optional(Schema.Boolean),
});
export type OrchestrationThreadSearchReasoningInput =
  typeof OrchestrationThreadSearchReasoningInput.Type;

const ThreadSearchStepTerms = Schema.Array(ThreadSearchTerm).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THREAD_SEARCH_STEP_MAX_TERMS),
);

export const OrchestrationThreadSearchRankedRef = Schema.Struct({
  ref: ThreadSearchRef,
  reason: Schema.String.check(Schema.isMaxLength(THREAD_SEARCH_REASON_MAX_LENGTH)),
});
export type OrchestrationThreadSearchRankedRef = typeof OrchestrationThreadSearchRankedRef.Type;

/**
 * The only answers a model can give: three bounded reads and a final ranking.
 * The caller decides whether it performs a requested read; an empty `ranked`
 * means no confident match.
 */
export const OrchestrationThreadSearchStep = Schema.Union([
  Schema.Struct({ action: Schema.Literal("broaden"), terms: ThreadSearchStepTerms }),
  Schema.Struct({ action: Schema.Literal("readMore"), terms: ThreadSearchStepTerms }),
  Schema.Struct({
    action: Schema.Literal("inspect"),
    refs: Schema.Array(ThreadSearchRef).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(THREAD_SEARCH_STEP_MAX_INSPECT),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("finish"),
    ranked: Schema.Array(OrchestrationThreadSearchRankedRef).check(
      Schema.isMaxLength(THREAD_SEARCH_STEP_MAX_RANKED),
    ),
  }),
]);
export type OrchestrationThreadSearchStep = typeof OrchestrationThreadSearchStep.Type;

export const ThreadSearchRpcSchemas = {
  listThreadSearchCatalog: {
    input: OrchestrationThreadSearchCatalogInput,
    output: OrchestrationThreadSearchCatalogPage,
  },
  searchThreadEvidence: {
    input: OrchestrationThreadSearchEvidenceInput,
    output: OrchestrationThreadSearchEvidencePage,
  },
  reasonThreadSearch: {
    input: OrchestrationThreadSearchReasoningInput,
    output: OrchestrationThreadSearchStep,
  },
} as const;
