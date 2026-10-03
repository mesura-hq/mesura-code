import type {
  DictationJob,
  DictationJobEvent,
  DictationJobId,
  DictationMode,
  DictationStartInput,
} from "@t3tools/contracts";
import { DictationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeOpenAiTranscription, OpenAiTranscriptionError } from "./openAiTranscription.ts";

/**
 * Transcribes uploaded recordings with the environment's OpenAI key and keeps
 * the last day of jobs in memory, so every client can follow and fill them.
 */
export class DictationJobs extends Context.Service<
  DictationJobs,
  {
    /**
     * Starts a job and returns it once its first state is published: transcribing,
     * or failed when it cannot run. Transcription continues in the background,
     * even if the caller goes away. Starting an id that already exists returns
     * that job, so a client may resend after a reconnect.
     */
    readonly start: (input: DictationStartInput) => Effect.Effect<DictationJob>;
    /** Starts a new attempt of a failed job from its stored audio. */
    readonly retry: (jobId: DictationJobId) => Effect.Effect<DictationJob, DictationError>;
    /** Stops a transcribing job, which ends failed. False when nothing was transcribing. */
    readonly cancel: (jobId: DictationJobId) => Effect.Effect<boolean>;
    readonly setMode: (
      jobId: DictationJobId,
      mode: DictationMode,
    ) => Effect.Effect<DictationJob, DictationError>;
    /**
     * Emits a snapshot of every kept job, newest first, then one upsert per
     * change. A later snapshot replaces the list, after jobs expire.
     */
    readonly stream: Stream.Stream<DictationJobEvent>;
  }
>()("t3/dictation/DictationJobs") {}

/** Uploaded audio is swept after 24 h, so a job older than that could not be retried anyway. */
export const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_KEPT_JOBS = 100;
/**
 * Attempts in flight, each holding its audio in memory and one OpenAI request
 * open. Below `MAX_KEPT_JOBS`, so a job refused here is kept like any other.
 */
export const MAX_ACTIVE_JOBS = 20;
const EXPIRY_SWEEP_INTERVAL = "10 minutes";
/** Events a subscriber may have in flight before the server waits for it. */
const SUBSCRIBER_BUFFER = 16;

const MISSING_KEY_FAILURE =
  "No OpenAI API key is configured. Add the OpenAI API key in Settings → Dictation.";
const MISSING_AUDIO_FAILURE = "The recording is no longer on the server.";
const CANCELLED_FAILURE = "Cancelled.";
const SETTINGS_UNREADABLE_FAILURE = "The server could not read its dictation settings.";
export const CAPACITY_FAILURE = `Too many recordings are transcribing (${MAX_ACTIVE_JOBS}). Retry when one finishes.`;

interface TrackedJob {
  readonly job: DictationJob;
  readonly attachmentId: string;
  /** Increments per attempt, so a finished attempt never overwrites a newer one. */
  readonly attempt: number;
  /** The running attempt, from the settings read to the OpenAI answer. */
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
}

/**
 * What one subscriber has not received yet. Upserts coalesce per job, so a
 * stalled client holds at most one pending event per kept job; a pending
 * snapshot supersedes them all and is read when it is sent.
 */
interface Subscriber {
  snapshotPending: boolean;
  readonly pending: Map<DictationJobId, DictationJob>;
  readonly wake: Queue.Queue<void>;
}

/** A job to hand to a new attempt, or the job to return as it is. */
type Claim =
  | { readonly kind: "launch"; readonly tracked: TrackedJob }
  | { readonly kind: "settled"; readonly job: DictationJob };

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

const isTranscribing = (job: DictationJob) => job.status === "transcribing";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const openAi = yield* makeOpenAiTranscription;

  // Plain state, changed only inside synchronous blocks: a change and its
  // notification happen together, so subscribers see changes in the order
  // they were made. Insertion order is creation order.
  const jobs = new Map<DictationJobId, TrackedJob>();
  const subscribers = new Set<Subscriber>();
  // Transcriptions outlive the RPC that started them but not the server.
  const jobScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(jobScope, Exit.void));

  const listJobs = () => Array.from(jobs.values(), (tracked) => tracked.job).toReversed();

  const notifyUnsafe = (job: DictationJob) => {
    for (const subscriber of subscribers) {
      // Re-inserted so the pending order follows the order of the latest changes.
      subscriber.pending.delete(job.id);
      subscriber.pending.set(job.id, job);
      Queue.offerUnsafe(subscriber.wake, undefined);
    }
  };

  const notifySnapshotUnsafe = () => {
    for (const subscriber of subscribers) {
      subscriber.snapshotPending = true;
      subscriber.pending.clear();
      Queue.offerUnsafe(subscriber.wake, undefined);
    }
  };

  const setUnsafe = (tracked: TrackedJob) => {
    jobs.set(tracked.job.id, tracked);
    notifyUnsafe(tracked.job);
  };

  /**
   * Drops finished jobs past the retention window, then, past the cap, the
   * ones that finished longest ago. Never `keep`, the job just changed, so a
   * fresh result is delivered before it can go. Subscribers get a fresh
   * snapshot when anything went.
   */
  const pruneUnsafe = (nowMs: number, keep?: DictationJobId) => {
    const sizeBefore = jobs.size;
    for (const [id, tracked] of jobs) {
      if (
        !isTranscribing(tracked.job) &&
        id !== keep &&
        nowMs - Date.parse(tracked.job.createdAt) > JOB_RETENTION_MS
      ) {
        jobs.delete(id);
      }
    }
    if (jobs.size > MAX_KEPT_JOBS) {
      const finished = Array.from(jobs.values(), (tracked) => tracked.job)
        .filter((job) => !isTranscribing(job) && job.id !== keep)
        .toSorted((a, b) =>
          (a.completedAt ?? a.createdAt).localeCompare(b.completedAt ?? b.createdAt),
        );
      for (const job of finished.slice(0, jobs.size - MAX_KEPT_JOBS)) jobs.delete(job.id);
    }
    if (jobs.size !== sizeBefore) notifySnapshotUnsafe();
  };

  const prune = Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
    Effect.sync(() => pruneUnsafe(nowMs)),
  );

  const activeCountUnsafe = () => {
    let count = 0;
    for (const tracked of jobs.values()) if (isTranscribing(tracked.job)) count += 1;
    return count;
  };

  /** Ends the attempt, unless a newer attempt or a cancel already ended it. */
  const finishAttempt = (jobId: DictationJobId, attempt: number, outcome: Partial<DictationJob>) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const completedAt = isoAt(nowMs);
      yield* Effect.sync(() => {
        const tracked = jobs.get(jobId);
        if (!tracked || tracked.attempt !== attempt || !isTranscribing(tracked.job)) return;
        setUnsafe({ ...tracked, fiber: null, job: { ...tracked.job, ...outcome, completedAt } });
        pruneUnsafe(nowMs, jobId);
      });
    });

  const readAudio = (attachmentId: string) =>
    Effect.gen(function* () {
      const audioPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
      });
      if (!audioPath) {
        return yield* new OpenAiTranscriptionError({
          reason: MISSING_AUDIO_FAILURE,
          retryable: false,
        });
      }
      const audio = yield* fs
        .readFile(audioPath)
        .pipe(
          Effect.mapError(
            () => new OpenAiTranscriptionError({ reason: MISSING_AUDIO_FAILURE, retryable: false }),
          ),
        );
      return { audio, fileName: path.basename(audioPath) };
    });

  /**
   * One attempt, run in `jobScope`: read the settings, publish the job's
   * first state, then transcribe. `published` completes once the first state
   * is out, whatever happens. A missing key ends the job here, so a client
   * never sees a job transcribing that cannot run.
   */
  const runAttempt = (
    jobId: DictationJobId,
    attempt: number,
    published: Deferred.Deferred<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const read = yield* settings.getSettings.pipe(
        Effect.map((value) => value.dictation),
        Effect.exit,
      );
      const nowMs = yield* Clock.currentTimeMillis;
      const plan = yield* Effect.sync(() => {
        const tracked = jobs.get(jobId);
        // Cancelled, or replaced by a newer attempt, while settings loaded.
        if (!tracked || tracked.attempt !== attempt || !isTranscribing(tracked.job)) return null;
        if (Exit.isFailure(read) || read.value.openAiApiKey.length === 0) {
          const failure = Exit.isFailure(read) ? SETTINGS_UNREADABLE_FAILURE : MISSING_KEY_FAILURE;
          const completedAt = isoAt(nowMs);
          setUnsafe({
            ...tracked,
            fiber: null,
            job: { ...tracked.job, status: "failed", failure, completedAt },
          });
          return null;
        }
        // The stored job, not a captured copy: a mode set meanwhile must stand.
        notifyUnsafe(tracked.job);
        return {
          attachmentId: tracked.attachmentId,
          durationMs: tracked.job.durationMs,
          ...read.value,
        };
      });
      yield* Deferred.succeed(published, undefined);
      if (!plan) return null;
      const { audio, fileName } = yield* readAudio(plan.attachmentId);
      return yield* openAi.transcribe({
        apiKey: plan.openAiApiKey,
        audio,
        fileName,
        durationMs: plan.durationMs,
        vocabularyHints: plan.vocabularyHints,
      });
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? exit.value === null
            ? Effect.void
            : finishAttempt(jobId, attempt, { status: "completed", text: exit.value })
          : finishAttempt(jobId, attempt, {
              status: "failed",
              failure: Cause.hasInterruptsOnly(exit.cause)
                ? CANCELLED_FAILURE
                : describeFailure(exit.cause),
            }),
      ),
      Effect.ensuring(Deferred.succeed(published, undefined)),
      Effect.ignoreCause(),
    );

  /**
   * Hands an attempt the job `claim` stored to a fiber in `jobScope`. Claim,
   * fork and the fiber's registration cannot be interrupted, so a client that
   * disconnects mid-request never strands a job transcribing with no attempt.
   * Waiting for the first state can be interrupted; the attempt carries on.
   */
  const launch = <E>(claim: (nowMs: number) => Effect.Effect<Claim, E>) =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const claimed = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const outcome = yield* claim(nowMs);
          if (outcome.kind === "settled") return outcome;
          const { tracked } = outcome;
          const fiber = yield* runAttempt(tracked.job.id, tracked.attempt, published).pipe(
            Effect.forkIn(jobScope),
          );
          yield* Effect.sync(() => {
            const current = jobs.get(tracked.job.id);
            if (current?.attempt === tracked.attempt && isTranscribing(current.job)) {
              jobs.set(tracked.job.id, { ...current, fiber });
            }
          });
          return outcome;
        }),
      );
      if (claimed.kind === "settled") return claimed.job;
      yield* Deferred.await(published);
      return jobs.get(claimed.tracked.job.id)?.job ?? claimed.tracked.job;
    });

  const start: DictationJobs["Service"]["start"] = Effect.fn("DictationJobs.start")(
    function* (input) {
      return yield* launch((nowMs) =>
        Effect.sync((): Claim => {
          const known = jobs.get(input.jobId);
          if (known) return { kind: "settled", job: known.job };
          const createdAt = isoAt(nowMs);
          const job: DictationJob = {
            id: input.jobId,
            target: input.target,
            mode: input.mode,
            status: "transcribing",
            durationMs: input.durationMs,
            createdAt,
          };
          const tracked = { job, attachmentId: input.attachmentId, attempt: 1, fiber: null };
          if (activeCountUnsafe() >= MAX_ACTIVE_JOBS) {
            // Kept as failed so it can be retried; no audio is read for it.
            const rejected: DictationJob = {
              ...job,
              status: "failed",
              failure: CAPACITY_FAILURE,
              completedAt: createdAt,
            };
            setUnsafe({ ...tracked, job: rejected });
            pruneUnsafe(nowMs, input.jobId);
            return { kind: "settled", job: rejected };
          }
          // Published by the attempt once it knows whether the job can run.
          jobs.set(input.jobId, tracked);
          pruneUnsafe(nowMs, input.jobId);
          return { kind: "launch", tracked };
        }),
      );
    },
  );

  const retry: DictationJobs["Service"]["retry"] = Effect.fn("DictationJobs.retry")(
    function* (jobId) {
      return yield* launch(() =>
        Effect.suspend((): Effect.Effect<Claim, DictationError> => {
          const existing = jobs.get(jobId);
          if (!existing || existing.job.status !== "failed") {
            return Effect.fail(
              new DictationError({ detail: `No failed dictation job ${jobId} to retry.` }),
            );
          }
          if (activeCountUnsafe() >= MAX_ACTIVE_JOBS) {
            return Effect.fail(new DictationError({ detail: CAPACITY_FAILURE }));
          }
          const {
            failure: _failure,
            text: _text,
            completedAt: _completedAt,
            ...job
          } = existing.job;
          const next: TrackedJob = {
            ...existing,
            attempt: existing.attempt + 1,
            fiber: null,
            job: { ...job, status: "transcribing" },
          };
          // Published by the attempt, like a start.
          jobs.set(jobId, next);
          return Effect.succeed({ kind: "launch", tracked: next });
        }),
      );
    },
  );

  const cancel: DictationJobs["Service"]["cancel"] = (jobId) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.sync(() => {
        const tracked = jobs.get(jobId);
        if (!tracked || !isTranscribing(tracked.job)) return undefined;
        return tracked.fiber;
      });
      if (fiber === undefined) return false;
      // A running attempt records its own "Cancelled." failure as it stops. A
      // claimed job whose fiber is not registered yet is ended here; its
      // attempt then finds it no longer transcribing and does nothing.
      if (fiber) yield* Fiber.interrupt(fiber);
      else yield* finishAttempt(jobId, jobs.get(jobId)!.attempt, cancelledOutcome);
      return true;
    });

  const setMode: DictationJobs["Service"]["setMode"] = Effect.fn("DictationJobs.setMode")(
    function* (jobId, mode) {
      const job = yield* Effect.sync(() => {
        const tracked = jobs.get(jobId);
        if (!tracked) return null;
        if (tracked.job.mode !== mode) setUnsafe({ ...tracked, job: { ...tracked.job, mode } });
        return jobs.get(jobId)!.job;
      });
      if (!job) return yield* new DictationError({ detail: `No dictation job ${jobId}.` });
      return job;
    },
  );

  // Expiry runs while the server is idle too, not only when a job starts.
  yield* prune.pipe(Effect.delay(EXPIRY_SWEEP_INTERVAL), Effect.forever, Effect.forkIn(jobScope));

  /**
   * Bounded and lossless for the final state: the mailbox holds a few events
   * and waits for the client; behind it, `pending` holds the latest state of
   * each changed job.
   */
  const stream: DictationJobs["Service"]["stream"] = Stream.callback<DictationJobEvent>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscriber: Subscriber = {
          snapshotPending: true,
          pending: new Map(),
          wake: yield* Queue.dropping<void>(1),
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            subscribers.add(subscriber);
            Queue.offerUnsafe(subscriber.wake, undefined);
          }),
          () => Effect.sync(() => subscribers.delete(subscriber)),
        );
        const drain = Effect.gen(function* () {
          yield* Queue.take(subscriber.wake);
          if (subscriber.snapshotPending) {
            yield* prune;
            const events = yield* Effect.sync(() => {
              subscriber.snapshotPending = false;
              subscriber.pending.clear();
              return [{ type: "snapshot", jobs: listJobs() } as const];
            });
            for (const event of events) yield* Queue.offer(mailbox, event);
          }
          const upserts = yield* Effect.sync(() => {
            const jobsToSend = Array.from(subscriber.pending.values());
            subscriber.pending.clear();
            return jobsToSend;
          });
          for (const job of upserts) yield* Queue.offer(mailbox, { type: "upsert", job });
        });
        yield* drain.pipe(Effect.forever, Effect.forkScoped);
      }),
    { bufferSize: SUBSCRIBER_BUFFER, strategy: "suspend" },
  );

  return DictationJobs.of({ start, retry, cancel, setMode, stream });
});

const cancelledOutcome: Partial<DictationJob> = { status: "failed", failure: CANCELLED_FAILURE };

function describeFailure(cause: Cause.Cause<OpenAiTranscriptionError>): string {
  const failure = cause.reasons.find(Cause.isFailReason);
  return failure ? failure.error.reason : "Transcription failed unexpectedly.";
}

export const layer = Layer.effect(DictationJobs, make);
