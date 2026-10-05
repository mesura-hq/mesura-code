/**
 * Phase 1 fence of the dictation redesign: acceptance criteria 1, 2, 3, 4, 5
 * and 7 as a job runs.
 *
 * Entry point: `DictationJobs.layer`, the layer `server.ts` composes. Its
 * `start` and `retry` are what the `dictation.start` and `dictation.retry`
 * handlers in `ws.ts` call, and its `stream` is what `subscribeDictationJobs`
 * sends unchanged, so the events asserted here are the events a client
 * receives.
 *
 * Real pieces: `ServerSettings.layer` over the real secret store (the key and
 * the vocabulary hints are written through `updateSettings`, as a client
 * does), and the attachment store's directory (the audio is a file there, as
 * the signed `type: "file"` upload leaves it). OpenAI is an `HttpClient`
 * built with `HttpClient.make`; each request waits until the test answers it,
 * so every transition is observed in order without a sleep.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type DictationJob,
  type DictationJobEvent,
  DictationJobId,
  type DictationStartInput,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as DictationJobsModule from "./DictationJobs.ts";

const LANGUAGE_LINE = "The speaker primarily speaks English and Spanish.";
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7, 6, 5]);
const ATTACHMENT_ID = "pending-0b6f6c1e-4a1b-4c55-9d3e-7f2a1c9e8b10-webm";
const API_KEY = "sk-dictation-jobs-test";

interface OpenAiCall {
  readonly model: string | null;
  readonly temperature: string | null;
  readonly prompt: string | null;
  readonly hasLanguage: boolean;
  readonly authorization: string | undefined;
  readonly audio: Uint8Array | null;
  /** Completes the request with this status and body. */
  readonly answer: (status: number, body: string) => Effect.Effect<void>;
}

/** An OpenAI stand-in that hands each request to the test and waits for its answer. */
const makeFakeOpenAi = Effect.gen(function* () {
  const calls = yield* Queue.unbounded<OpenAiCall>();
  let count = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      count += 1;
      const form = request.body._tag === "FormData" ? request.body.formData : null;
      const file = form?.get("file");
      const audio =
        file && typeof file !== "string"
          ? new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))
          : null;
      const reply = yield* Deferred.make<{ status: number; body: string }>();
      const field = (name: string) => {
        const value = form?.get(name);
        return typeof value === "string" ? value : null;
      };
      yield* Queue.offer(calls, {
        model: field("model"),
        temperature: field("temperature"),
        prompt: field("prompt"),
        hasLanguage: form?.has("language") ?? false,
        authorization: request.headers.authorization,
        audio,
        answer: (status, body) => Deferred.succeed(reply, { status, body }).pipe(Effect.asVoid),
      });
      const { status, body } = yield* Deferred.await(reply);
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers: { "content-type": "text/plain" } }),
      );
    }),
  );
  return { calls, http, requestCount: () => count };
});

interface HarnessOptions {
  /** Written through `updateSettings`; omitted means no key is configured. */
  readonly dictation?: { readonly openAiApiKey: string; readonly vocabularyHints: string[] };
  /**
   * Holds every settings read the service makes until the test releases it,
   * so a test can act while an attempt is still loading its settings.
   */
  readonly gateSettingsReads?: boolean;
}

/** `DictationJobs.layer` over real settings and attachment storage, with OpenAI faked. */
const startDictationJobs = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "dictation-jobs-" });
    const openAi = yield* makeFakeOpenAi;

    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
    );
    const settingsReads = yield* Queue.unbounded<void>();
    const settingsReleases = yield* Queue.unbounded<void>();
    const gatedSettingsLayer = Layer.effect(
      ServerSettingsModule.ServerSettingsService,
      Effect.gen(function* () {
        const real = yield* ServerSettingsModule.ServerSettingsService;
        return ServerSettingsModule.ServerSettingsService.of({
          ...real,
          getSettings: Queue.offer(settingsReads, undefined).pipe(
            Effect.andThen(Queue.take(settingsReleases)),
            Effect.andThen(real.getSettings),
          ),
        });
      }),
    );
    const context = yield* Layer.build(
      DictationJobsModule.layer.pipe(
        options.gateSettingsReads ? Layer.provide(gatedSettingsLayer) : (layer) => layer,
        Layer.provideMerge(settingsLayer),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, openAi.http)),
      ),
    );

    const config = Context.get(context, ServerConfig.ServerConfig);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(path.join(config.attachmentsDir, `${ATTACHMENT_ID}.webm`), AUDIO);

    if (options.dictation) {
      const settings = Context.get(context, ServerSettingsModule.ServerSettingsService);
      yield* settings.updateSettings({ dictation: options.dictation });
    }

    return {
      jobs: Context.get(context, DictationJobsModule.DictationJobs),
      openAi,
      /** Waits until the service asks for its settings (gated harness only). */
      settingsRead: Queue.take(settingsReads),
      /** Lets one held settings read through (gated harness only). */
      releaseSettingsRead: Queue.offer(settingsReleases, undefined),
    };
  });

/** Subscribes the way the `subscribeDictationJobs` handler does and queues every event. */
const subscribeInto = (jobs: DictationJobsModule.DictationJobs["Service"]) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<DictationJobEvent, string>();
    // A subscription never ends while the server runs; if it does, the next
    // take fails instead of waiting forever.
    yield* jobs.stream.pipe(
      Stream.runForEach((event) => Queue.offer(received, event)),
      Effect.exit,
      Effect.flatMap((exit) =>
        Queue.fail(received, `the dictation job stream ended (${exit._tag})`),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return received;
  });

const takeSnapshot = (received: Queue.Queue<DictationJobEvent, string>) =>
  Effect.map(Queue.take(received), (event) => {
    assert.strictEqual(event.type, "snapshot", "the first event is the job list");
    return (event as Extract<DictationJobEvent, { type: "snapshot" }>).jobs;
  });

const takeUpsert = (received: Queue.Queue<DictationJobEvent, string>) =>
  Effect.map(Queue.take(received), (event): DictationJob => {
    assert.strictEqual(event.type, "upsert");
    return (event as Extract<DictationJobEvent, { type: "upsert" }>).job;
  });

const startInput = (
  jobId: string,
  overrides: Partial<DictationStartInput> = {},
): DictationStartInput => ({
  jobId: DictationJobId.make(jobId),
  attachmentId: ATTACHMENT_ID,
  durationMs: 30_000,
  mode: "submit",
  target: {
    kind: "thread",
    environmentId: EnvironmentId.make("environment-dictation"),
    threadId: ThreadId.make("thread-dictation"),
  },
  ...overrides,
});

const withKey = {
  dictation: { openAiApiKey: API_KEY, vocabularyHints: ["Mesura", "Hyprland"] },
} as const satisfies HarnessOptions;

it.layer(NodeServices.layer)("DictationJobs phase 1 fence", (it) => {
  it.effect(
    "dictation phase 1 AC1: starting a job sends the uploaded audio to gpt-4o-transcribe at temperature 0 with the bilingual prompt and the settings' hints",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs({
          dictation: { openAiApiKey: API_KEY, vocabularyHints: ["Mesura", "Hyprland"] },
        });
        yield* harness.jobs.start(startInput("job-ac1"));
        const call = yield* Queue.take(harness.openAi.calls);

        assert.strictEqual(call.authorization, `Bearer ${API_KEY}`);
        assert.strictEqual(call.model, "gpt-4o-transcribe");
        assert.strictEqual(call.temperature, "0");
        assert.isFalse(call.hasLanguage, "no language field is sent");
        assert.deepStrictEqual(call.audio, AUDIO);
        assert.include(call.prompt ?? "", LANGUAGE_LINE);
        assert.include(call.prompt ?? "", "Use these exact spellings: Mesura, Hyprland");
        yield* call.answer(200, "done");
      }),
  );

  it.effect(
    "dictation phase 1 AC2: a job for a recording longer than 420 seconds is sent to whisper-1",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs(withKey);
        yield* harness.jobs.start(startInput("job-ac2", { durationMs: 420_001 }));
        const call = yield* Queue.take(harness.openAi.calls);
        assert.strictEqual(call.model, "whisper-1");
        yield* call.answer(200, "done");
      }),
  );

  it.effect(
    "dictation phase 1 AC4: a subscriber receives the job list first, then transcribing, completed with text, and failed",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs(withKey);
        const received = yield* subscribeInto(harness.jobs);
        assert.deepStrictEqual(yield* takeSnapshot(received), []);

        yield* harness.jobs.start(startInput("job-ac4-completed", { mode: "inject" }));
        const transcribing = yield* takeUpsert(received);
        assert.strictEqual(transcribing.id, "job-ac4-completed");
        assert.strictEqual(transcribing.status, "transcribing");
        assert.strictEqual(transcribing.mode, "inject");
        assert.strictEqual(transcribing.durationMs, 30_000);
        assert.deepStrictEqual(transcribing.target, startInput("job").target);

        yield* (yield* Queue.take(harness.openAi.calls)).answer(200, "Hola, mundo.");
        const completed = yield* takeUpsert(received);
        assert.strictEqual(completed.id, "job-ac4-completed");
        assert.strictEqual(completed.status, "completed");
        assert.strictEqual(completed.text, "Hola, mundo.");
        assert.isString(completed.completedAt);

        yield* harness.jobs.start(startInput("job-ac4-failed"));
        assert.strictEqual((yield* takeUpsert(received)).status, "transcribing");
        yield* (yield* Queue.take(harness.openAi.calls)).answer(401, "invalid key");
        const failed = yield* takeUpsert(received);
        assert.strictEqual(failed.id, "job-ac4-failed");
        assert.strictEqual(failed.status, "failed");
        assert.isAbove(failed.failure?.trim().length ?? 0, 0);
        assert.isUndefined(failed.text);

        // A later subscriber starts from the current list.
        const late = yield* subscribeInto(harness.jobs);
        const snapshot = yield* takeSnapshot(late);
        assert.deepStrictEqual(snapshot.map((job) => [job.id, job.status]).toSorted(), [
          ["job-ac4-completed", "completed"],
          ["job-ac4-failed", "failed"],
        ]);
        assert.strictEqual(
          snapshot.find((job) => job.id === "job-ac4-completed")?.text,
          "Hola, mundo.",
        );
      }),
  );

  it.effect(
    "dictation phase 1 AC3: a job whose answer is an empty body ends failed as No speech detected",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs(withKey);
        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);
        yield* harness.jobs.start(startInput("job-ac3-empty"));
        yield* takeUpsert(received);
        yield* (yield* Queue.take(harness.openAi.calls)).answer(200, "");
        const failed = yield* takeUpsert(received);
        assert.strictEqual(failed.status, "failed");
        assert.strictEqual(failed.failure, "No speech detected");
        assert.strictEqual(harness.openAi.requestCount(), 1);
      }),
  );

  it.effect(
    "dictation phase 1 AC5: retrying a failed job resends the stored audio under the same job id",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs(withKey);
        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);

        const jobId = DictationJobId.make("job-ac5");
        yield* harness.jobs.start(startInput(jobId));
        yield* takeUpsert(received);
        yield* (yield* Queue.take(harness.openAi.calls)).answer(429, "slow down");
        assert.strictEqual((yield* takeUpsert(received)).status, "failed");

        yield* harness.jobs.retry(jobId);
        const again = yield* takeUpsert(received);
        assert.strictEqual(again.id, jobId);
        assert.strictEqual(again.status, "transcribing");
        assert.isUndefined(again.failure);

        const second = yield* Queue.take(harness.openAi.calls);
        assert.deepStrictEqual(second.audio, AUDIO);
        yield* second.answer(200, "second attempt");
        const completed = yield* takeUpsert(received);
        assert.strictEqual(completed.id, jobId);
        assert.strictEqual(completed.status, "completed");
        assert.strictEqual(completed.text, "second attempt");
        assert.strictEqual(harness.openAi.requestCount(), 2);

        const snapshot = yield* takeSnapshot(yield* subscribeInto(harness.jobs));
        assert.deepStrictEqual(
          snapshot.map((job) => job.id),
          [jobId],
        );
      }),
  );

  it.effect(
    "dictation phase 1 AC7: a job started with no OpenAI key fails at once naming the missing key",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs();
        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);

        yield* harness.jobs.start(startInput("job-ac7"));
        const job = yield* takeUpsert(received);
        assert.strictEqual(job.id, "job-ac7");
        assert.strictEqual(job.status, "failed");
        assert.match(job.failure ?? "", /OpenAI API key/i);
        assert.strictEqual(harness.openAi.requestCount(), 0);
      }),
  );
  it.effect(
    "dictation phase 1 regression: a start interrupted while its settings load still transcribes to completion",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs({ ...withKey, gateSettingsReads: true });
        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);

        const request = yield* Effect.forkChild(harness.jobs.start(startInput("job-interrupted")));
        yield* harness.settingsRead;
        // The client disconnects: its RPC fiber is interrupted mid-launch.
        yield* Fiber.interrupt(request);
        yield* harness.releaseSettingsRead;

        assert.strictEqual((yield* takeUpsert(received)).status, "transcribing");
        yield* (yield* Queue.take(harness.openAi.calls)).answer(200, "still here");
        const completed = yield* takeUpsert(received);
        assert.strictEqual(completed.id, "job-interrupted");
        assert.strictEqual(completed.status, "completed");
        assert.strictEqual(completed.text, "still here");
      }),
  );

  it.effect(
    "dictation phase 1 regression: a retry interrupted while its settings load still transcribes to completion",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs({ ...withKey, gateSettingsReads: true });
        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);
        const jobId = DictationJobId.make("job-retry-interrupted");

        yield* harness.releaseSettingsRead;
        yield* harness.jobs.start(startInput(jobId));
        yield* takeUpsert(received);
        yield* (yield* Queue.take(harness.openAi.calls)).answer(401, "invalid key");
        assert.strictEqual((yield* takeUpsert(received)).status, "failed");

        const request = yield* Effect.forkChild(harness.jobs.retry(jobId));
        yield* harness.settingsRead;
        yield* harness.settingsRead;
        yield* Fiber.interrupt(request);
        yield* harness.releaseSettingsRead;

        assert.strictEqual((yield* takeUpsert(received)).status, "transcribing");
        yield* (yield* Queue.take(harness.openAi.calls)).answer(200, "second try");
        const completed = yield* takeUpsert(received);
        assert.strictEqual(completed.status, "completed");
        assert.strictEqual(completed.text, "second try");
      }),
  );

  it.effect(
    "dictation phase 1 regression: cancelling a job while its settings load ends it and sends no audio",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs({ ...withKey, gateSettingsReads: true });
        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);

        const request = yield* Effect.forkChild(harness.jobs.start(startInput("job-cancel-early")));
        yield* harness.settingsRead;
        assert.isTrue(yield* harness.jobs.cancel(DictationJobId.make("job-cancel-early")));

        const cancelled = yield* takeUpsert(received);
        assert.strictEqual(cancelled.status, "failed");
        assert.strictEqual(cancelled.failure, "Cancelled.");
        yield* harness.releaseSettingsRead;
        assert.strictEqual((yield* Fiber.join(request)).status, "failed");
        assert.strictEqual(harness.openAi.requestCount(), 0);
        assert.isFalse(yield* harness.jobs.cancel(DictationJobId.make("job-cancel-early")));
      }),
  );

  it.effect(
    "dictation phase 1 regression: a mode set while settings load is the mode every later event carries",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs({ ...withKey, gateSettingsReads: true });
        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);
        const jobId = DictationJobId.make("job-mode-early");

        yield* Effect.forkChild(harness.jobs.start(startInput(jobId, { mode: "submit" })));
        yield* harness.settingsRead;
        yield* harness.jobs.setMode(jobId, "clipboard");
        assert.strictEqual((yield* takeUpsert(received)).mode, "clipboard");
        yield* harness.releaseSettingsRead;

        const launched = yield* takeUpsert(received);
        assert.strictEqual(launched.status, "transcribing");
        assert.strictEqual(launched.mode, "clipboard");
        yield* (yield* Queue.take(harness.openAi.calls)).answer(200, "done");
        assert.strictEqual((yield* takeUpsert(received)).mode, "clipboard");
        const snapshot = yield* takeSnapshot(yield* subscribeInto(harness.jobs));
        assert.strictEqual(snapshot[0]?.mode, "clipboard");
      }),
  );

  it.effect(
    "dictation phase 1 regression: a start beyond the transcribing limit ends failed without reading audio, and can be retried",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs(withKey);
        for (let index = 0; index < DictationJobsModule.MAX_ACTIVE_JOBS; index += 1) {
          yield* harness.jobs.start(startInput(`job-capacity-${index}`));
        }
        const calls = [];
        for (let index = 0; index < DictationJobsModule.MAX_ACTIVE_JOBS; index += 1) {
          calls.push(yield* Queue.take(harness.openAi.calls));
        }

        const received = yield* subscribeInto(harness.jobs);
        yield* takeSnapshot(received);
        const overflowId = DictationJobId.make("job-capacity-overflow");
        const rejected = yield* harness.jobs.start(startInput(overflowId));
        assert.strictEqual(rejected.status, "failed");
        assert.strictEqual(rejected.failure, DictationJobsModule.CAPACITY_FAILURE);
        assert.strictEqual(harness.openAi.requestCount(), DictationJobsModule.MAX_ACTIVE_JOBS);

        yield* calls[0]!.answer(200, "first done");
        while ((yield* takeUpsert(received)).status !== "completed") {
          // The overflow job's failure arrives first.
        }
        const retried = yield* harness.jobs.retry(overflowId);
        assert.strictEqual(retried.status, "transcribing");
        yield* (yield* Queue.take(harness.openAi.calls)).answer(200, "overflow done");
        assert.strictEqual(harness.openAi.requestCount(), DictationJobsModule.MAX_ACTIVE_JOBS + 1);
      }),
  );

  it.effect(
    "dictation phase 1 regression: an idle server forgets jobs after 24 hours and subscribers get the new list",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs(withKey);
        yield* harness.jobs.start(startInput("job-expires"));
        yield* (yield* Queue.take(harness.openAi.calls)).answer(200, "old news");
        const received = yield* subscribeInto(harness.jobs);
        const before = yield* takeSnapshot(received);
        assert.deepStrictEqual(
          before.map((job) => job.status),
          ["completed"],
        );

        yield* TestClock.adjust("25 hours");
        yield* TestClock.adjust("10 minutes");
        assert.deepStrictEqual(yield* takeSnapshot(received), []);
        assert.deepStrictEqual(yield* takeSnapshot(yield* subscribeInto(harness.jobs)), []);
      }),
  );

  it.effect(
    "dictation phase 1 regression: a subscriber that stops reading holds a bounded backlog and still ends on the latest state",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs();
        const jobId = DictationJobId.make("job-backlog");
        yield* harness.jobs.start(startInput(jobId));

        const received = yield* Queue.unbounded<DictationJobEvent>();
        const gate = yield* Deferred.make<void>();
        yield* harness.jobs.stream.pipe(
          Stream.runForEach((event) =>
            Queue.offer(received, event).pipe(
              Effect.andThen(event.type === "snapshot" ? Deferred.await(gate) : Effect.void),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        assert.strictEqual((yield* Queue.take(received)).type, "snapshot");

        for (let index = 0; index < 5_000; index += 1) {
          yield* harness.jobs.setMode(jobId, index % 2 === 0 ? "inject" : "submit");
        }
        yield* harness.jobs.setMode(jobId, "clipboard");
        yield* Deferred.succeed(gate, undefined);

        let delivered = 0;
        for (;;) {
          const event = yield* Queue.take(received);
          delivered += 1;
          if (event.type === "upsert" && event.job.mode === "clipboard") break;
        }
        assert.isAtMost(delivered, 32);
      }),
  );

  it.effect(
    "dictation phase 1 regression: a subscribed list stays equal to a fresh snapshot when jobs past the cap are evicted",
    () =>
      Effect.gen(function* () {
        const harness = yield* startDictationJobs();
        const received = yield* subscribeInto(harness.jobs);
        const reduced = new Map<string, DictationJob>();
        const apply = (event: DictationJobEvent) => {
          if (event.type === "snapshot") {
            reduced.clear();
            for (const job of event.jobs) reduced.set(job.id, job);
          } else {
            reduced.set(event.job.id, event.job);
          }
        };
        apply(yield* Queue.take(received));

        const total = DictationJobsModule.MAX_KEPT_JOBS + 5;
        for (let index = 0; index < total; index += 1) {
          yield* harness.jobs.start(startInput(`job-evict-${index}`));
        }
        // A last change marks the end of what the subscriber must catch up on.
        const lastId = DictationJobId.make(`job-evict-${total - 1}`);
        yield* harness.jobs.setMode(lastId, "clipboard");
        for (;;) {
          const event = yield* Queue.take(received);
          apply(event);
          if (
            event.type === "upsert" &&
            event.job.id === lastId &&
            event.job.mode === "clipboard"
          ) {
            break;
          }
        }

        const fresh = yield* takeSnapshot(yield* subscribeInto(harness.jobs));
        assert.lengthOf(fresh, DictationJobsModule.MAX_KEPT_JOBS);
        assert.deepStrictEqual(
          [...reduced.keys()].toSorted(),
          fresh.map((job) => job.id).toSorted(),
        );
        assert.isFalse(reduced.has("job-evict-0"));
      }),
  );
});
