import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationThreadSearchReasoningEvidence,
  OrchestrationThreadSearchReasoningInput,
  THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE,
  THREAD_SEARCH_DESCRIPTION_MAX_LENGTH,
  THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH,
  THREAD_SEARCH_REASONING_MAX_EVIDENCE,
  THREAD_SEARCH_REASONING_MAX_INPUT_BYTES,
  THREAD_SEARCH_REASONING_MAX_TERMS,
  THREAD_SEARCH_TITLE_MAX_LENGTH,
  type EnvironmentId,
  type OrchestrationThreadSearchCatalogEntry,
  type OrchestrationThreadSearchCatalogPage,
  type OrchestrationThreadSearchEvidence,
  type OrchestrationThreadSearchSource,
  type OrchestrationThreadSearchStep,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request, type EnvironmentRpcInput, type EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import { runInEnvironment } from "./runtime.ts";
import { threadSearchMatchKey } from "./threadSearch.ts";

// Agent thread search: one description searches every connected environment
// through bounded, read-only RPCs, and the model environment's configured text
// model steers the reads. Every budget below exists so a search on a large
// history, a model that never finishes, or many connected environments still
// ends; hitting one is reported as `budgetExhausted` instead of claiming
// complete coverage.

/** Catalog and evidence reads in flight at once, across every environment. */
export const AGENT_THREAD_SEARCH_MAX_CONCURRENT_READS = 4;
/** Catalog and evidence reads one search makes, across every environment. */
export const AGENT_THREAD_SEARCH_MAX_TOTAL_READS = 256;
/**
 * Catalog pages beyond each environment's first page stop at this share of
 * the total, so the catalog cannot spend the evidence reads.
 */
const MAX_TOTAL_CATALOG_READS = AGENT_THREAD_SEARCH_MAX_TOTAL_READS / 2;
/** Model steps before the search stops and reports an exhausted budget. */
const MAX_MODEL_ROUNDS = 8;
/** Catalog and evidence requests one environment serves in one search. */
const MAX_READS_PER_ENVIRONMENT = 64;
/**
 * Catalog pages one environment reads: 3,200 threads at the contract's page
 * size. A catalog left unread past this cap is reported as `budgetExhausted`,
 * and the rest of the read budget stays for evidence.
 */
const MAX_CATALOG_PAGES = 16;
/**
 * Pages one term read follows through empty pages before it returns to the
 * model. The server scans 2,000 messages per page, so this reaches a message
 * about 16,000 messages deep in one read.
 */
const MAX_PAGES_PER_READ = 8;
const EVIDENCE_PAGE_SIZE = 20;
/** Searched terms an inspection re-reads inside the inspected thread. */
const INSPECT_TERM_COUNT = 3;
const TERM_MIN_LENGTH = 2;
const TERM_MAX_LENGTH = 200;

export interface AgentThreadSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface AgentThreadSearchInput {
  readonly description: string;
  /** Environments to search; the ones that cannot answer are reported, not dropped. */
  readonly environments: ReadonlyArray<AgentThreadSearchEnvironment>;
  /** The environment whose configured text model reasons about the evidence. */
  readonly modelEnvironmentId: EnvironmentId;
}

export interface AgentThreadSearchMatch {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  readonly projectTitle: string;
  readonly archivedAt: string | null;
  readonly reason: string;
}

export interface AgentThreadSearchCoverage {
  /** Environments that could not answer, or were disconnected at the verdict. */
  readonly unavailableEnvironments: ReadonlyArray<AgentThreadSearchEnvironment>;
  /** True when a read, page, round, or total budget ended work. */
  readonly budgetExhausted: boolean;
  /**
   * True when reachable data went unjudged: a catalog or evidence cursor was
   * left open, or held evidence never reached any prompt the model received.
   */
  readonly unreadEvidence: boolean;
}

export type AgentThreadSearchResult =
  | {
      readonly status: "matches";
      readonly matches: ReadonlyArray<AgentThreadSearchMatch>;
      readonly coverage: AgentThreadSearchCoverage;
    }
  | { readonly status: "noConfidentMatch"; readonly coverage: AgentThreadSearchCoverage }
  | {
      readonly status: "failed";
      readonly failure: "model" | "retrieval";
      readonly coverage: AgentThreadSearchCoverage;
    };

/** One piece of evidence the coordinator holds, labelled by an opaque ref. */
interface EvidenceItem {
  readonly ref: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  readonly projectTitle: string;
  readonly archivedAt: string | null;
  /** Null for a catalog entry, which carries a title but no excerpt. */
  readonly source: OrchestrationThreadSearchSource | null;
  readonly excerpt: string;
  /** Acquisition order, so the newest reads reach the model first. */
  readonly sequence: number;
  /** UTF-8 bytes of this item serialized as model-facing JSON evidence. */
  readonly bytes: number;
}

interface EnvironmentState {
  readonly environment: AgentThreadSearchEnvironment;
  available: boolean;
  reads: number;
  /** Next catalog page: undefined before the first read, null when exhausted. */
  catalogCursor: string | null | undefined;
  /** Keys of the catalog entries and messages already held from this environment. */
  readonly evidenceKeys: Set<string>;
  /**
   * Evidence cursor per thread scope (null for the whole history) and
   * lower-cased term: absent when unread, null when exhausted.
   */
  readonly cursors: Map<ThreadId | null, Map<string, string | null>>;
}

function clampText(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeTerm(term: string): string | null {
  const trimmed = term.trim();
  return trimmed.length >= TERM_MIN_LENGTH && trimmed.length <= TERM_MAX_LENGTH ? trimmed : null;
}

/**
 * The longest distinct words of a text that are valid evidence terms. Longer
 * words tend to be the most distinctive; short ones such as "db" still count
 * when nothing longer exists. Evidence matching is a contiguous substring, so
 * a single word matches more than a whole phrase would.
 */
function distinctiveTerms(text: string): ReadonlyArray<string> {
  const words = new Set<string>();
  for (const word of text.toLowerCase().split(/[\s.,;:!?()[\]{}"'`]+/)) {
    const term = normalizeTerm(word);
    if (term !== null) words.add(term);
  }
  return [...words].sort((left, right) => right.length - left.length).slice(0, INSPECT_TERM_COUNT);
}

function uniqueEnvironments(
  environments: ReadonlyArray<AgentThreadSearchEnvironment>,
): ReadonlyArray<AgentThreadSearchEnvironment> {
  const seen = new Set<EnvironmentId>();
  return environments.filter((environment) => {
    if (seen.has(environment.environmentId)) return false;
    seen.add(environment.environmentId);
    return true;
  });
}

/** Runs one unary RPC in an environment and settles its typed failure. */
function callEnvironment<TTag extends EnvironmentUnaryRpcTag>(
  environmentId: EnvironmentId,
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) {
  return runInEnvironment(environmentId, request(tag, input)).pipe(Effect.result);
}

const utf8Encoder = new TextEncoder();
const encodeReasoningEvidenceJson = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationThreadSearchReasoningEvidence),
);
const encodeReasoningInputJson = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationThreadSearchReasoningInput),
);

function utf8Bytes(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/**
 * Orders items round-robin across environments, keeping each environment's
 * own order, so one busy environment cannot take every prompt slot.
 */
function interleaveByEnvironment(items: ReadonlyArray<EvidenceItem>): EvidenceItem[] {
  const queues = new Map<EnvironmentId, EvidenceItem[]>();
  for (const item of items) {
    const queue = queues.get(item.environmentId);
    if (queue === undefined) queues.set(item.environmentId, [item]);
    else queue.push(item);
  }
  const interleaved: EvidenceItem[] = [];
  for (let index = 0; interleaved.length < items.length; index += 1) {
    for (const queue of queues.values()) {
      const item = queue[index];
      if (item !== undefined) interleaved.push(item);
    }
  }
  return interleaved;
}

function toReasoningEvidence(
  item: Omit<EvidenceItem, "bytes" | "sequence" | "environmentId" | "threadId" | "projectId">,
): OrchestrationThreadSearchReasoningEvidence {
  return {
    ref: item.ref,
    threadTitle: item.threadTitle,
    projectTitle: item.projectTitle,
    environmentLabel: item.environmentLabel,
    archived: item.archivedAt !== null,
    source: item.source,
    excerpt: item.excerpt,
  };
}

/**
 * Shared coordinator for agent thread search. It never fails: model and
 * retrieval errors become a `failed` result, and an environment that cannot
 * answer is listed in the coverage. Interrupting the fiber cancels every
 * outstanding RPC.
 */
export const runAgentThreadSearch = Effect.fn("AgentThreadSearch.run")(function* (
  input: AgentThreadSearchInput,
) {
  const description = clampText(input.description.trim(), THREAD_SEARCH_DESCRIPTION_MAX_LENGTH);
  const environments: EnvironmentState[] = uniqueEnvironments(input.environments).map(
    (environment) => ({
      environment: {
        environmentId: environment.environmentId,
        label: clampText(environment.label, THREAD_SEARCH_TITLE_MAX_LENGTH),
      },
      available: true,
      reads: 0,
      catalogCursor: undefined,
      evidenceKeys: new Set(),
      cursors: new Map(),
    }),
  );
  const evidence: EvidenceItem[] = [];
  const threadsWithMessages = new Set<string>();
  /** Refs the model has seen; only these may come back in a ranking. */
  const issuedRefs = new Map<string, EvidenceItem>();
  const searchedTerms: string[] = [];
  let budgetExhausted = false;
  let sequence = 0;
  let totalReads = 0;
  let catalogReads = 0;
  /** Rotates which environment reads first, so the total cap spreads its misses. */
  let rotation = 0;

  const isAvailable = (environmentId: EnvironmentId) =>
    environments.some(
      (state) => state.available && state.environment.environmentId === environmentId,
    );

  /**
   * True when held evidence never reached the model in any step. A catalog
   * title counts as seen when message evidence of its thread was shown instead.
   * Evidence of an unavailable environment is reported through that list.
   */
  const someEvidenceUnseen = (): boolean => {
    const shownThreads = new Set<string>();
    for (const item of issuedRefs.values()) shownThreads.add(threadSearchMatchKey(item));
    return evidence.some(
      (item) =>
        isAvailable(item.environmentId) &&
        !issuedRefs.has(item.ref) &&
        !(item.source === null && shownThreads.has(threadSearchMatchKey(item))),
    );
  };
  const someCursorOpen = (): boolean =>
    environments.some(
      (state) =>
        state.available &&
        (state.catalogCursor !== null ||
          [...state.cursors.values()].some((cursors) =>
            [...cursors.values()].some((cursor) => cursor !== null),
          )),
    );

  const coverage = (): AgentThreadSearchCoverage => ({
    unavailableEnvironments: environments
      .filter((state) => !state.available)
      .map((state) => state.environment),
    budgetExhausted,
    unreadEvidence: someCursorOpen() || someEvidenceUnseen(),
  });
  const anyAvailable = () => environments.some((state) => state.available);

  const addEvidence = (
    state: EnvironmentState,
    key: string,
    entry: OrchestrationThreadSearchCatalogEntry | OrchestrationThreadSearchEvidence,
    source: OrchestrationThreadSearchSource | null,
    excerpt: string,
  ) => {
    if (state.evidenceKeys.has(key)) return;
    state.evidenceKeys.add(key);
    sequence += 1;
    const modelFacing = {
      ref: `e${sequence}`,
      environmentLabel: state.environment.label,
      threadTitle: clampText(entry.title, THREAD_SEARCH_TITLE_MAX_LENGTH),
      projectTitle: clampText(entry.projectTitle, THREAD_SEARCH_TITLE_MAX_LENGTH),
      archivedAt: entry.archivedAt,
      source,
      excerpt: clampText(excerpt, THREAD_SEARCH_EVIDENCE_EXCERPT_MAX_LENGTH),
    };
    evidence.push({
      ...modelFacing,
      environmentId: state.environment.environmentId,
      threadId: entry.threadId,
      projectId: entry.projectId,
      sequence,
      bytes: utf8Bytes(encodeReasoningEvidenceJson(toReasoningEvidence(modelFacing))),
    });
    if (source !== null) {
      threadsWithMessages.add(
        threadSearchMatchKey({
          environmentId: state.environment.environmentId,
          threadId: entry.threadId,
        }),
      );
    }
  };

  /**
   * Spends one read of the environment's and the search's budgets; false when
   * either is spent.
   */
  const takeRead = (state: EnvironmentState): boolean => {
    if (!state.available) return false;
    if (
      state.reads >= MAX_READS_PER_ENVIRONMENT ||
      totalReads >= AGENT_THREAD_SEARCH_MAX_TOTAL_READS
    ) {
      budgetExhausted = true;
      return false;
    }
    state.reads += 1;
    totalReads += 1;
    return true;
  };

  const readCatalogPage = Effect.fn("AgentThreadSearch.readCatalogPage")(function* (
    state: EnvironmentState,
  ) {
    const cursor = state.catalogCursor;
    if (cursor === null) return;
    if (cursor !== undefined && catalogReads >= MAX_TOTAL_CATALOG_READS) {
      budgetExhausted = true;
      return;
    }
    if (!takeRead(state)) return;
    catalogReads += 1;
    const result: Result.Result<OrchestrationThreadSearchCatalogPage, unknown> =
      yield* callEnvironment(
        state.environment.environmentId,
        ORCHESTRATION_WS_METHODS.listThreadSearchCatalog,
        { limit: THREAD_SEARCH_CATALOG_MAX_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
      );
    if (Result.isFailure(result)) {
      state.available = false;
      return;
    }
    for (const entry of result.success.threads) {
      addEvidence(state, `catalog:${entry.threadId}`, entry, null, "");
    }
    state.catalogCursor = result.success.nextCursor;
  });

  /**
   * Reads catalogs one page per environment per pass, so every environment
   * gets its first page before any environment reads a second one.
   */
  const readCatalogs = Effect.gen(function* () {
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      yield* forEachEnvironment(readCatalogPage);
    }
    // The page cap left part of a catalog unread.
    if (environments.some((state) => state.available && typeof state.catalogCursor === "string")) {
      budgetExhausted = true;
    }
  });

  /**
   * Reads the next evidence for one term, following `nextCursor` through
   * empty pages: the server scans a bounded window per page, so an empty page
   * does not mean the history is exhausted.
   */
  const readEvidence = Effect.fn("AgentThreadSearch.readEvidence")(function* (
    state: EnvironmentState,
    term: string,
    threadId?: ThreadId,
  ) {
    const scope = threadId ?? null;
    const termKey = term.toLowerCase();
    let cursors = state.cursors.get(scope);
    if (cursors === undefined) {
      cursors = new Map();
      state.cursors.set(scope, cursors);
    }
    for (let page = 0; page < MAX_PAGES_PER_READ; page += 1) {
      const cursor = cursors.get(termKey);
      if (cursor === null) return;
      if (!takeRead(state)) return;
      const result = yield* callEnvironment(
        state.environment.environmentId,
        ORCHESTRATION_WS_METHODS.searchThreadEvidence,
        {
          query: term,
          limit: EVIDENCE_PAGE_SIZE,
          ...(threadId === undefined ? {} : { threadId }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      if (Result.isFailure(result)) {
        state.available = false;
        return;
      }
      cursors.set(termKey, result.success.nextCursor);
      for (const match of result.success.matches) {
        const messageKey =
          match.messageId ?? `${match.threadId}:${match.messageCreatedAt}:${match.excerpt}`;
        addEvidence(state, `message:${messageKey}`, match, match.source, match.excerpt);
      }
      if (result.success.matches.length > 0) return;
    }
    // The page cap stopped a read with history still unscanned.
    if (typeof cursors.get(termKey) === "string") budgetExhausted = true;
  });

  const forEachEnvironment = <A, E, R>(
    run: (state: EnvironmentState) => Effect.Effect<A, E, R>,
  ) => {
    const available = environments.filter((state) => state.available);
    const start = available.length === 0 ? 0 : rotation % available.length;
    rotation += 1;
    return Effect.forEach([...available.slice(start), ...available.slice(0, start)], run, {
      concurrency: AGENT_THREAD_SEARCH_MAX_CONCURRENT_READS,
      discard: true,
    });
  };

  /**
   * Marks every environment whose session is gone as unavailable. This is a
   * local check, without an RPC, made when the model gives its verdict: an
   * environment that dropped after its last read must not stay openable.
   */
  const confirmConnections = Effect.suspend(() =>
    Effect.forEach(
      environments.filter((state) => state.available),
      (state) =>
        runInEnvironment(
          state.environment.environmentId,
          Effect.gen(function* () {
            const supervisor = yield* EnvironmentSupervisor;
            return Option.isSome(yield* SubscriptionRef.get(supervisor.session));
          }),
        ).pipe(
          Effect.result,
          Effect.map((connected) => {
            if (Result.isFailure(connected) || !connected.success) state.available = false;
          }),
        ),
      { discard: true },
    ),
  );

  const rememberTerms = (terms: ReadonlyArray<string>): ReadonlyArray<string> => {
    const accepted: string[] = [];
    for (const rawTerm of terms) {
      const term = normalizeTerm(rawTerm);
      if (term === null) continue;
      accepted.push(term);
      const known = searchedTerms.findIndex(
        (searched) => searched.toLowerCase() === term.toLowerCase(),
      );
      if (known !== -1) searchedTerms.splice(known, 1);
      searchedTerms.push(term);
    }
    // The model sees the most recent terms; older ones keep their cursors.
    if (searchedTerms.length > THREAD_SEARCH_REASONING_MAX_TERMS) {
      searchedTerms.splice(0, searchedTerms.length - THREAD_SEARCH_REASONING_MAX_TERMS);
    }
    return accepted;
  };

  /**
   * Chooses the evidence for one model step. Each environment offers its
   * newest message evidence, then catalog titles that contain a searched term,
   * then the rest of its catalog; environments take turns so none is starved.
   * The serialized request, JSON overhead included, stays within
   * THREAD_SEARCH_REASONING_MAX_INPUT_BYTES.
   */
  const selectModelEvidence = (): ReadonlyArray<EvidenceItem> => {
    const lowerTerms = searchedTerms.map((term) => term.toLowerCase());
    const titleMatchesTerm = (item: EvidenceItem) => {
      const titles = `${item.threadTitle}\n${item.projectTitle}`.toLowerCase();
      return lowerTerms.some((term) => titles.includes(term));
    };
    const messages = evidence
      .filter((item) => item.source !== null)
      .sort((left, right) => right.sequence - left.sequence);
    const catalog = evidence.filter(
      (item) =>
        item.source === null &&
        !threadsWithMessages.has(
          threadSearchMatchKey({ environmentId: item.environmentId, threadId: item.threadId }),
        ),
    );
    const candidates = interleaveByEnvironment([
      ...messages,
      ...catalog.filter(titleMatchesTerm),
      ...catalog.filter((item) => !titleMatchesTerm(item)),
    ]);
    const selected: EvidenceItem[] = [];
    let bytes = utf8Bytes(
      encodeReasoningInputJson({ description, searchedTerms: [...searchedTerms], evidence: [] }),
    );
    for (const item of candidates) {
      if (selected.length >= THREAD_SEARCH_REASONING_MAX_EVIDENCE) break;
      // Every item after the first adds a separating comma.
      const itemBytes = item.bytes + (selected.length > 0 ? 1 : 0);
      if (bytes + itemBytes > THREAD_SEARCH_REASONING_MAX_INPUT_BYTES) continue;
      bytes += itemBytes;
      selected.push(item);
    }
    return selected;
  };

  const verifiedMatches = (
    step: Extract<OrchestrationThreadSearchStep, { action: "finish" }>,
  ): ReadonlyArray<AgentThreadSearchMatch> => {
    const seen = new Set<string>();
    const matches: AgentThreadSearchMatch[] = [];
    for (const ranked of step.ranked) {
      const item = issuedRefs.get(ranked.ref);
      if (item === undefined) continue;
      const key = threadSearchMatchKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        environmentId: item.environmentId,
        environmentLabel: item.environmentLabel,
        threadId: item.threadId,
        projectId: item.projectId,
        threadTitle: item.threadTitle,
        projectTitle: item.projectTitle,
        archivedAt: item.archivedAt,
        reason: ranked.reason,
      });
    }
    return matches;
  };

  const noMatchOrRetrievalFailure = (): AgentThreadSearchResult =>
    anyAvailable()
      ? { status: "noConfidentMatch", coverage: coverage() }
      : { status: "failed", failure: "retrieval", coverage: coverage() };

  if (description.length === 0) {
    return { status: "noConfidentMatch", coverage: coverage() } satisfies AgentThreadSearchResult;
  }

  yield* readCatalogs;
  if (!anyAvailable()) {
    return noMatchOrRetrievalFailure();
  }

  for (let round = 0; round < MAX_MODEL_ROUNDS; round += 1) {
    const selected = selectModelEvidence();
    for (const item of selected) issuedRefs.set(item.ref, item);
    const stepResult = yield* callEnvironment(
      input.modelEnvironmentId,
      ORCHESTRATION_WS_METHODS.reasonThreadSearch,
      {
        description,
        searchedTerms: [...searchedTerms],
        evidence: selected.map(toReasoningEvidence),
      },
    );
    if (Result.isFailure(stepResult)) {
      return {
        status: "failed",
        failure: "model",
        coverage: coverage(),
      } satisfies AgentThreadSearchResult;
    }
    const step = stepResult.success;

    switch (step.action) {
      case "finish": {
        yield* confirmConnections;
        const matches = verifiedMatches(step).filter((match) => isAvailable(match.environmentId));
        if (matches.length > 0) {
          return {
            status: "matches",
            matches,
            coverage: coverage(),
          } satisfies AgentThreadSearchResult;
        }
        return noMatchOrRetrievalFailure();
      }
      case "broaden":
      case "readMore": {
        const terms = rememberTerms(step.terms);
        yield* forEachEnvironment((state) =>
          Effect.forEach(terms, (term) => readEvidence(state, term), { discard: true }),
        );
        break;
      }
      case "inspect": {
        // Before any search, fall back to the description's words, then to the
        // inspected thread's title, so an early inspection still reads evidence.
        const descriptionFallback = distinctiveTerms(description);
        const termsFor = (item: EvidenceItem) =>
          searchedTerms.length > 0
            ? searchedTerms.slice(-INSPECT_TERM_COUNT)
            : descriptionFallback.length > 0
              ? descriptionFallback
              : distinctiveTerms(item.threadTitle);
        const candidates = step.refs.flatMap((ref) => {
          const item = issuedRefs.get(ref);
          return item === undefined ? [] : [item];
        });
        yield* Effect.forEach(
          candidates,
          (item) => {
            const state = environments.find(
              (candidate) => candidate.environment.environmentId === item.environmentId,
            );
            return state === undefined
              ? Effect.void
              : Effect.forEach(termsFor(item), (term) => readEvidence(state, term, item.threadId), {
                  discard: true,
                });
          },
          { concurrency: AGENT_THREAD_SEARCH_MAX_CONCURRENT_READS, discard: true },
        );
        break;
      }
    }
  }

  budgetExhausted = true;
  yield* confirmConnections;
  return noMatchOrRetrievalFailure();
});
