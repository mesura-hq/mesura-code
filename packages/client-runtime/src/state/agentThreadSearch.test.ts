/**
 * Specs for the shared agent thread search coordinator.
 *
 * Entry point under test: `runAgentThreadSearch` from `./agentThreadSearch.ts`,
 * the callable that web and mobile share. Every environment is a disposable
 * fake behind the real `EnvironmentRegistry` and RPC `request` path (see
 * `threadSearchEnvironmentFakes.testFixtures.ts`); the configured model is a
 * scripted `reasonThreadSearch` handler on the model environment.
 */
import {
  EnvironmentId,
  OrchestrationSearchThreadsError,
  OrchestrationThreadSearchReasoningInput,
  ORCHESTRATION_WS_METHODS,
  THREAD_SEARCH_REASONING_MAX_INPUT_BYTES,
  TextGenerationError,
  type OrchestrationThreadSearchEvidenceInput,
  type OrchestrationThreadSearchReasoningEvidence,
  type OrchestrationThreadSearchReasoningInput as ReasoningInput,
  type OrchestrationThreadSearchStep,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AGENT_THREAD_SEARCH_MAX_CONCURRENT_READS,
  AGENT_THREAD_SEARCH_MAX_TOTAL_READS,
  runAgentThreadSearch,
  type AgentThreadSearchResult,
} from "./agentThreadSearch.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";
import {
  FAKE_EVIDENCE_SCAN_WINDOW,
  isoAt,
  makeFakeEnvironments,
  makeFakeThread,
  type FakeEnvironmentSpec,
  type FakeReason,
} from "./threadSearchEnvironmentFakes.testFixtures.ts";

const METHODS = ORCHESTRATION_WS_METHODS;
const decodeReasoningInput = Schema.decodeUnknownExit(OrchestrationThreadSearchReasoningInput);
const encodeReasoningInputJson = Schema.encodeUnknownSync(
  Schema.fromJsonString(OrchestrationThreadSearchReasoningInput),
);

function runSearch(
  specs: ReadonlyArray<FakeEnvironmentSpec>,
  options: {
    readonly description: string;
    readonly modelEnvironmentId: string;
    /** Environments the caller asks to search; defaults to every spec. */
    readonly environments?: ReadonlyArray<{
      readonly environmentId: string;
      readonly label: string;
    }>;
  },
) {
  return Effect.gen(function* () {
    const fakes = yield* makeFakeEnvironments(specs);
    const environments = (options.environments ?? specs).map((environment) => ({
      environmentId: EnvironmentId.make(environment.environmentId),
      label: environment.label,
    }));
    const search = runAgentThreadSearch({
      description: options.description,
      environments,
      modelEnvironmentId: EnvironmentId.make(options.modelEnvironmentId),
    }).pipe(Effect.provideService(EnvironmentRegistry, fakes.registry));
    return { fakes, search };
  });
}

function hasSearched(input: ReasoningInput, term: string): boolean {
  return input.searchedTerms.some((searched) => searched.toLowerCase() === term.toLowerCase());
}

function evidenceContaining(
  input: ReasoningInput,
  needle: string,
): ReadonlyArray<OrchestrationThreadSearchReasoningEvidence> {
  return input.evidence.filter((evidence) =>
    evidence.excerpt.toLowerCase().includes(needle.toLowerCase()),
  );
}

const finish = (
  ranked: ReadonlyArray<{ readonly ref: string; readonly reason: string }>,
): OrchestrationThreadSearchStep => ({ action: "finish", ranked });

/**
 * A model that only knows which term the description means: it broadens to
 * that term, keeps reading while the evidence lacks it, and ranks the first
 * excerpt that contains it.
 */
function modelSeeking(term: string, reason: string): FakeReason {
  return (input) => {
    const hit = evidenceContaining(input, term)[0];
    if (hit !== undefined) return Effect.succeed(finish([{ ref: hit.ref, reason }]));
    if (!hasSearched(input, term)) return Effect.succeed({ action: "broaden", terms: [term] });
    return Effect.succeed({ action: "readMore", terms: [term] });
  };
}

function matchKeys(result: AgentThreadSearchResult) {
  return result.status === "matches"
    ? result.matches.map((match) => [match.environmentId, match.threadId])
    : [];
}

function evidenceQueries(calls: ReadonlyArray<{ readonly input: unknown }>) {
  return calls.map((call) => (call.input as OrchestrationThreadSearchEvidenceInput).query);
}

describe("agent thread search: bounded cross-environment gathering", () => {
  const environmentIds = ["env-alpha-7f3", "env-beta-19c", "env-gamma-d42"];
  const specsWithLongEvidence = (reason: FakeReason): FakeEnvironmentSpec[] =>
    environmentIds.map((environmentId, environmentIndex) => ({
      environmentId,
      label: `Machine ${environmentIndex + 1}`,
      threads: Array.from({ length: 70 }, (_, threadIndex) =>
        makeFakeThread({
          threadId: `${environmentId}-thread-${String(threadIndex).padStart(4, "0")}`,
          projectId: `${environmentId}-project-${threadIndex % 3}`,
          title: `Release work ${threadIndex}`,
          projectTitle: `Project ${threadIndex % 3}`,
          texts: [`We need to deploy build ${threadIndex}. ${"detail ".repeat(400)}`],
          startMinute: threadIndex,
        }),
      ),
      ...(environmentIndex === 0 ? { reason } : {}),
    }));

  it.effect(
    "agentThreadSearch spec: reads every connected environment and sends the model only bounded, ID-free evidence",
    () =>
      Effect.gen(function* () {
        const specs = specsWithLongEvidence(modelSeeking("deploy", "Talks about the deploy."));
        const { fakes, search } = yield* runSearch(specs, {
          description: "the release where we shipped a build",
          modelEnvironmentId: "env-alpha-7f3",
        });

        const result = yield* search;

        for (const environmentId of environmentIds) {
          expect(
            fakes.callsTo(environmentId, METHODS.listThreadSearchCatalog).length,
          ).toBeGreaterThan(0);
          expect(fakes.callsTo(environmentId, METHODS.searchThreadEvidence).length).toBeGreaterThan(
            0,
          );
        }
        expect(fakes.callsTo("env-beta-19c", METHODS.reasonThreadSearch)).toEqual([]);
        expect(fakes.callsTo("env-gamma-d42", METHODS.reasonThreadSearch)).toEqual([]);

        const reasoningCalls = fakes.callsTo("env-alpha-7f3", METHODS.reasonThreadSearch);
        expect(reasoningCalls.length).toBeGreaterThan(0);
        const identifiers = specs.flatMap((spec) => [
          spec.environmentId,
          ...spec.threads.flatMap((thread) => [
            thread.threadId,
            thread.projectId,
            ...thread.messages.map((message) => message.messageId),
          ]),
        ]);
        for (const call of reasoningCalls) {
          // The contract schema carries the evidence, term, and excerpt bounds.
          expect(Exit.isSuccess(decodeReasoningInput(call.input))).toBe(true);
          const serialized = encodeReasoningInputJson(call.input);
          expect(identifiers.filter((identifier) => serialized.includes(identifier))).toEqual([]);
        }
        expect(result.status).toBe("matches");
      }),
  );

  it.effect(
    "agentThreadSearch spec: stops a model that never finishes and reports the exhausted budget",
    () =>
      Effect.gen(function* () {
        let round = 0;
        const endlessModel: FakeReason = () => {
          round += 1;
          return Effect.succeed({ action: "broaden", terms: [`term-${round}`, `other-${round}`] });
        };
        const { fakes, search } = yield* runSearch(specsWithLongEvidence(endlessModel), {
          description: "something I cannot quite remember",
          modelEnvironmentId: "env-alpha-7f3",
        });

        const result = yield* search;

        expect(result.status).toBe("noConfidentMatch");
        expect(result.coverage.budgetExhausted).toBe(true);
        for (const call of fakes.callsTo("env-alpha-7f3", METHODS.reasonThreadSearch)) {
          expect(Exit.isSuccess(decodeReasoningInput(call.input))).toBe(true);
        }
      }),
  );
});

describe("agent thread search: meaning-based recall", () => {
  it.effect(
    "agentThreadSearch spec: finds a message that shares no words with the description through model-chosen terms",
    () =>
      Effect.gen(function* () {
        const description =
          "the chat where we decided to replace our key value cache backend with a database file";
        const target = makeFakeThread({
          threadId: "thread-storage",
          projectId: "project-mesura",
          title: "Storage follow-up",
          projectTitle: "Mesura Code",
          texts: [
            "Can you look at the session layer?",
            "Done. We will move session persistence off Redis and onto SQLite, so the server no longer needs a separate daemon.",
          ],
        });
        const distractor = makeFakeThread({
          threadId: "thread-cache-question",
          projectId: "project-mesura",
          title: "Cache backend options",
          projectTitle: "Mesura Code",
          texts: ["Which backend should the cache use for key value lookups?"],
          startMinute: 10,
        });
        const remoteDistractor = makeFakeThread({
          threadId: "thread-kv-notes",
          projectId: "project-notes",
          title: "Key value notes",
          projectTitle: "Notes",
          texts: ["The key value store we picked for the cache is a database file."],
          startMinute: 20,
        });
        const descriptionWords = description.split(" ").filter((word) => word.length >= 4);
        const targetText = [target.title, ...target.messages.map((message) => message.text)]
          .join(" ")
          .toLowerCase();
        expect(descriptionWords.filter((word) => targetText.includes(word))).toEqual([]);

        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [target, distractor],
              reason: (input) => {
                const hit = input.evidence.find(
                  (evidence) => /redis/i.test(evidence.excerpt) && /sqlite/i.test(evidence.excerpt),
                );
                if (hit !== undefined) {
                  return Effect.succeed(
                    finish([{ ref: hit.ref, reason: "Moved persistence from Redis to SQLite." }]),
                  );
                }
                if (!hasSearched(input, "redis")) {
                  return Effect.succeed({ action: "broaden", terms: ["redis", "sqlite"] });
                }
                return Effect.succeed(finish([]));
              },
            },
            { environmentId: "env-server", label: "Server", threads: [remoteDistractor] },
          ],
          { description, modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(
          evidenceQueries(fakes.callsTo("env-laptop", METHODS.searchThreadEvidence)).map((query) =>
            query.toLowerCase(),
          ),
        ).toContain("redis");
        expect(result).toMatchObject({
          status: "matches",
          matches: [
            {
              environmentId: "env-laptop",
              environmentLabel: "Laptop",
              threadId: "thread-storage",
              projectId: "project-mesura",
              threadTitle: "Storage follow-up",
              projectTitle: "Mesura Code",
              archivedAt: null,
              reason: "Moved persistence from Redis to SQLite.",
            },
          ],
        });
        expect(matchKeys(result)).toEqual([["env-laptop", "thread-storage"]]);
      }),
  );
});

describe("agent thread search: deep history", () => {
  it.effect(
    "agentThreadSearch spec: reaches an archived match behind many empty scan windows and inspects it",
    () =>
      Effect.gen(function* () {
        // Real-database scale: about 13,000 messages, so the oldest message
        // sits behind six empty scan windows of the server's 2,000-row budget.
        const fillerCount = FAKE_EVIDENCE_SCAN_WINDOW * 6;
        const longThread = makeFakeThread({
          threadId: "thread-infra-marathon",
          projectId: "project-infra",
          title: "Infra marathon",
          projectTitle: "Infrastructure",
          archivedAt: isoAt(100_000),
          texts: [
            "We traced the connection stalls to pgbouncer running in transaction pooling mode.",
            ...Array.from({ length: fillerCount }, (_, index) => `Status update ${index}.`),
          ],
        });
        const recentThread = makeFakeThread({
          threadId: "thread-recent",
          projectId: "project-infra",
          title: "Recent chatter",
          projectTitle: "Infrastructure",
          texts: Array.from({ length: 1_000 }, (_, index) => `Recent note ${index}.`),
          startMinute: fillerCount + 10,
        });

        let inspected = false;
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [recentThread, longThread],
              reason: (input) => {
                const hit = evidenceContaining(input, "pgbouncer")[0];
                if (hit !== undefined && !inspected) {
                  inspected = true;
                  return Effect.succeed({ action: "inspect", refs: [hit.ref] });
                }
                if (hit !== undefined) {
                  return Effect.succeed(
                    finish([{ ref: hit.ref, reason: "Found the pgbouncer pooling cause." }]),
                  );
                }
                if (!hasSearched(input, "pgbouncer")) {
                  return Effect.succeed({ action: "broaden", terms: ["pgbouncer"] });
                }
                return Effect.succeed({ action: "readMore", terms: ["pgbouncer"] });
              },
            },
          ],
          {
            description: "why the database connections kept stalling",
            modelEnvironmentId: "env-laptop",
          },
        );

        const result = yield* search;

        expect(inspected).toBe(true);
        const inspections = fakes
          .callsTo("env-laptop", METHODS.searchThreadEvidence)
          .filter(
            (call) =>
              (call.input as OrchestrationThreadSearchEvidenceInput).threadId ===
              "thread-infra-marathon",
          );
        expect(inspections.length).toBeGreaterThan(0);
        expect(result).toMatchObject({
          status: "matches",
          matches: [
            {
              environmentId: "env-laptop",
              threadId: "thread-infra-marathon",
              archivedAt: longThread.archivedAt,
              reason: "Found the pgbouncer pooling cause.",
            },
          ],
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: a history deeper than one read's page cap reports an exhausted budget",
    () =>
      Effect.gen(function* () {
        const deepThread = makeFakeThread({
          threadId: "thread-deeper-than-cap",
          projectId: "project-infra",
          title: "Very long thread",
          projectTitle: "Infrastructure",
          texts: Array.from(
            { length: FAKE_EVIDENCE_SCAN_WINDOW * 9 },
            (_, index) => `Status update ${index}.`,
          ),
        });
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [deepThread],
              reason: (input) =>
                hasSearched(input, "pgbouncer")
                  ? Effect.succeed(finish([]))
                  : Effect.succeed({ action: "broaden", terms: ["pgbouncer"] }),
            },
          ],
          { description: "why the connections stalled", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: true },
        });
      }),
  );
});

describe("agent thread search: result validation", () => {
  const sharedThread = (title: string, texts: ReadonlyArray<string>) =>
    makeFakeThread({
      threadId: "thread-shared",
      projectId: "project-shared",
      title,
      projectTitle: "Shared project",
      texts,
    });

  const forgedRefs = [
    "thread-shared",
    "thread-hidden",
    "env-alpha",
    JSON.stringify(["env-alpha", "thread-hidden"]),
    "ref-forged-999",
  ];

  const specsWithModel = (reason: FakeReason): FakeEnvironmentSpec[] => [
    {
      environmentId: "env-alpha",
      label: "Laptop",
      threads: [
        sharedThread("Laptop copy", [
          "Plan the schema migration.",
          "The migration runs in two steps.",
        ]),
        makeFakeThread({
          threadId: "thread-hidden",
          projectId: "project-shared",
          title: "Unrelated",
          projectTitle: "Shared project",
          texts: ["Nothing relevant here."],
          startMinute: 30,
        }),
      ],
      reason,
    },
    {
      environmentId: "env-beta",
      label: "Server",
      threads: [sharedThread("Server copy", ["The migration finished on the server."])],
    },
  ];

  it.effect(
    "agentThreadSearch spec: drops forged refs and keeps one result per environment-scoped thread",
    () =>
      Effect.gen(function* () {
        let expectedOrder: Array<readonly [string, string]> = [];
        const { search } = yield* runSearch(
          specsWithModel((input) => {
            if (!hasSearched(input, "migration")) {
              return Effect.succeed({ action: "broaden", terms: ["migration"] });
            }
            const hits = evidenceContaining(input, "migration");
            const seen = new Set<string>();
            expectedOrder = [];
            for (const hit of hits) {
              const key = JSON.stringify([hit.environmentLabel, hit.threadTitle]);
              if (!seen.has(key)) {
                seen.add(key);
                expectedOrder.push([hit.environmentLabel, hit.threadTitle]);
              }
            }
            const refs = hits.map((hit) => hit.ref);
            const ranked = [forgedRefs[0]!, ...refs, ...forgedRefs.slice(1), refs[0]!].map(
              (ref) => ({ ref, reason: "Mentions the migration." }),
            );
            return Effect.succeed(finish(ranked.slice(0, 10)));
          }),
          { description: "the migration we planned", modelEnvironmentId: "env-alpha" },
        );

        const result = yield* search;

        expect(result.status).toBe("matches");
        expect(
          [...matchKeys(result)].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
        ).toEqual([
          ["env-alpha", "thread-shared"],
          ["env-beta", "thread-shared"],
        ]);
        expect(
          result.status === "matches"
            ? result.matches.map((match) => [match.environmentLabel, match.threadTitle])
            : [],
        ).toEqual(expectedOrder);
      }),
  );

  it.effect("agentThreadSearch spec: a ranking of only forged refs is no confident match", () =>
    Effect.gen(function* () {
      let rankedForgedRefs = false;
      const { search } = yield* runSearch(
        specsWithModel((input) => {
          if (!hasSearched(input, "migration")) {
            return Effect.succeed({ action: "broaden", terms: ["migration"] });
          }
          rankedForgedRefs = true;
          return Effect.succeed(
            finish(forgedRefs.map((ref) => ({ ref, reason: "Invented by the model." }))),
          );
        }),
        { description: "the migration we planned", modelEnvironmentId: "env-alpha" },
      );

      const result = yield* search;

      expect(rankedForgedRefs).toBe(true);
      expect(result.status).toBe("noConfidentMatch");
      expect(matchKeys(result)).toEqual([]);
    }),
  );
});

describe("agent thread search: cancellation and partial connectivity", () => {
  const needleThread = (threadId: string) =>
    makeFakeThread({
      threadId,
      projectId: "project-needle",
      title: `Needle thread ${threadId}`,
      projectTitle: "Needles",
      texts: ["The needle is in this message."],
    });

  it.effect("agentThreadSearch spec: interrupting the search interrupts the model request", () =>
    Effect.gen(function* () {
      const modelStarted = yield* Deferred.make<void>();
      let modelInterrupted = false;
      const { fakes, search } = yield* runSearch(
        [
          {
            environmentId: "env-laptop",
            label: "Laptop",
            threads: [needleThread("thread-a")],
            reason: () =>
              Deferred.succeed(modelStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    modelInterrupted = true;
                  }),
                ),
              ),
          },
        ],
        { description: "find the needle", modelEnvironmentId: "env-laptop" },
      );

      const fiber = yield* Effect.forkChild(search);
      yield* Deferred.await(modelStarted);
      const callsBeforeClose = fakes.calls.length;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(modelInterrupted).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(fakes.calls.length).toBe(callsBeforeClose);
    }),
  );

  it.effect(
    "agentThreadSearch spec: interrupting the search interrupts an outstanding evidence read",
    () =>
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        let readInterrupted = false;
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [needleThread("thread-a")],
              reason: modelSeeking("needle", "Has the needle."),
            },
            {
              environmentId: "env-server",
              label: "Server",
              threads: [needleThread("thread-b")],
              override: {
                searchThreadEvidence: () =>
                  Deferred.succeed(readStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        readInterrupted = true;
                      }),
                    ),
                  ),
              },
            },
          ],
          { description: "find the needle", modelEnvironmentId: "env-laptop" },
        );

        const fiber = yield* Effect.forkChild(search);
        yield* Deferred.await(readStarted);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        expect(readInterrupted).toBe(true);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }),
  );

  it.effect(
    "agentThreadSearch spec: names disconnected and unregistered environments in a partial result",
    () =>
      Effect.gen(function* () {
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [needleThread("thread-a")],
              reason: modelSeeking("needle", "Has the needle."),
            },
            {
              environmentId: "env-offline",
              label: "Offline box",
              threads: [needleThread("thread-b")],
              connected: false,
            },
            {
              environmentId: "env-dropped",
              label: "Dropped box",
              threads: [needleThread("thread-c")],
              disconnectAfterCatalog: true,
            },
          ],
          {
            description: "find the needle",
            modelEnvironmentId: "env-laptop",
            environments: [
              { environmentId: "env-laptop", label: "Laptop" },
              { environmentId: "env-offline", label: "Offline box" },
              { environmentId: "env-dropped", label: "Dropped box" },
              { environmentId: "env-forgotten", label: "Forgotten box" },
            ],
          },
        );

        const result = yield* search;

        expect(result.status).toBe("matches");
        expect(matchKeys(result)).toEqual([["env-laptop", "thread-a"]]);
        expect(
          [...result.coverage.unavailableEnvironments].sort((left, right) =>
            left.environmentId.localeCompare(right.environmentId),
          ),
        ).toEqual([
          { environmentId: "env-dropped", label: "Dropped box" },
          { environmentId: "env-forgotten", label: "Forgotten box" },
          { environmentId: "env-offline", label: "Offline box" },
        ]);
      }),
  );
});

describe("agent thread search: outcome kinds", () => {
  const plainThread = makeFakeThread({
    threadId: "thread-plain",
    projectId: "project-plain",
    title: "Plain thread",
    projectTitle: "Plain",
    texts: ["An ordinary conversation about lunch."],
  });

  it.effect(
    "agentThreadSearch spec: an empty final ranking reports no confident match with full coverage",
    () =>
      Effect.gen(function* () {
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [plainThread],
              reason: (input) =>
                hasSearched(input, "kubernetes")
                  ? Effect.succeed(finish([]))
                  : Effect.succeed({ action: "broaden", terms: ["kubernetes"] }),
            },
          ],
          { description: "the cluster outage", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        // No confident match is the model's verdict after a real search.
        expect(
          evidenceQueries(fakes.callsTo("env-laptop", METHODS.searchThreadEvidence)),
        ).toContain("kubernetes");
        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: false },
        });
        expect(matchKeys(result)).toEqual([]);
      }),
  );

  it.effect("agentThreadSearch spec: a text generation failure reports a model failure", () =>
    Effect.gen(function* () {
      const { search } = yield* runSearch(
        [
          {
            environmentId: "env-laptop",
            label: "Laptop",
            threads: [plainThread],
            reason: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "reasonThreadSearch",
                  detail: "Provider timed out.",
                }),
              ),
          },
        ],
        { description: "the cluster outage", modelEnvironmentId: "env-laptop" },
      );

      const result = yield* search;

      expect(result).toMatchObject({ status: "failed", failure: "model" });
    }),
  );

  it.effect(
    "agentThreadSearch spec: an unreachable model environment reports a model failure",
    () =>
      Effect.gen(function* () {
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [plainThread],
              connected: false,
              reason: () => Effect.succeed(finish([])),
            },
            { environmentId: "env-server", label: "Server", threads: [plainThread] },
          ],
          { description: "the cluster outage", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(result).toMatchObject({ status: "failed", failure: "model" });
      }),
  );

  it.effect(
    "agentThreadSearch spec: evidence failures in every environment report a retrieval failure",
    () =>
      Effect.gen(function* () {
        const failingReads = {
          listThreadSearchCatalog: () =>
            Effect.fail(new OrchestrationSearchThreadsError({ message: "Catalog read failed." })),
          searchThreadEvidence: () =>
            Effect.fail(new OrchestrationSearchThreadsError({ message: "Evidence read failed." })),
        };
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [plainThread],
              override: failingReads,
              reason: (input) =>
                hasSearched(input, "kubernetes")
                  ? Effect.succeed(finish([]))
                  : Effect.succeed({ action: "broaden", terms: ["kubernetes"] }),
            },
            {
              environmentId: "env-server",
              label: "Server",
              threads: [plainThread],
              override: failingReads,
            },
          ],
          { description: "the cluster outage", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(result).toMatchObject({ status: "failed", failure: "retrieval" });
      }),
  );
});

describe("agent thread search: shared client wiring", () => {
  const wiringThread = makeFakeThread({
    threadId: "thread-wired",
    projectId: "project-wired",
    title: "Wired thread",
    projectTitle: "Wiring",
    texts: ["The needle sits in the wired thread."],
  });
  const wiringInput = {
    description: "find the needle",
    environments: [{ environmentId: EnvironmentId.make("env-laptop"), label: "Laptop" }],
    modelEnvironmentId: EnvironmentId.make("env-laptop"),
  };

  const makeWiring = (reason: FakeReason) =>
    Effect.gen(function* () {
      const fakes = yield* makeFakeEnvironments([
        { environmentId: "env-laptop", label: "Laptop", threads: [wiringThread], reason },
      ]);
      const atoms = createOrchestrationEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, fakes.registry)),
      );
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      return { atoms, registry };
    });

  it.effect(
    "agentThreadSearch spec: the orchestration search atom returns the verified result",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { atoms, registry } = yield* makeWiring(modelSeeking("needle", "Has the needle."));
          const searchAtom = atoms.agentThreadSearch("picker");
          const unmount = registry.mount(searchAtom);

          registry.set(searchAtom, wiringInput);
          const result = yield* AtomRegistry.getResult(registry, searchAtom, {
            suspendOnWaiting: true,
          });

          expect(matchKeys(result)).toEqual([["env-laptop", "thread-wired"]]);
          unmount();
        }),
      ),
  );

  it.effect(
    "agentThreadSearch spec: unmounting the orchestration search atom cancels the search",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const modelStarted = yield* Deferred.make<void>();
          let modelInterrupted = false;
          const { atoms, registry } = yield* makeWiring(() =>
            Deferred.succeed(modelStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  modelInterrupted = true;
                }),
              ),
            ),
          );
          const searchAtom = atoms.agentThreadSearch("picker");
          const unmount = registry.mount(searchAtom);

          registry.set(searchAtom, wiringInput);
          yield* Deferred.await(modelStarted);
          unmount();
          yield* Effect.yieldNow;

          expect(modelInterrupted).toBe(true);
        }),
      ),
  );
});

describe("agent thread search: catalog coverage and prompt budget", () => {
  const catalogThreads = (
    prefix: string,
    count: number,
    title = (index: number) => `${prefix} ${index}`,
  ) =>
    Array.from({ length: count }, (_, index) =>
      makeFakeThread({
        threadId: `${prefix}-thread-${index}`,
        projectId: `${prefix}-project`,
        title: title(index),
        projectTitle: `${prefix} project`,
        texts: ["Nothing relevant here."],
        startMinute: index,
      }),
    );
  const inputBytes = (input: unknown) =>
    new TextEncoder().encode(encodeReasoningInputJson(input)).byteLength;

  it.effect(
    "agentThreadSearch spec: a catalog title beyond the first 200 threads reaches the model and the ranking",
    () =>
      Effect.gen(function* () {
        const threads = catalogThreads("big", 450, (index) =>
          index === 420 ? "Kubernetes rollout postmortem" : `Routine thread ${index}`,
        );
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads,
              reason: (input) => {
                if (!hasSearched(input, "kubernetes")) {
                  return Effect.succeed({ action: "broaden", terms: ["kubernetes"] });
                }
                const hit = input.evidence.find((item) => /kubernetes/i.test(item.threadTitle));
                return Effect.succeed(
                  finish(hit === undefined ? [] : [{ ref: hit.ref, reason: "Title names it." }]),
                );
              },
            },
          ],
          { description: "the cluster rollout review", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(fakes.callsTo("env-laptop", METHODS.listThreadSearchCatalog)).toHaveLength(3);
        expect(matchKeys(result)).toEqual([["env-laptop", "big-thread-420"]]);
        // Most of the 450 titles never fit a prompt: unread data, but no budget ended a read.
        expect(result.coverage).toMatchObject({ budgetExhausted: false, unreadEvidence: true });
      }),
  );

  it.effect(
    "agentThreadSearch spec: a catalog tail left unread by the page cap reports an exhausted budget",
    () =>
      Effect.gen(function* () {
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: catalogThreads("huge", 3_401),
              reason: (input) =>
                hasSearched(input, "kubernetes")
                  ? Effect.succeed(finish([]))
                  : Effect.succeed({ action: "broaden", terms: ["kubernetes"] }),
            },
          ],
          { description: "the cluster rollout review", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(fakes.callsTo("env-laptop", METHODS.listThreadSearchCatalog)).toHaveLength(16);
        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: true },
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: environments share model prompt slots within the serialized byte budget",
    () =>
      Effect.gen(function* () {
        // Multibyte titles and excerpts full of JSON escapes make each busy
        // item cost about 3 KB, so one environment alone could fill the budget.
        const wideTitle = (label: string) => `${label} ${"項".repeat(190)}`;
        const busy = Array.from({ length: 40 }, (_, index) =>
          makeFakeThread({
            threadId: `busy-thread-${index}`,
            projectId: "busy-project",
            title: wideTitle(`Busy ${index}`),
            projectTitle: wideTitle("Busy project"),
            texts: [`deploy ${'"quoted" \\ \n 配置 '.repeat(60)}`],
            startMinute: index,
          }),
        );
        const quiet = [
          makeFakeThread({
            threadId: "quiet-thread",
            projectId: "quiet-project",
            title: wideTitle("Quiet"),
            projectTitle: wideTitle("Quiet project"),
            texts: ["One deploy note."],
          }),
        ];
        const catalogOnly = catalogThreads("catalog", 250, (index) =>
          wideTitle(`Catalog ${index}`),
        );
        const reasoningInputs: ReasoningInput[] = [];
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-busy",
              label: "Busy box",
              threads: busy,
              reason: (input) => {
                reasoningInputs.push(input);
                return hasSearched(input, "deploy")
                  ? Effect.succeed(finish([]))
                  : Effect.succeed({ action: "broaden", terms: ["deploy", "配置"] });
              },
            },
            { environmentId: "env-quiet", label: "Quiet box", threads: quiet },
            { environmentId: "env-catalog", label: "Catalog box", threads: catalogOnly },
          ],
          { description: "the deploy we argued about", modelEnvironmentId: "env-busy" },
        );

        yield* search;

        expect(reasoningInputs.length).toBeGreaterThan(1);
        for (const input of reasoningInputs) {
          expect(inputBytes(input)).toBeLessThanOrEqual(THREAD_SEARCH_REASONING_MAX_INPUT_BYTES);
        }
        const afterSearch = reasoningInputs.at(-1)!;
        // The budget binds: the busy environment alone holds more than fits.
        expect(inputBytes(afterSearch)).toBeGreaterThan(
          THREAD_SEARCH_REASONING_MAX_INPUT_BYTES * 0.9,
        );
        const slotsPerEnvironment = new Map<string, number>();
        for (const item of afterSearch.evidence) {
          slotsPerEnvironment.set(
            item.environmentLabel,
            (slotsPerEnvironment.get(item.environmentLabel) ?? 0) + 1,
          );
        }
        // Turns alternate, so the catalog-only environment holds as many slots
        // as the busy one, give or take the single item the budget cuts off.
        const busySlots = slotsPerEnvironment.get("Busy box") ?? 0;
        const catalogSlots = slotsPerEnvironment.get("Catalog box") ?? 0;
        expect(busySlots).toBeGreaterThan(5);
        expect(Math.abs(busySlots - catalogSlots)).toBeLessThanOrEqual(1);
        expect(slotsPerEnvironment.get("Quiet box")).toBe(1);
        expect(evidenceContaining(afterSearch, "One deploy note")).toHaveLength(1);
      }),
  );
});

describe("agent thread search: verdict coverage and fallback inspection", () => {
  const titledThreads = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      makeFakeThread({
        threadId: `titled-thread-${index}`,
        projectId: "titled-project",
        title: `Routine thread ${index}`,
        projectTitle: "Routine",
        texts: ["Nothing relevant here."],
        startMinute: index,
      }),
    );
  const emptyFinishAfterBroaden: FakeReason = (input) =>
    hasSearched(input, "kubernetes")
      ? Effect.succeed(finish([]))
      : Effect.succeed({ action: "broaden", terms: ["kubernetes"] });

  it.effect(
    "agentThreadSearch spec: an empty finish over catalog titles the model never saw reports partial coverage",
    () =>
      Effect.gen(function* () {
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: titledThreads(90),
              reason: emptyFinishAfterBroaden,
            },
          ],
          { description: "the cluster rollout review", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: true },
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: an empty finish after every catalog title was shown reports full coverage",
    () =>
      Effect.gen(function* () {
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: titledThreads(50),
              reason: emptyFinishAfterBroaden,
            },
          ],
          { description: "the cluster rollout review", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: false },
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: a later step that shows the omitted titles clears the partial-coverage verdict",
    () =>
      Effect.gen(function* () {
        // 90 titles need two prompts of up to 60. The model broadens twice with
        // terms that match titles 60 to 89, so its second prompt shows them.
        const threads = Array.from({ length: 90 }, (_, index) =>
          makeFakeThread({
            threadId: `split-thread-${index}`,
            projectId: "split-project",
            title: index >= 60 ? `Tail ${index}` : `Head ${index}`,
            projectTitle: "Split",
            texts: ["Nothing relevant here."],
            startMinute: index,
          }),
        );
        const titlesSeen = new Set<string>();
        const { search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads,
              reason: (input) => {
                for (const item of input.evidence) titlesSeen.add(item.threadTitle);
                return hasSearched(input, "tail")
                  ? Effect.succeed(finish([]))
                  : Effect.succeed({ action: "broaden", terms: ["tail"] });
              },
            },
          ],
          { description: "the cluster rollout review", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(titlesSeen.size).toBe(90);
        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: false },
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: inspecting a catalog ref before any search reads that thread with description words",
    () =>
      Effect.gen(function* () {
        const target = makeFakeThread({
          threadId: "thread-connection",
          projectId: "project-net",
          title: "Connection issues",
          projectTitle: "Networking",
          texts: [
            "Can you look at the client?",
            "The websocket reconnect loop is fixed by adding backoff.",
          ],
        });
        const other = makeFakeThread({
          threadId: "thread-other",
          projectId: "project-net",
          title: "Other work",
          projectTitle: "Networking",
          texts: ["The websocket reconnect loop also appears here."],
          startMinute: 10,
        });
        const inputs: ReasoningInput[] = [];
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [target, other],
              reason: (input) => {
                inputs.push(input);
                if (inputs.length === 1) {
                  const catalogRef = input.evidence.find(
                    (item) => item.threadTitle === "Connection issues",
                  )!.ref;
                  return Effect.succeed({ action: "inspect", refs: [catalogRef] });
                }
                return Effect.succeed(finish([]));
              },
            },
          ],
          {
            description: "why the websocket reconnect loop kept happening",
            modelEnvironmentId: "env-laptop",
          },
        );

        yield* search;

        expect(inputs[0]!.searchedTerms).toEqual([]);
        const inspections = fakes
          .callsTo("env-laptop", METHODS.searchThreadEvidence)
          .map((call) => call.input as OrchestrationThreadSearchEvidenceInput);
        expect(inspections.length).toBeGreaterThan(0);
        expect(inspections.every((call) => call.threadId === "thread-connection")).toBe(true);
        const messageEvidence = inputs[1]!.evidence.filter((item) => item.source !== null);
        expect(messageEvidence.map((item) => item.threadTitle)).toContain("Connection issues");
        expect(messageEvidence.every((item) => item.threadTitle === "Connection issues")).toBe(
          true,
        );
        expect(evidenceContaining(inputs[1]!, "backoff")).toHaveLength(1);
      }),
  );

  it.effect(
    "agentThreadSearch spec: inspecting before any search with a description of short words still reads that thread",
    () =>
      Effect.gen(function* () {
        const target = makeFakeThread({
          threadId: "thread-dashboard",
          projectId: "project-app",
          title: "Dashboard work",
          projectTitle: "App",
          texts: ["Fix it please.", "The db ui shows stale rows after a refresh."],
        });
        const inputs: ReasoningInput[] = [];
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [target],
              reason: (input) => {
                inputs.push(input);
                if (inputs.length === 1) {
                  const catalogRef = input.evidence.find(
                    (item) => item.threadTitle === "Dashboard work",
                  )!.ref;
                  return Effect.succeed({ action: "inspect", refs: [catalogRef] });
                }
                return Effect.succeed(finish([]));
              },
            },
          ],
          { description: "db ui", modelEnvironmentId: "env-laptop" },
        );

        yield* search;

        const inspections = fakes
          .callsTo("env-laptop", METHODS.searchThreadEvidence)
          .map((call) => call.input as OrchestrationThreadSearchEvidenceInput);
        expect(inspections.length).toBeGreaterThan(0);
        for (const call of inspections) {
          expect(call.threadId).toBe("thread-dashboard");
          expect(call.query.length).toBeGreaterThanOrEqual(2);
        }
        expect(evidenceContaining(inputs[1]!, "stale rows")).toHaveLength(1);
      }),
  );

  it.effect(
    "agentThreadSearch spec: inspecting before any search with no usable description word reads by the thread title",
    () =>
      Effect.gen(function* () {
        const target = makeFakeThread({
          threadId: "thread-dashboard-title",
          projectId: "project-app",
          title: "Dashboard work",
          projectTitle: "App",
          texts: ["Fix it please.", "The dashboard shows stale rows after a refresh."],
        });
        const inputs: ReasoningInput[] = [];
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [target],
              reason: (input) => {
                inputs.push(input);
                if (inputs.length === 1) {
                  return Effect.succeed({ action: "inspect", refs: [input.evidence[0]!.ref] });
                }
                return Effect.succeed(finish([]));
              },
            },
          ],
          { description: "x", modelEnvironmentId: "env-laptop" },
        );

        yield* search;

        const queries = evidenceQueries(fakes.callsTo("env-laptop", METHODS.searchThreadEvidence));
        expect(queries).toContain("dashboard");
        expect(evidenceContaining(inputs[1]!, "stale rows")).toHaveLength(1);
      }),
  );
});

describe("agent thread search: review repairs", () => {
  it.effect(
    "agentThreadSearch spec: a ranked environment that dropped after its catalog read is excluded and reported",
    () =>
      Effect.gen(function* () {
        const laptopThread = makeFakeThread({
          threadId: "thread-laptop",
          projectId: "project-a",
          title: "Laptop migration notes",
          projectTitle: "A",
          texts: ["Nothing else."],
        });
        const droppedThread = makeFakeThread({
          threadId: "thread-dropped",
          projectId: "project-b",
          title: "Server migration notes",
          projectTitle: "B",
          texts: ["Nothing else."],
        });
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [laptopThread],
              // The first step ranks both catalog titles, with no read in between.
              reason: (input) =>
                Effect.succeed(
                  finish(input.evidence.map((item) => ({ ref: item.ref, reason: "Title fits." }))),
                ),
            },
            {
              environmentId: "env-dropped",
              label: "Dropped box",
              threads: [droppedThread],
              disconnectAfterCatalog: true,
            },
          ],
          { description: "the migration notes", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(fakes.callsTo("env-dropped", METHODS.searchThreadEvidence)).toEqual([]);
        expect(matchKeys(result)).toEqual([["env-laptop", "thread-laptop"]]);
        expect(result.coverage.unavailableEnvironments).toEqual([
          { environmentId: "env-dropped", label: "Dropped box" },
        ]);
      }),
  );

  it.effect(
    "agentThreadSearch spec: an empty finish with an evidence cursor still open reports unread evidence without an exhausted budget",
    () =>
      Effect.gen(function* () {
        // 30 matching messages: the first page returns 20 and an open cursor.
        const thread = makeFakeThread({
          threadId: "thread-many",
          projectId: "project-a",
          title: "Many mentions",
          projectTitle: "A",
          texts: Array.from({ length: 30 }, (_, index) => `kubernetes note ${index}`),
        });
        const { fakes, search } = yield* runSearch(
          [
            {
              environmentId: "env-laptop",
              label: "Laptop",
              threads: [thread],
              reason: (input) =>
                hasSearched(input, "kubernetes")
                  ? Effect.succeed(finish([]))
                  : Effect.succeed({ action: "broaden", terms: ["kubernetes"] }),
            },
          ],
          { description: "the cluster notes", modelEnvironmentId: "env-laptop" },
        );

        const result = yield* search;

        expect(fakes.callsTo("env-laptop", METHODS.searchThreadEvidence)).toHaveLength(1);
        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: true },
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: many environments share a bounded total of concurrent reads",
    () =>
      Effect.gen(function* () {
        const environmentCount = 24;
        let round = 0;
        const specs: FakeEnvironmentSpec[] = Array.from(
          { length: environmentCount },
          (_, index) => ({
            environmentId: `env-${index}`,
            label: `Machine ${index}`,
            threads: [
              makeFakeThread({
                threadId: `thread-${index}`,
                projectId: "project",
                title: `Thread ${index}`,
                projectTitle: "Project",
                texts: ["Nothing relevant here."],
              }),
            ],
            ...(index === 0
              ? {
                  reason: () => {
                    round += 1;
                    return Effect.succeed({
                      action: "broaden" as const,
                      terms: [`term-${round}-a`, `term-${round}-b`],
                    });
                  },
                }
              : {}),
          }),
        );
        const { fakes, search } = yield* runSearch(specs, {
          description: "something I cannot quite remember",
          modelEnvironmentId: "env-0",
        });

        const result = yield* search;

        const reads = fakes.calls.filter(
          (call) =>
            call.method === METHODS.listThreadSearchCatalog ||
            call.method === METHODS.searchThreadEvidence,
        );
        expect(fakes.maxReadsInFlight()).toBeGreaterThan(1);
        expect(fakes.maxReadsInFlight()).toBeLessThanOrEqual(
          AGENT_THREAD_SEARCH_MAX_CONCURRENT_READS,
        );
        expect(reads.length).toBeLessThanOrEqual(AGENT_THREAD_SEARCH_MAX_TOTAL_READS);
        // The first pass reaches every environment before the total cap bites.
        for (const spec of specs) {
          expect(fakes.callsTo(spec.environmentId, METHODS.listThreadSearchCatalog)).toHaveLength(
            1,
          );
        }
        expect(result.coverage.budgetExhausted).toBe(true);
      }),
  );

  const oneThreadEnvironments = (count: number, threadsPerEnvironment = 1): FakeEnvironmentSpec[] =>
    Array.from({ length: count }, (_, environmentIndex) => ({
      environmentId: `env-${environmentIndex}`,
      label: `Machine ${environmentIndex}`,
      threads: Array.from({ length: threadsPerEnvironment }, (_, threadIndex) =>
        makeFakeThread({
          threadId: `thread-${environmentIndex}-${threadIndex}`,
          projectId: "project",
          title: `Thread ${threadIndex}`,
          projectTitle: "Project",
          texts: ["Nothing relevant here."],
          startMinute: threadIndex,
        }),
      ),
    }));

  it.effect(
    "agentThreadSearch spec: running out of model rounds over fully read data spends the budget without unread evidence",
    () =>
      Effect.gen(function* () {
        let round = 0;
        const [laptop] = oneThreadEnvironments(1);
        const { search } = yield* runSearch(
          [
            {
              ...laptop!,
              reason: () => {
                round += 1;
                return Effect.succeed({ action: "broaden", terms: [`absent-${round}`] });
              },
            },
          ],
          { description: "something I cannot quite remember", modelEnvironmentId: "env-0" },
        );

        const result = yield* search;

        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { unavailableEnvironments: [], budgetExhausted: true, unreadEvidence: false },
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: environments the total read cap leaves unstarted are reported as unread",
    () =>
      Effect.gen(function* () {
        // Empty catalogs hold no evidence, so only the unstarted catalogs
        // can make the result report unread evidence.
        const specs = oneThreadEnvironments(AGENT_THREAD_SEARCH_MAX_TOTAL_READS + 4, 0);
        const { fakes, search } = yield* runSearch(
          specs.map((spec, index) =>
            index === 0 ? { ...spec, reason: () => Effect.succeed(finish([])) } : spec,
          ),
          { description: "something I cannot quite remember", modelEnvironmentId: "env-0" },
        );

        const result = yield* search;

        const unstarted = specs.filter(
          (spec) => fakes.callsTo(spec.environmentId, METHODS.listThreadSearchCatalog).length === 0,
        );
        expect(unstarted).toHaveLength(4);
        expect(
          fakes.calls.filter((call) => call.method === METHODS.listThreadSearchCatalog),
        ).toHaveLength(AGENT_THREAD_SEARCH_MAX_TOTAL_READS);
        expect(result).toMatchObject({
          status: "noConfidentMatch",
          coverage: { budgetExhausted: true, unreadEvidence: true },
        });
      }),
  );

  it.effect(
    "agentThreadSearch spec: catalog pages are read in fair passes until the catalog share is spent",
    () =>
      Effect.gen(function* () {
        // 20 catalogs of 7 pages want 140 reads, more than the catalog share.
        const specs = oneThreadEnvironments(20, 1_400);
        const { fakes, search } = yield* runSearch(
          specs.map((spec, index) =>
            index === 0 ? { ...spec, reason: () => Effect.succeed(finish([])) } : spec,
          ),
          { description: "something I cannot quite remember", modelEnvironmentId: "env-0" },
        );

        const result = yield* search;

        const pagesPerEnvironment = specs.map(
          (spec) => fakes.callsTo(spec.environmentId, METHODS.listThreadSearchCatalog).length,
        );
        expect(Math.min(...pagesPerEnvironment)).toBeGreaterThanOrEqual(1);
        expect(
          Math.max(...pagesPerEnvironment) - Math.min(...pagesPerEnvironment),
        ).toBeLessThanOrEqual(1);
        expect(pagesPerEnvironment.reduce((total, pages) => total + pages, 0)).toBeLessThan(140);
        expect(result.coverage).toMatchObject({ budgetExhausted: true, unreadEvidence: true });
      }),
  );
});
