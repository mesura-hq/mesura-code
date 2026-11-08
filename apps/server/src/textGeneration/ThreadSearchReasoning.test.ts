// Mesura: `makeReasonThreadSearch` for `engine: "jev"`, with OpenRouter as a stub `fetch`.
// Fallback contract: an unset `OPENROUTER_JEV_SEARCH_API_KEY`, a network failure or a 5xx fails
// the step with an error `isJevUnavailableError` accepts, so the client reruns on the configured
// text model. Any other Jev failure is an ordinary failure for the conversational model.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  isJevUnavailableError,
  ProviderInstanceId,
  type OrchestrationThreadSearchReasoningInput,
  type OrchestrationThreadSearchStep,
} from "@t3tools/contracts";
import { THREAD_SEARCH_STEP_REQUEST } from "@t3tools/provider-testing/threadSearchStep";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { FetchHttpClient } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeReasonThreadSearch } from "./ThreadSearchReasoning.ts";

const JEV_KEY_VARIABLE = "OPENROUTER_JEV_SEARCH_API_KEY";
const TEST_KEY = "jev-test-key-never-sent-anywhere";
const CONFIGURED_STEP: OrchestrationThreadSearchStep = {
  action: "finish",
  ranked: [{ ref: "e1", reason: "Configured text model." }],
};

const jevDecision = {
  answers: {
    match: {
      type: "choice",
      choice: "e1",
      probabilities: { e1: 0.95, none: 0.05 },
      confidence: 0.95,
    },
    supports_e1: { type: "noul", noul: 0.95 },
  },
};

type StubFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Runs one reasoning step with `key` in the server environment (or unset) and
 * `fetch` stubbed. Returns the step's exit, the requests the stub saw, and how
 * often the configured text model was asked.
 */
const reasonOnce = (options: {
  readonly key: string | undefined;
  readonly fetch: StubFetch;
  readonly input: OrchestrationThreadSearchReasoningInput;
}) =>
  Effect.gen(function* () {
    const configuredCalls = yield* Ref.make(0);
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const recordingFetch: typeof globalThis.fetch = (url, init) => {
      const request = { url: url instanceof Request ? url.url : String(url), init: init ?? {} };
      requests.push(request);
      return options.fetch(request.url, request.init);
    };
    const dependencies = Layer.mergeAll(
      ServerSettings.layerTest({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }),
      Layer.mock(TextGeneration.TextGeneration)({
        generateThreadSearchStep: () =>
          Ref.update(configuredCalls, (count) => count + 1).pipe(Effect.as(CONFIGURED_STEP)),
      }),
      FetchHttpClient.layer,
      // The server's environment, holding the key or not.
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: options.key === undefined ? {} : { [JEV_KEY_VARIABLE]: options.key },
        }),
      ),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const exit = yield* Effect.gen(function* () {
      const reason = yield* makeReasonThreadSearch;
      return yield* reason(options.input);
    }).pipe(
      Effect.exit,
      Effect.provide(dependencies),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch),
    );
    return { exit, requests, configuredCalls: yield* Ref.get(configuredCalls) };
  });

const jevInput: OrchestrationThreadSearchReasoningInput = {
  ...THREAD_SEARCH_STEP_REQUEST,
  engine: "jev",
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Cause.findErrorOption(exit.cause).pipe(Option.getOrThrow)
    : assert.fail("expected the Jev step to fail");

const unreachable: StubFetch = () => Promise.reject(new TypeError("fetch failed"));

it.effect("jev reasoning spec: an unset OpenRouter key fails the step as Jev unavailable", () =>
  Effect.gen(function* () {
    const result = yield* reasonOnce({ key: undefined, fetch: unreachable, input: jevInput });
    assert.isTrue(isJevUnavailableError(failureOf(result.exit)));
    assert.lengthOf(result.requests, 0, "no request may leave without a key");
    // The fallback is the client's: the server must not answer a Jev step with
    // the configured model behind the client's back.
    assert.equal(result.configuredCalls, 0);
  }),
);

it.effect("jev reasoning spec: an unreachable OpenRouter fails the step as Jev unavailable", () =>
  Effect.gen(function* () {
    const result = yield* reasonOnce({ key: TEST_KEY, fetch: unreachable, input: jevInput });
    assert.isTrue(isJevUnavailableError(failureOf(result.exit)));
    assert.equal(result.configuredCalls, 0);
  }),
);

it.effect("jev reasoning spec: an OpenRouter 5xx fails the step as Jev unavailable", () =>
  Effect.gen(function* () {
    const result = yield* reasonOnce({
      key: TEST_KEY,
      fetch: () => Promise.resolve(new Response("upstream down", { status: 503 })),
      input: jevInput,
    });
    assert.isTrue(isJevUnavailableError(failureOf(result.exit)));
  }),
);

it.effect("jev reasoning spec: a rejected OpenRouter credential is an ordinary Jev failure", () =>
  Effect.gen(function* () {
    const result = yield* reasonOnce({
      key: TEST_KEY,
      fetch: () => Promise.resolve(new Response("bad key", { status: 401 })),
      input: jevInput,
    });
    const failure = failureOf(result.exit);
    assert.equal((failure as { readonly _tag?: string })._tag, "TextGenerationError");
    assert.isFalse(isJevUnavailableError(failure));
  }),
);

it.effect("jev reasoning spec: with a key the step is answered by Jev through OpenRouter", () =>
  Effect.gen(function* () {
    const result = yield* reasonOnce({
      key: TEST_KEY,
      fetch: () => Promise.resolve(new Response(JSON.stringify(jevDecision), { status: 200 })),
      input: jevInput,
    });
    assert.equal(result.exit._tag, "Success");
    if (result.exit._tag !== "Success") return;
    assert.equal(result.exit.value.action, "finish");
    if (result.exit.value.action === "finish") {
      assert.deepEqual(
        result.exit.value.ranked.map((item) => item.ref),
        ["e1"],
      );
      assert.include(result.exit.value.ranked[0]?.reason ?? "", "Jev");
    }
    assert.lengthOf(result.requests, 1);
    assert.match(result.requests[0]?.url ?? "", /^https:\/\/openrouter\.ai\//);
    const headers = new Headers(result.requests[0]?.init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${TEST_KEY}`);
    assert.equal(result.configuredCalls, 0);
  }),
);

it.effect("jev reasoning guard: a step without an engine uses the configured text model", () =>
  Effect.gen(function* () {
    const result = yield* reasonOnce({
      key: TEST_KEY,
      fetch: unreachable,
      input: THREAD_SEARCH_STEP_REQUEST,
    });
    assert.equal(result.exit._tag, "Success");
    if (result.exit._tag === "Success") assert.deepEqual(result.exit.value, CONFIGURED_STEP);
    assert.equal(result.configuredCalls, 1);
    assert.lengthOf(result.requests, 0);
  }),
);
