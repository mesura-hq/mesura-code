// Mesura: Jev, the classifier the `find_threads` tool uses through OpenRouter
// (ADR-010). Entry point: `makeJevThreadSearch` over `FetchHttpClient` with a
// stub `fetch`; no test here reaches OpenRouter. Ported from commit d4e841fb56, with the shared step
// fixture of `@t3tools/provider-testing` in place of the branch's copy.
import * as NodeUtil from "node:util";
import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationThreadSearchReasoningInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FetchHttpClient } from "effect/http";

import { makeJevThreadSearch } from "./JevThreadSearch.ts";
import { THREAD_SEARCH_STEP_REQUEST } from "@t3tools/provider-testing/threadSearchStep";

const input = THREAD_SEARCH_STEP_REQUEST;
/** One Jev step, with every request answered by `fetch`. */
const jevWith =
  (apiKey: string, fetch: typeof globalThis.fetch) =>
  (request: OrchestrationThreadSearchReasoningInput) =>
    makeJevThreadSearch(apiKey).pipe(
      Effect.flatMap((step) => step(request)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
function decision(choice = "e1", probability = 0.95, support = 0.95) {
  return {
    answers: {
      match: {
        type: "choice",
        choice,
        probabilities: { e1: probability, none: 1 - probability },
        confidence: probability,
      },
      supports_e1: { type: "noul", noul: support },
    },
  };
}
function respond(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("Jev thread search", () => {
  it.effect(
    "Jev thread search accepts evidence when multiple refs split the Choice probability",
    () =>
      Effect.gen(function* () {
        const search = jevWith(
          "test-key",
          respond({
            answers: {
              match: {
                type: "choice",
                choice: "e1",
                probabilities: { e1: 0.45, e2: 0.45, none: 0.1 },
                confidence: 0.175,
              },
              supports_e1: { type: "noul", noul: 0.98 },
              supports_e2: { type: "noul", noul: 0.97 },
            },
          }),
        );
        const result = yield* search({
          ...input,
          evidence: [...input.evidence, { ...input.evidence[0]!, ref: "e2" }],
        });
        expect(result.action).toBe("finish");
        if (result.action === "finish")
          expect(result.ranked.map((item) => item.ref)).toEqual(["e1", "e2"]);
      }),
  );
  it.effect(
    "Jev thread search searches query vocabulary before accepting grounded message evidence",
    () =>
      Effect.gen(function* () {
        const search = jevWith("test-key", respond(decision()));
        const catalog = {
          ...input,
          searchedTerms: [],
          evidence: input.evidence.map((item) => ({ ...item, source: null, excerpt: "" })),
        };
        const first = yield* search(catalog);
        expect(first.action).toBe("broaden");
        if (first.action !== "broaden") return;
        expect(first.terms).toContain("cache");
        const final = yield* search({ ...input, searchedTerms: first.terms });
        expect(final.action).toBe("finish");
        if (final.action === "finish") {
          expect(final.ranked[0]?.ref).toBe("e1");
          expect(final.ranked[0]?.reason).toContain("Jev");
          expect(final.ranked[0]?.reason).toContain("cache");
        }
      }),
  );

  it.effect("Jev thread search rejects an overconfident choice with weak message evidence", () =>
    Effect.gen(function* () {
      const search = jevWith("test-key", respond(decision("e1", 0.99, 0.5)));
      expect(yield* search({ ...input, finalStep: true })).toEqual({
        action: "finish",
        ranked: [],
      });
    }),
  );

  it.effect("Jev thread search never accepts a title alone, even on the final step", () =>
    Effect.gen(function* () {
      const search = jevWith("test-key", respond(decision()));
      expect(
        yield* search({
          ...input,
          finalStep: true,
          evidence: input.evidence.map((item) => ({ ...item, source: null, excerpt: "" })),
        }),
      ).toEqual({ action: "finish", ranked: [] });
    }),
  );

  it.effect(
    "Jev thread search reads more when all query and candidate vocabulary was searched",
    () =>
      Effect.gen(function* () {
        const search = jevWith("test-key", respond(decision("none", 0.1, 0.1)));
        const first = yield* search(input);
        expect(first.action).toBe("broaden");
        if (first.action !== "broaden") return;
        const searchedTerms = [...input.searchedTerms, ...first.terms];
        for (let round = 0; round < 16; round += 1) {
          const next = yield* search({ ...input, searchedTerms });
          if (next.action === "broaden") searchedTerms.push(...next.terms);
          else {
            expect(next.action).toBe("readMore");
            return;
          }
        }
        expect.fail("Search never exhausted its existing vocabulary");
      }),
  );

  it.effect("Jev thread search rejects malformed probabilities and unknown references", () =>
    Effect.gen(function* () {
      for (const response of [decision("e1", 1.5), decision("invented")]) {
        const exit = yield* Effect.exit(jevWith("test-key", respond(response))(input));
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("Jev thread search keeps provider error bodies and credentials out of failures", () =>
    Effect.gen(function* () {
      const secret = "credential-must-stay-private";
      const exit = yield* Effect.exit(jevWith(secret, respond({ error: secret }, 401))(input));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(NodeUtil.inspect(exit, { depth: 10 })).not.toContain(secret);
    }),
  );
});
