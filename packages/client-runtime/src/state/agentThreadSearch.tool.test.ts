/**
 * Specs for the client side of the `find_threads` MCP tool (ADR-010).
 *
 * Entry point under test: `answerThreadSearchToolRequest` from
 * `./agentThreadSearch.ts`, which the connected client runs for each request
 * the server's thread search broker sends it, and whose result it returns to
 * the broker unchanged. Environments are the disposable fakes of
 * `threadSearchEnvironmentFakes.testFixtures.ts`, reached through the real
 * `EnvironmentRegistry` and RPC `request` path; the model environment's
 * `reasonThreadSearch` handler stands in for the server, answering Jev steps
 * (`engine: "jev"`) and configured text model steps (no engine) separately.
 */
import {
  EnvironmentId,
  jevUnavailableError,
  TextGenerationError,
  THREAD_SEARCH_WS_METHODS,
  type OrchestrationThreadSearchReasoningInput,
  type OrchestrationThreadSearchStep,
} from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { answerThreadSearchToolRequest } from "./agentThreadSearch.ts";
import {
  makeFakeEnvironments,
  makeFakeThread,
  type FakeReason,
} from "./threadSearchEnvironmentFakes.testFixtures.ts";

const METHODS = THREAD_SEARCH_WS_METHODS;
const MODEL_ENVIRONMENT = "env-search-host";
const TERM = "obsidian lantern";

const archivedTarget = makeFakeThread({
  threadId: "thread-lantern-archived",
  projectId: "project-mesura",
  title: "Lantern refactor",
  projectTitle: "Mesura Code",
  archivedAt: "2026-01-02T00:00:00.000Z",
  texts: [`We finished the ${TERM} refactor and archived the thread.`],
});
const unrelated = makeFakeThread({
  threadId: "thread-lunch",
  projectId: "project-mesura",
  title: "Lunch",
  projectTitle: "Mesura Code",
  texts: ["An ordinary conversation about lunch."],
  startMinute: 10,
});

/** One engine's model: it reads for `TERM` and ranks the first excerpt that holds it. */
const seekTerm = (reason: string) => (input: OrchestrationThreadSearchReasoningInput) => {
  const hit = input.evidence.find((item) => item.excerpt.toLowerCase().includes(TERM));
  const step: OrchestrationThreadSearchStep =
    hit !== undefined
      ? { action: "finish", ranked: [{ ref: hit.ref, reason: `${reason}: ${hit.excerpt}` }] }
      : input.searchedTerms.includes(TERM)
        ? { action: "readMore", terms: [TERM] }
        : { action: "broaden", terms: [TERM] };
  return Effect.succeed(step);
};

const answer = (jev: FakeReason, configured: FakeReason = seekTerm("Configured model")) =>
  Effect.gen(function* () {
    const fakes = yield* makeFakeEnvironments([
      {
        environmentId: MODEL_ENVIRONMENT,
        label: "vigilia-home",
        threads: [archivedTarget, unrelated],
        reason: (input) => (input.engine === "jev" ? jev(input) : configured(input)),
      },
    ]);
    const result = yield* answerThreadSearchToolRequest({
      description: "the thread where we refactored the obsidian lantern",
      environments: [
        { environmentId: EnvironmentId.make(MODEL_ENVIRONMENT), label: "vigilia-home" },
      ],
      modelEnvironmentId: EnvironmentId.make(MODEL_ENVIRONMENT),
    }).pipe(Effect.provideService(EnvironmentRegistry, fakes.registry));
    const reasoning = fakes
      .callsTo(MODEL_ENVIRONMENT, METHODS.reasonThreadSearch)
      .map((call) => call.input as OrchestrationThreadSearchReasoningInput);
    return { result, reasoning };
  });

describe("find_threads client answer", () => {
  it.effect(
    "find_threads client spec: Jev answers with matches, evidence, app URLs and coverage",
    () =>
      Effect.gen(function* () {
        const { result, reasoning } = yield* answer(seekTerm("Jev · evidence 95%"));

        expect(result.engine).toBe("jev");
        expect(result.status).toBe("matches");
        expect(reasoning.length).toBeGreaterThan(0);
        expect(reasoning.every((input) => input.engine === "jev")).toBe(true);
        const [match] = result.matches;
        expect(result.matches).toHaveLength(1);
        expect(match).toMatchObject({
          environmentId: MODEL_ENVIRONMENT,
          environmentLabel: "vigilia-home",
          threadId: "thread-lantern-archived",
          threadTitle: "Lantern refactor",
          projectTitle: "Mesura Code",
          archivedAt: "2026-01-02T00:00:00.000Z",
        });
        expect(match?.reason).toContain(TERM);
        expect(match?.url.startsWith("t3-thread://v1/")).toBe(true);
        expect(parseThreadLinkHref(match?.url ?? "")).toBe("thread-lantern-archived");
        expect(result.coverage).toEqual({
          unavailableEnvironments: [],
          budgetExhausted: false,
          unreadEvidence: expect.any(Boolean),
        });
        expect(result.detail.length).toBeGreaterThan(0);
      }),
  );

  it.effect(
    "find_threads client spec: Jev unavailable falls back to the configured text model in the same shape",
    () =>
      Effect.gen(function* () {
        const { result, reasoning } = yield* answer(() =>
          Effect.fail(jevUnavailableError("OPENROUTER_JEV_SEARCH_API_KEY is not set.")),
        );

        expect(result.engine).toBe("text-model");
        expect(result.status).toBe("matches");
        expect(result.matches.map((match) => match.threadId)).toEqual(["thread-lantern-archived"]);
        expect(result.matches[0]?.archivedAt).toBe("2026-01-02T00:00:00.000Z");
        expect(parseThreadLinkHref(result.matches[0]?.url ?? "")).toBe("thread-lantern-archived");
        expect(result.matches[0]?.reason).toContain("Configured model");
        // Jev was tried first, then every later step went to the configured model.
        expect(reasoning[0]?.engine).toBe("jev");
        expect(reasoning.some((input) => input.engine === undefined)).toBe(true);
      }),
  );

  it.effect(
    "find_threads client spec: an ordinary Jev failure is reported, not hidden behind the fallback",
    () =>
      Effect.gen(function* () {
        let configuredSteps = 0;
        const { result } = yield* answer(
          () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateThreadSearchStep",
                detail: "Jev returned no valid thread choice.",
              }),
            ),
          (input) => {
            configuredSteps += 1;
            return seekTerm("Configured model")(input);
          },
        );

        expect(result.engine).toBe("jev");
        expect(result.status).toBe("failed");
        expect(result.matches).toEqual([]);
        expect(configuredSteps).toBe(0);
      }),
  );
});
