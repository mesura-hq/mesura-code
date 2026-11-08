import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { OrchestrationSearchThreadsInput } from "./threadSearch.ts";
import {
  OrchestrationThreadSearchCatalogInput,
  OrchestrationThreadSearchCatalogPage,
  OrchestrationThreadSearchEvidenceInput,
  OrchestrationThreadSearchEvidencePage,
  OrchestrationThreadSearchReasoningInput,
  OrchestrationThreadSearchStep,
  THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE,
  THREAD_SEARCH_CURSOR_MAX_LENGTH,
  THREAD_SEARCH_DESCRIPTION_MAX_LENGTH,
  THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
  THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE,
  THREAD_SEARCH_REASON_MAX_LENGTH,
  THREAD_SEARCH_REASONING_MAX_EVIDENCE,
  THREAD_SEARCH_REASONING_MAX_TERMS,
  THREAD_SEARCH_STEP_MAX_RANKED,
  THREAD_SEARCH_TITLE_MAX_LENGTH,
  THREAD_SEARCH_WS_METHODS,
} from "./threadSearchEvidence.ts";

// Agent thread search, phase 1: the evidence contract bounds every request and
// every response field, so one environment cannot be asked to scan or return
// an unbounded amount of history in a single RPC.
it("bounds thread search catalog and evidence pages, cursors, queries, and excerpts", () => {
  const acceptsCatalogInput = Schema.is(OrchestrationThreadSearchCatalogInput);
  const acceptsEvidenceInput = Schema.is(OrchestrationThreadSearchEvidenceInput);
  const acceptsEvidencePage = Schema.is(OrchestrationThreadSearchEvidencePage);
  const oversizedCursor = "c".repeat(THREAD_SEARCH_CURSOR_MAX_LENGTH + 1);

  assert.isTrue(acceptsCatalogInput({}));
  assert.isTrue(acceptsCatalogInput({ limit: THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE }));
  assert.isFalse(acceptsCatalogInput({ limit: THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE + 1 }));
  assert.isFalse(acceptsCatalogInput({ limit: 0 }));
  assert.isFalse(acceptsCatalogInput({ cursor: oversizedCursor }));

  assert.isTrue(acceptsEvidenceInput({ query: "needle" }));
  assert.isTrue(
    acceptsEvidenceInput({ query: "needle", limit: THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE }),
  );
  assert.isFalse(
    acceptsEvidenceInput({ query: "needle", limit: THREAD_SEARCH_EVIDENCE_MAX_PAGE_SIZE + 1 }),
  );
  assert.isFalse(acceptsEvidenceInput({ query: "n" }));
  assert.isFalse(acceptsEvidenceInput({ query: "n".repeat(201) }));
  assert.isFalse(acceptsEvidenceInput({ query: "needle", cursor: oversizedCursor }));

  const evidence = {
    threadId: "thread-1",
    projectId: "project-1",
    title: "Thread",
    projectTitle: "Project",
    archivedAt: null,
    source: "user",
    messageCreatedAt: "2026-06-01T00:00:00.000Z",
    excerpt: "e".repeat(THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH),
  };
  assert.isTrue(acceptsEvidencePage({ matches: [evidence], nextCursor: null }));
  assert.isFalse(
    acceptsEvidencePage({
      matches: [
        { ...evidence, excerpt: "e".repeat(THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH + 1) },
      ],
      nextCursor: null,
    }),
  );
});

it("bounds thread and project titles in thread search catalog and evidence pages", () => {
  const acceptsCatalogPage = Schema.is(OrchestrationThreadSearchCatalogPage);
  const acceptsEvidencePage = Schema.is(OrchestrationThreadSearchEvidencePage);
  const bounded = "t".repeat(THREAD_SEARCH_TITLE_MAX_LENGTH);
  const oversized = `${bounded}t`;
  const entry = {
    threadId: "thread-1",
    projectId: "project-1",
    title: bounded,
    projectTitle: bounded,
    archivedAt: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  const match = {
    threadId: "thread-1",
    projectId: "project-1",
    title: bounded,
    projectTitle: bounded,
    archivedAt: null,
    source: "user",
    messageCreatedAt: "2026-06-01T00:00:00.000Z",
    excerpt: "excerpt",
  };
  assert.isTrue(acceptsCatalogPage({ threads: [entry], nextCursor: null }));
  assert.isFalse(
    acceptsCatalogPage({ threads: [{ ...entry, title: oversized }], nextCursor: null }),
  );
  assert.isFalse(
    acceptsCatalogPage({ threads: [{ ...entry, projectTitle: oversized }], nextCursor: null }),
  );
  assert.isTrue(acceptsEvidencePage({ matches: [match], nextCursor: null }));
  assert.isFalse(
    acceptsEvidencePage({ matches: [{ ...match, title: oversized }], nextCursor: null }),
  );
  assert.isFalse(
    acceptsEvidencePage({ matches: [{ ...match, projectTitle: oversized }], nextCursor: null }),
  );
});

it("keeps the lexical thread search contract at fifty active matches per request", () => {
  const acceptsSearchInput = Schema.is(OrchestrationSearchThreadsInput);
  assert.strictEqual(ORCHESTRATION_V2_WS_METHODS.searchThreads, "orchestration.searchThreads");
  assert.isTrue(acceptsSearchInput({ query: "needle", limit: 50 }));
  assert.isFalse(acceptsSearchInput({ query: "needle", limit: 51 }));
  assert.isFalse(acceptsSearchInput({ query: "n" }));
});

// Agent thread search, phase 2: the reasoning request carries only bounded,
// caller-labelled evidence, and the model can answer with nothing but the four
// read-only steps. The coordinator decides whether a returned step is allowed.
const threadSearchReasoningEvidence = {
  ref: "e1",
  threadTitle: "Cache clock review",
  projectTitle: "Mesura Code",
  environmentLabel: "vigilia-home",
  archived: true,
  source: "assistant",
  excerpt: "e".repeat(THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH),
};

it("bounds the thread search reasoning request description, terms, evidence, and excerpts", () => {
  const acceptsReasoningInput = Schema.is(OrchestrationThreadSearchReasoningInput);
  const request = {
    description: "the conversation where the cache used the wrong clock",
    searchedTerms: ["cache clock"],
    evidence: [threadSearchReasoningEvidence],
  };

  assert.strictEqual(
    THREAD_SEARCH_WS_METHODS.reasonThreadSearch,
    "orchestration.reasonThreadSearch",
  );
  assert.isTrue(acceptsReasoningInput(request));
  assert.isTrue(acceptsReasoningInput({ ...request, searchedTerms: [], evidence: [] }));
  assert.isTrue(
    acceptsReasoningInput({
      ...request,
      evidence: [{ ...threadSearchReasoningEvidence, source: null, excerpt: "" }],
    }),
  );
  assert.isFalse(acceptsReasoningInput({ ...request, description: "   " }));
  assert.isFalse(
    acceptsReasoningInput({
      ...request,
      description: "d".repeat(THREAD_SEARCH_DESCRIPTION_MAX_LENGTH + 1),
    }),
  );
  assert.isFalse(
    acceptsReasoningInput({
      ...request,
      searchedTerms: Array.from(
        { length: THREAD_SEARCH_REASONING_MAX_TERMS + 1 },
        (_, index) => `term ${index}`,
      ),
    }),
  );
  assert.isTrue(
    acceptsReasoningInput({
      ...request,
      evidence: Array.from({ length: THREAD_SEARCH_REASONING_MAX_EVIDENCE }, (_, index) => ({
        ...threadSearchReasoningEvidence,
        ref: `e${index}`,
      })),
    }),
  );
  assert.isFalse(
    acceptsReasoningInput({
      ...request,
      evidence: Array.from({ length: THREAD_SEARCH_REASONING_MAX_EVIDENCE + 1 }, (_, index) => ({
        ...threadSearchReasoningEvidence,
        ref: `e${index}`,
      })),
    }),
  );
  assert.isFalse(
    acceptsReasoningInput({
      ...request,
      evidence: [
        {
          ...threadSearchReasoningEvidence,
          excerpt: "e".repeat(THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH + 1),
        },
      ],
    }),
  );
  // The request never names a model: the environment's own configured
  // textGenerationModelSelection decides which provider answers.
  assert.isFalse(
    "modelSelection" in OrchestrationThreadSearchReasoningInput.fields,
    "the reasoning request must not accept a client-chosen model",
  );
});

it("accepts only read-only thread search steps with bounded ranked reasons", () => {
  const acceptsStep = Schema.is(OrchestrationThreadSearchStep);

  assert.isTrue(acceptsStep({ action: "broaden", terms: ["clock skew", "stale timestamp"] }));
  assert.isTrue(acceptsStep({ action: "readMore", terms: ["clock skew"] }));
  assert.isTrue(acceptsStep({ action: "inspect", refs: ["e1"] }));
  assert.isTrue(
    acceptsStep({ action: "finish", ranked: [{ ref: "e1", reason: "Names the cache clock." }] }),
  );
  assert.isTrue(acceptsStep({ action: "finish", ranked: [] }));

  assert.isFalse(acceptsStep({ action: "broaden", terms: [] }));
  assert.isFalse(acceptsStep({ action: "inspect", refs: [] }));
  for (const forbidden of ["writeFile", "runCommand", "dispatchCommand", "unarchive"]) {
    assert.isFalse(acceptsStep({ action: forbidden, path: "/etc/passwd" }), forbidden);
  }
  assert.isFalse(
    acceptsStep({
      action: "finish",
      ranked: Array.from({ length: THREAD_SEARCH_STEP_MAX_RANKED + 1 }, (_, index) => ({
        ref: `e${index}`,
        reason: "Related.",
      })),
    }),
  );
  assert.isFalse(
    acceptsStep({
      action: "finish",
      ranked: [{ ref: "e1", reason: "r".repeat(THREAD_SEARCH_REASON_MAX_LENGTH + 1) }],
    }),
  );
});
