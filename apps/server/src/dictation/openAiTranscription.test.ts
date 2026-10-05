/**
 * Phase 1 fence of the dictation redesign: acceptance criteria 1, 2 and 3 at
 * the OpenAI call.
 *
 * Entry point: `makeOpenAiTranscription`, the constructor `DictationJobs`
 * uses for every attempt. OpenAI is an `HttpClient` built with
 * `HttpClient.make`, as `usage/cliproxyApi.test.ts` stubs its hub, so the
 * multipart fields asserted here are the fields that leave the server. The
 * clock is `TestClock`; retry delays and the per-attempt timeout are measured
 * on it, never slept.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import {
  LONG_RECORDING_THRESHOLD_MS,
  makeOpenAiTranscription,
  OPENAI_TRANSCRIPTION_URL,
  type OpenAiTranscriptionRequest,
} from "./openAiTranscription.ts";

const LANGUAGE_LINE = "The speaker primarily speaks English and Spanish.";
const HINTS_LEAD = "Use these exact spellings: ";
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  /** Every multipart field; a file field is read back to its bytes. */
  readonly fields: ReadonlyMap<string, string | { name: string; bytes: Uint8Array }>;
  /** TestClock time at which the request left. */
  readonly sentAt: number;
}

type Reply =
  | { readonly status: number; readonly body: string }
  | { readonly transport: true }
  | { readonly hang: true };

/**
 * An OpenAI stand-in that answers the n-th request with `replies[n]` (the
 * last reply repeats) and records every request it saw.
 */
function fakeOpenAi(replies: ReadonlyArray<Reply>) {
  const requests: Array<CapturedRequest> = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const sentAt = yield* Clock.currentTimeMillis;
      const fields = new Map<string, string | { name: string; bytes: Uint8Array }>();
      if (request.body._tag === "FormData") {
        for (const [key, value] of request.body.formData.entries()) {
          if (typeof value === "string") {
            fields.set(key, value);
          } else {
            const bytes = new Uint8Array(yield* Effect.promise(() => value.arrayBuffer()));
            fields.set(key, { name: value.name, bytes });
          }
        }
      }
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        fields,
        sentAt,
      });
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      if ("hang" in reply) return yield* Effect.never;
      if ("transport" in reply) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "ECONNRESET" }),
        });
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.body, {
          status: reply.status,
          headers: { "content-type": "text/plain" },
        }),
      );
    }),
  );
  return { requests, http };
}

const baseRequest: OpenAiTranscriptionRequest = {
  apiKey: "sk-test-dictation",
  audio: AUDIO,
  fileName: "recording.webm",
  durationMs: 60_000,
  vocabularyHints: [],
};

/**
 * Runs one transcription against `replies`, advancing the TestClock one
 * second at a time until it settles, so retry delays and timeouts elapse
 * without a real sleep.
 */
const transcribeWith = (
  replies: ReadonlyArray<Reply>,
  overrides: Partial<OpenAiTranscriptionRequest> = {},
) =>
  Effect.gen(function* () {
    const openAi = fakeOpenAi(replies);
    const transcription = yield* makeOpenAiTranscription.pipe(
      Effect.provideService(HttpClient.HttpClient, openAi.http),
    );
    const fiber = yield* Effect.forkChild(
      transcription.transcribe({ ...baseRequest, ...overrides }),
    );
    for (let second = 0; second < 600 && fiber.pollUnsafe() === undefined; second += 1) {
      yield* TestClock.adjust("1 second");
    }
    const exit = yield* Fiber.await(fiber);
    return { exit, requests: openAi.requests };
  });

const fieldText = (request: CapturedRequest | undefined, name: string) => {
  const value = request?.fields.get(name);
  assert.isString(value, `multipart field ${name}`);
  return value as string;
};

const failureReason = (exit: Exit.Exit<string, { readonly reason: string }>) => {
  assert.isTrue(Exit.isFailure(exit), "the transcription should fail");
  const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
  assert.strictEqual(error?._tag, "Fail");
  return (error as { readonly error: { readonly reason: string } }).error.reason;
};

describe("openAiTranscription phase 1 fence", () => {
  it.effect(
    "dictation phase 1 AC1: a short recording posts gpt-4o-transcribe at temperature 0 with the bilingual prompt and no language",
    () =>
      Effect.gen(function* () {
        const { exit, requests } = yield* transcribeWith([{ status: 200, body: "Hola, world." }], {
          vocabularyHints: ["Mesura", "Hyprland", "Mesura"],
        });

        assert.deepStrictEqual(exit, Exit.succeed("Hola, world."));
        assert.lengthOf(requests, 1);
        const request = requests[0]!;
        assert.strictEqual(request.url, OPENAI_TRANSCRIPTION_URL);
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.authorization, "Bearer sk-test-dictation");
        assert.strictEqual(fieldText(request, "model"), "gpt-4o-transcribe");
        assert.strictEqual(fieldText(request, "temperature"), "0");
        assert.strictEqual(fieldText(request, "response_format"), "text");
        assert.isFalse(request.fields.has("language"), "no language field is sent");
        const file = request.fields.get("file");
        assert.isObject(file);
        assert.deepStrictEqual((file as { bytes: Uint8Array }).bytes, AUDIO);
        assert.strictEqual((file as { name: string }).name, "recording.webm");

        const prompt = fieldText(request, "prompt");
        assert.match(prompt, /verbatim/i);
        assert.match(prompt, /filler/i);
        assert.match(prompt, /false start/i);
        assert.match(prompt, /paragraph/i);
        assert.include(prompt, LANGUAGE_LINE);
        // Comma-joined and deduplicated, after the instructions.
        assert.include(prompt, `${HINTS_LEAD}Mesura, Hyprland`);
        assert.strictEqual(prompt.split("Mesura").length - 1, 1);
      }),
  );

  it.effect("dictation phase 1 AC1: vocabulary hints are cut to 400 characters in the prompt", () =>
    Effect.gen(function* () {
      const hints = Array.from({ length: 80 }, (_, index) => `Term${index}`);
      const { requests } = yield* transcribeWith([{ status: 200, body: "ok" }], {
        vocabularyHints: hints,
      });
      const prompt = fieldText(requests[0], "prompt");
      const lead = prompt.indexOf(HINTS_LEAD);
      assert.isAtLeast(lead, 0);
      const hintText = prompt.slice(lead + HINTS_LEAD.length);
      assert.isAtMost(hintText.length, 400);
      assert.isTrue(hintText.startsWith("Term0, Term1, Term2"));
      assert.notInclude(hintText, "Term79");
    }),
  );

  it.effect("dictation phase 1 AC1: a prompt without vocabulary hints has no spellings line", () =>
    Effect.gen(function* () {
      const { requests } = yield* transcribeWith([{ status: 200, body: "ok" }]);
      const prompt = fieldText(requests[0], "prompt");
      assert.include(prompt, LANGUAGE_LINE);
      assert.notInclude(prompt, HINTS_LEAD);
    }),
  );

  it.effect(
    "dictation phase 1 AC2: a recording longer than 420 seconds is sent to whisper-1 with only the language line",
    () =>
      Effect.gen(function* () {
        const { exit, requests } = yield* transcribeWith([{ status: 200, body: "long talk" }], {
          durationMs: LONG_RECORDING_THRESHOLD_MS + 1,
        });
        assert.deepStrictEqual(exit, Exit.succeed("long talk"));
        assert.strictEqual(fieldText(requests[0], "model"), "whisper-1");
        assert.strictEqual(fieldText(requests[0], "temperature"), "0");
        assert.isFalse(requests[0]!.fields.has("language"));
        const prompt = fieldText(requests[0], "prompt");
        assert.include(prompt, LANGUAGE_LINE);
        assert.notMatch(prompt, /verbatim/i);
      }),
  );

  it.effect(
    "dictation phase 1 AC2: a recording of exactly 420 seconds stays on gpt-4o-transcribe",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(LONG_RECORDING_THRESHOLD_MS, 420_000);
        const { requests } = yield* transcribeWith([{ status: 200, body: "ok" }], {
          durationMs: 420_000,
        });
        assert.strictEqual(fieldText(requests[0], "model"), "gpt-4o-transcribe");
      }),
  );

  it.effect(
    "dictation phase 1 AC3: two 5xx answers are retried 2 seconds apart and the third attempt's text is returned",
    () =>
      Effect.gen(function* () {
        const { exit, requests } = yield* transcribeWith([
          { status: 503, body: "busy" },
          { status: 500, body: "oops" },
          { status: 200, body: "third time" },
        ]);
        assert.deepStrictEqual(exit, Exit.succeed("third time"));
        assert.lengthOf(requests, 3);
        // Exactly 2 s apart on the TestClock, which starts at 0.
        assert.deepStrictEqual(
          requests.map((request) => request.sentAt),
          [0, 2_000, 4_000],
        );
      }),
  );

  it.effect(
    "dictation phase 1 AC3: a 5xx on every attempt fails after three requests with a readable reason",
    () =>
      Effect.gen(function* () {
        const { exit, requests } = yield* transcribeWith([{ status: 502, body: "bad gateway" }]);
        const reason = failureReason(exit);
        assert.deepStrictEqual(
          requests.map((request) => request.sentAt),
          [0, 2_000, 4_000],
        );
        assert.isAbove(reason.trim().length, 0);
        assert.include(reason, "502");
      }),
  );

  it.effect("dictation phase 1 AC3: a network failure is retried like a 5xx", () =>
    Effect.gen(function* () {
      const { exit, requests } = yield* transcribeWith([
        { transport: true },
        { status: 200, body: "after reconnect" },
      ]);
      assert.deepStrictEqual(exit, Exit.succeed("after reconnect"));
      assert.deepStrictEqual(
        requests.map((request) => request.sentAt),
        [0, 2_000],
      );
    }),
  );

  it.effect(
    "dictation phase 1 AC3: an attempt with no answer for 110 seconds times out and is retried",
    () =>
      Effect.gen(function* () {
        const { exit, requests } = yield* transcribeWith([
          { hang: true },
          { status: 200, body: "second attempt" },
        ]);
        assert.deepStrictEqual(exit, Exit.succeed("second attempt"));
        assert.lengthOf(requests, 2);
        // Timed out at exactly 110 s, then retried exactly 2 s later.
        assert.deepStrictEqual(
          requests.map((request) => request.sentAt),
          [0, 112_000],
        );
      }),
  );

  it.effect("dictation phase 1 AC3: a 401 fails at once with a readable reason", () =>
    Effect.gen(function* () {
      const { exit, requests } = yield* transcribeWith([
        { status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' },
      ]);
      const reason = failureReason(exit);
      assert.lengthOf(requests, 1);
      assert.include(reason, "401");
    }),
  );

  it.effect("dictation phase 1 AC3: a 429 fails at once with a readable reason", () =>
    Effect.gen(function* () {
      const { exit, requests } = yield* transcribeWith([
        { status: 429, body: '{"error":{"message":"Rate limit reached"}}' },
      ]);
      const reason = failureReason(exit);
      assert.lengthOf(requests, 1);
      assert.include(reason, "429");
    }),
  );

  it.effect("dictation phase 1 AC3: an empty 200 body fails at once as No speech detected", () =>
    Effect.gen(function* () {
      for (const body of ["", "  \n"]) {
        const { exit, requests } = yield* transcribeWith([{ status: 200, body }]);
        assert.strictEqual(failureReason(exit), "No speech detected");
        assert.lengthOf(requests, 1);
      }
    }),
  );
});

describe("openAiTranscription phase 4 fence", () => {
  it.effect(
    "dictation phase 4: T3CODE_DICTATION_OPENAI_URL redirects the transcription request, and the real OpenAI URL is the default",
    () =>
      Effect.gen(function* () {
        const stubUrl = "http://127.0.0.1:4010/v1/audio/transcriptions";
        const overridden = yield* transcribeWith([{ status: 200, body: "ok" }]).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { T3CODE_DICTATION_OPENAI_URL: stubUrl } }),
            ),
          ),
        );
        assert.lengthOf(overridden.requests, 1);
        assert.strictEqual(overridden.requests[0]!.url, stubUrl);

        const defaulted = yield* transcribeWith([{ status: 200, body: "ok" }]).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        );
        assert.strictEqual(
          defaulted.requests[0]!.url,
          "https://api.openai.com/v1/audio/transcriptions",
        );
        assert.strictEqual(
          OPENAI_TRANSCRIPTION_URL,
          "https://api.openai.com/v1/audio/transcriptions",
        );
      }),
  );
});
