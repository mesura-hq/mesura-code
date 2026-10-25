/**
 * FactoryRunTracker - follows the Software Factory runs attached to threads.
 *
 * A run directory is the source of the run's state: the coordinator appends one
 * event per step to `<runDir>/events.jsonl`, and this service tails it, folds it
 * with `@t3tools/shared/factoryRun`, and publishes two widths of the result:
 *
 * - the thin one reaches every client: a run card (a `factory_card` turn item)
 *   replaced in place when its compact summary changes, a report card when the
 *   report is written, and the thread shell's `factoryRun` label;
 * - the wide one reaches only an open Factory pane: `stream` sends the full state
 *   plus live per-role progress read from the role output files, which are tailed
 *   only while a pane subscribes.
 *
 * @module FactoryRunTracker
 */
import {
  CommandId,
  FactoryRunActivityPayload,
  factoryReportActivityId,
  factoryRunActivityId,
  isFactoryRunFinished,
  type FactoryReportActivityPayload,
  type FactoryRoleProgress,
  type FactoryRunShellSummary,
  type FactoryRunState,
  type FactoryRunStreamItem,
  type FactorySubscribeRunInput,
  type FactoryThreadCard,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import {
  emptyFactoryRunState,
  foldFactoryRunLine,
  summarizeFactoryRun,
  toFactoryRunShellSummary,
} from "@t3tools/shared/factoryRun";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as FactoryCardQuery from "../orchestration-v2/FactoryCardQuery.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  makeAppendOnlyFileTail,
  watchAppendOnlyFile,
  type AppendOnlyFileTail,
} from "./appendOnlyFileTail.ts";
import { FactoryRunShellSummaries } from "./FactoryRunShellSummaries.ts";
import { FACTORY_SNAPSHOT_MAX_BYTES, FactorySnapshotStore } from "./FactorySnapshotStore.ts";
import {
  emptyRoleOutputProgress,
  foldRoleOutputLine,
  type RoleOutputProgress,
} from "./roleOutputProgress.ts";

export type { FactoryRunStreamItem } from "@t3tools/contracts";

export const FACTORY_RUN_EVENTS_FILE = "events.jsonl";

/** A pane gets at most one snapshot a second, however fast the run writes. */
const STREAM_MIN_INTERVAL = Duration.seconds(1);

export class FactoryAttachRunError extends Schema.TaggedError<FactoryAttachRunError>()(
  "FactoryAttachRunError",
  {
    reason: Schema.Literals(["relative-path", "not-found", "not-directory", "read-failed"]),
    runDir: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "relative-path":
        return `${this.runDir} is not an absolute path. Pass the run directory's absolute path.`;
      case "not-found":
        return `${this.runDir} was not found.`;
      case "not-directory":
        return `${this.runDir} is not a directory.`;
      case "read-failed":
        return `${this.runDir} could not be read.`;
    }
  }
}

export class FactoryRunTracker extends Context.Service<
  FactoryRunTracker,
  {
    /**
     * Follows `<runDir>/events.jsonl` for a thread from its first line and
     * records its run card at once, even before the file exists.
     * The run id is the directory's name in every case: sf-team names the run
     * directory after the run, and a key fixed at attach survives a restart and a
     * `run.started` written later. Attaching a run already followed returns its id.
     */
    readonly attach: (
      threadId: ThreadId,
      runDir: string,
      options?: {
        /**
         * The run card payload already recorded for this run, when a restart
         * re-attaches it: an unchanged summary is then not dispatched again.
         */
        readonly recorded?: FactoryRunActivityPayload;
      },
    ) => Effect.Effect<{ readonly runId: string }, FactoryAttachRunError>;
    readonly isAttached: (threadId: ThreadId, runId: string) => Effect.Effect<boolean>;
    /** Folds every complete line already written to the run's events and role outputs. */
    readonly drain: (threadId: ThreadId, runId: string) => Effect.Effect<void>;
    /**
     * The full state and live role progress: the current snapshot first, then at
     * most one a second. Ends at once for a run that is not attached.
     */
    readonly stream: (threadId: ThreadId, runId: string) => Stream.Stream<FactoryRunStreamItem>;
    /** Every file this tracker is tailing now, events files first. */
    readonly tailedFiles: Effect.Effect<ReadonlyArray<string>>;
    /**
     * After a restart, follows again every recorded run that was not finished,
     * from the run directory in its run card, archived threads included. A
     * finished run is not followed: its thread label is restored from the card.
     */
    readonly reattachRecordedRuns: Effect.Effect<void>;
    /**
     * Follows a run nobody follows now, such as a finished run after a restart,
     * from the run directory its card records. Does nothing without a card.
     */
    readonly attachRecorded: (threadId: ThreadId, runId: string) => Effect.Effect<void>;
  }
>()("t3/factory/FactoryRunTracker") {}

/**
 * A role's output as read so far. The offset and the counters outlive a pane:
 * only the watch closes when the last subscriber leaves, so the next pane reads
 * from where the last one stopped.
 */
interface RoleTail {
  readonly tail: AppendOnlyFileTail;
  /** The tail's, open while the role is in the current phase, so its offset survives a closed pane. */
  readonly tailScope: Scope.Closeable;
  /** The watch, open only while a pane subscribes. */
  scope: Scope.Closeable | null;
  progress: RoleOutputProgress;
}

interface TrackedRun {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly runDir: string;
  /** The directory's name, fixed at attach: the card ids derive from it. */
  readonly runId: string;
  readonly eventsTail: AppendOnlyFileTail;
  readonly lock: Semaphore.Semaphore;
  state: FactoryRunState;
  /** Bumped on every visible change, so a subscriber never sends the same snapshot twice. */
  version: number;
  followScope: Scope.Closeable | null;
  dispatchedSummary: string | null;
  recordedReport: string | null;
  subscribers: number;
  /** Keyed by output file; only the current phase's dispatches. */
  readonly roleTails: Map<string, RoleTail>;
}

const encodeRunPayload = Schema.encodeSync(Schema.fromJsonString(FactoryRunActivityPayload));

const reportKey = (report: FactoryRunState["report"]) =>
  report === null ? null : `${report.path}\u0000${report.at}`;

const runKey = (threadId: string, runId: string) => `${threadId}\u0000${runId}`;

function currentDispatches(state: FactoryRunState) {
  const phase = state.phases.find((candidate) => candidate.index === state.currentPhase);
  return phase === undefined
    ? []
    : phase.dispatches.map((dispatch) => ({ phase: phase.index, ...dispatch }));
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const cards = yield* FactoryCardQuery.FactoryCardQuery;
  const snapshots = yield* FactorySnapshotStore;
  const shellSummaries = yield* FactoryRunShellSummaries;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const trackerScope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<string>();

  // Finished runs without a subscriber are dropped; a pane rebuilds one from its record.
  const runs = new Map<string, TrackedRun>();
  // Attaches are serialized, so one run is never followed twice.
  const attachLock = yield* Semaphore.make(1);

  const commandId = (threadId: ThreadId, kind: "factory-run" | "factory-report") =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${kind}:${threadId}:${uuid}`)),
    );

  /** Records or updates a card on the thread: the orchestrator upserts it by its turn item id. */
  const recordCard = Effect.fn("FactoryRunTracker.recordCard")(function* (
    threadId: ThreadId,
    kind: "factory-run" | "factory-report",
    turnItemId: string,
    card: FactoryThreadCard,
  ) {
    yield* orchestrator.dispatch({
      type: "factory_card.record",
      commandId: yield* commandId(threadId, kind),
      threadId,
      turnItemId: TurnItemId.make(turnItemId),
      card,
    });
  });

  /** Snapshots the report by digest and records its card: the headings, never the body. */
  const recordReport = Effect.fn("FactoryRunTracker.recordReport")(function* (
    run: TrackedRun,
    report: { readonly path: string; readonly at: string },
  ) {
    const reportPath = path.resolve(run.runDir, report.path);
    const info = yield* fileSystem.stat(reportPath);
    if (info.type !== "File" || Number(info.size) > FACTORY_SNAPSHOT_MAX_BYTES) {
      return yield* Effect.logWarning("factory run report is not a file of at most 1 MiB", {
        runDir: run.runDir,
        reportPath,
      });
    }
    const bytes = yield* fileSystem.readFile(reportPath);
    const digest = yield* snapshots.put(bytes);
    const document = splitFactoryDocument(new TextDecoder().decode(bytes));
    const payload: FactoryReportActivityPayload = {
      runId: run.runId,
      digest,
      path: reportPath,
      title: document.title,
      headings: document.sections.map((section) => section.heading),
      writtenAt: report.at,
    };
    yield* recordCard(
      run.threadId,
      "factory-report",
      factoryReportActivityId(run.threadId, run.runId),
      { kind: "report", payload },
    );
  });

  /**
   * Carries a new fold to the thin path. The shell label is updated BEFORE the
   * card is recorded: the shell stream refetches a thread's shell on its next
   * event, and that event is this card's `turn-item.updated`.
   */
  const publishToThread = Effect.fn("FactoryRunTracker.publishToThread")(
    function* (run: TrackedRun) {
      const state = run.state;
      shellSummaries.set(run.threadId, toFactoryRunShellSummary(state));

      const payload: FactoryRunActivityPayload = {
        threadId: run.threadId,
        ...summarizeFactoryRun(state),
        runId: run.runId,
      };
      const encoded = encodeRunPayload(payload);
      if (encoded !== run.dispatchedSummary) {
        yield* recordCard(
          run.threadId,
          "factory-run",
          factoryRunActivityId(run.threadId, run.runId),
          { kind: "run", payload },
        );
        run.dispatchedSummary = encoded;
      }

      const report = state.report;
      if (report !== null && reportKey(report) !== run.recordedReport) {
        yield* recordReport(run, report);
        run.recordedReport = reportKey(report);
      }
    },
    (effect, run) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to publish a factory run to its thread", {
            runDir: run.runDir,
            cause: error.message,
          }),
        ),
      ),
  );

  /** Reads every complete line waiting in the events file into the fold; true when any arrived. */
  const foldNewEventLines = Effect.fn("FactoryRunTracker.foldNewEventLines")(
    function* (run: TrackedRun) {
      let changed = false;
      while (true) {
        const read = yield* run.eventsTail.read;
        if (read.truncated) {
          yield* Effect.logWarning("factory run events file shrank; folding it again", {
            runDir: run.runDir,
          });
          run.state = emptyFactoryRunState(run.runDir);
          run.dispatchedSummary = null;
          changed = true;
        }
        for (const line of read.lines) run.state = foldFactoryRunLine(run.state, line);
        if (read.lines.length > 0) changed = true;
        if (!read.more) return changed;
      }
    },
    (effect, run) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to read a factory run events file", {
            runDir: run.runDir,
            cause: error.message,
          }).pipe(Effect.as(false)),
        ),
      ),
  );

  const readRoleTail = Effect.fn("FactoryRunTracker.readRoleTail")(
    function* (role: RoleTail) {
      let changed = false;
      while (true) {
        const read = yield* role.tail.read;
        if (read.truncated) {
          role.progress = emptyRoleOutputProgress;
          changed = true;
        }
        if (read.lines.length > 0) {
          const readAt = DateTime.formatIso(yield* DateTime.now);
          for (const line of read.lines) {
            role.progress = foldRoleOutputLine(role.progress, line, readAt);
          }
          changed = true;
        }
        if (!read.more) return changed;
      }
    },
    Effect.catch(() => Effect.succeed(false)),
  );

  const closeRoleWatch = (role: RoleTail) =>
    Effect.suspend(() => {
      const scope = role.scope;
      if (scope === null) return Effect.void;
      role.scope = null;
      return Scope.close(scope, Exit.void);
    });

  const closeRoleTail = (role: RoleTail) =>
    closeRoleWatch(role).pipe(Effect.andThen(Scope.close(role.tailScope, Exit.void)));

  /** Forgets a role that left the current phase, offset and counters included. */
  const dropRoleTail = (run: TrackedRun, outputFile: string) =>
    Effect.suspend(() => {
      const role = run.roleTails.get(outputFile);
      if (role === undefined) return Effect.void;
      run.roleTails.delete(outputFile);
      return closeRoleTail(role);
    });

  /** A finished run no pane is reading holds nothing worth keeping in memory. */
  const evictIfIdle = (run: TrackedRun) =>
    Effect.suspend(() => {
      if (!isFactoryRunFinished(run.state.status) || run.subscribers > 0) return Effect.void;
      if (runs.get(run.key) === run) runs.delete(run.key);
      return Effect.forEach(run.roleTails.values(), closeRoleTail, { discard: true });
    });

  /**
   * Closes the events watch in a fiber of its own. The watch's consumer is often
   * the fiber that folded `run.finished`, and closing its own scope from inside
   * would interrupt it while it holds the run's lock.
   */
  const stopFollowingEvents = (run: TrackedRun) =>
    Effect.suspend(() => {
      const scope = run.followScope;
      if (scope === null) return Effect.void;
      run.followScope = null;
      return Scope.close(scope, Exit.void).pipe(Effect.forkIn(trackerScope), Effect.asVoid);
    });

  /**
   * The one way a run moves: fold new event lines, keep the role tails matched
   * to the current phase while a pane is open, read them, and publish. Every
   * trigger, a file watch or `drain`, ends here, under the run's lock.
   */
  const refresh = (
    run: TrackedRun,
    options: { readonly evictWhenIdle: boolean } = { evictWhenIdle: true },
  ): Effect.Effect<void> =>
    run.lock.withPermits(1)(
      Effect.gen(function* () {
        // A finished run's events file is no longer read: its fold is final.
        let changed = run.followScope === null ? false : yield* foldNewEventLines(run);
        if (changed) yield* publishToThread(run);

        const wanted = currentDispatches(run.state);
        const wantedFiles = new Set(wanted.map((dispatch) => dispatch.outputFile));
        // Deleting the entry being visited is safe while iterating a Map.
        for (const outputFile of run.roleTails.keys()) {
          if (!wantedFiles.has(outputFile)) yield* dropRoleTail(run, outputFile);
        }
        // Role outputs are read only while a pane is open.
        if (run.subscribers > 0) {
          for (const dispatch of wanted) {
            if (yield* watchRoleTail(run, dispatch.outputFile)) changed = true;
          }
          for (const role of run.roleTails.values()) {
            if (yield* readRoleTail(role)) changed = true;
          }
        }

        if (changed) {
          run.version += 1;
          yield* PubSub.publish(changes, run.key);
        }
        if (isFactoryRunFinished(run.state.status)) {
          yield* stopFollowingEvents(run);
          if (options.evictWhenIdle) yield* evictIfIdle(run);
        }
      }),
    );

  /** Opens the watch on a role's output, keeping any offset already read; true when it opened. */
  const watchRoleTail = Effect.fn("FactoryRunTracker.watchRoleTail")(function* (
    run: TrackedRun,
    outputFile: string,
  ) {
    let role = run.roleTails.get(outputFile);
    if (role === undefined) {
      const tailScope = yield* Scope.fork(trackerScope);
      role = {
        tail: yield* makeAppendOnlyFileTail(path.resolve(run.runDir, outputFile)).pipe(
          Scope.provide(tailScope),
        ),
        tailScope,
        scope: null,
        progress: emptyRoleOutputProgress,
      };
      run.roleTails.set(outputFile, role);
    }
    if (role.scope !== null) return false;
    const scope = yield* Scope.fork(trackerScope);
    const triggers = yield* watchAppendOnlyFile(role.tail).pipe(Scope.provide(scope));
    role.scope = scope;
    yield* triggers.pipe(
      Stream.runForEach(() => refresh(run)),
      Effect.forkIn(scope),
    );
    return true;
  });

  const roleProgress = (run: TrackedRun): Array<FactoryRoleProgress> =>
    currentDispatches(run.state).map((dispatch) => {
      const progress = run.roleTails.get(dispatch.outputFile)?.progress ?? emptyRoleOutputProgress;
      return {
        phase: dispatch.phase,
        role: dispatch.role,
        turn: dispatch.turn,
        status: dispatch.finishedAt === null ? "running" : "finished",
        toolCalls: progress.toolCalls,
        lastTool: progress.lastTool,
        lastActivityAt: progress.lastActivityAt,
      };
    });

  const snapshot = (run: TrackedRun): FactoryRunStreamItem => ({
    state: run.state,
    roles: roleProgress(run),
  });

  const validateRunDirectory = Effect.fn("FactoryRunTracker.validateRunDirectory")(function* (
    runDir: string,
  ) {
    if (!path.isAbsolute(runDir)) {
      return yield* new FactoryAttachRunError({ reason: "relative-path", runDir });
    }
    const info = yield* fileSystem.stat(runDir).pipe(
      Effect.mapError(
        (cause) =>
          new FactoryAttachRunError({
            reason: cause.reason._tag === "NotFound" ? "not-found" : "read-failed",
            runDir,
            cause,
          }),
      ),
    );
    if (info.type !== "Directory") {
      return yield* new FactoryAttachRunError({ reason: "not-directory", runDir });
    }
    return path.resolve(runDir);
  });

  const attach: FactoryRunTracker["Service"]["attach"] = (threadId, requestedRunDir, options) =>
    attachLock.withPermits(1)(
      Effect.gen(function* () {
        const runDir = yield* validateRunDirectory(requestedRunDir);
        const runId = path.basename(runDir);
        const key = runKey(threadId, runId);
        if (runs.has(key)) return { runId };

        const followScope = yield* Scope.fork(trackerScope);
        // The events file is read only while it is followed.
        const eventsTail = yield* makeAppendOnlyFileTail(
          path.join(runDir, FACTORY_RUN_EVENTS_FILE),
        ).pipe(Scope.provide(followScope));
        // Watch first, then read: an append between the two is still seen.
        const triggers = yield* watchAppendOnlyFile(eventsTail).pipe(Scope.provide(followScope));

        const recorded = options?.recorded;
        const run: TrackedRun = {
          key,
          threadId,
          runDir,
          runId,
          eventsTail,
          lock: yield* Semaphore.make(1),
          state: emptyFactoryRunState(runDir),
          version: 0,
          followScope,
          dispatchedSummary: recorded === undefined ? null : encodeRunPayload(recorded),
          recordedReport: null,
          subscribers: 0,
          roleTails: new Map(),
        };
        yield* foldNewEventLines(run);
        // A record that says the run finished was written after its report was recorded.
        if (recorded !== undefined && isFactoryRunFinished(recorded.status)) {
          run.recordedReport = reportKey(run.state.report);
        }
        runs.set(key, run);

        yield* publishToThread(run);
        yield* triggers.pipe(
          Stream.runForEach(() => refresh(run)),
          Effect.forkIn(followScope),
        );
        // Lines may have landed after the first read; a finished run also stops here.
        // It stays in memory until a pane has read it.
        yield* refresh(run, { evictWhenIdle: false });
        return { runId };
      }),
    );

  const isAttached: FactoryRunTracker["Service"]["isAttached"] = (threadId, runId) =>
    Effect.sync(() => runs.has(runKey(threadId, runId)));

  const drain: FactoryRunTracker["Service"]["drain"] = (threadId, runId) =>
    Effect.suspend(() => {
      const run = runs.get(runKey(threadId, runId));
      return run === undefined ? Effect.void : refresh(run);
    });

  const addSubscriber = (run: TrackedRun) =>
    Effect.suspend(() => {
      run.subscribers += 1;
      // The first subscriber starts the role tails and reads them before the first snapshot.
      return refresh(run);
    });

  const removeSubscriber = (run: TrackedRun) =>
    run.lock.withPermits(1)(
      Effect.suspend(() => {
        run.subscribers -= 1;
        if (run.subscribers > 0) return Effect.void;
        return Effect.forEach(run.roleTails.values(), closeRoleWatch, { discard: true }).pipe(
          Effect.andThen(evictIfIdle(run)),
        );
      }),
    );

  /**
   * Each subscriber gets a one-slot sliding mailbox of whole snapshots, so a
   * slow client only ever holds the newest one. Changes are coalesced to one
   * snapshot a second: the deadline counts from the last snapshot sent.
   */
  const stream: FactoryRunTracker["Service"]["stream"] = (threadId, runId) =>
    Stream.callback<FactoryRunStreamItem>(
      (mailbox) =>
        Effect.gen(function* () {
          const run = runs.get(runKey(threadId, runId));
          if (run === undefined) {
            Queue.endUnsafe(mailbox);
            return;
          }
          const subscription = yield* PubSub.subscribe(changes);
          yield* Effect.acquireRelease(addSubscriber(run), () => removeSubscriber(run));
          let sentVersion = run.version;
          let sentAt = yield* Clock.currentTimeMillis;
          Queue.offerUnsafe(mailbox, snapshot(run));
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((key) => key === run.key),
            Stream.runForEach(() =>
              Effect.gen(function* () {
                const wait =
                  sentAt +
                  Duration.toMillis(STREAM_MIN_INTERVAL) -
                  (yield* Clock.currentTimeMillis);
                if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
                if (run.version === sentVersion) return;
                sentVersion = run.version;
                sentAt = yield* Clock.currentTimeMillis;
                Queue.offerUnsafe(mailbox, snapshot(run));
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  const tailedFiles: FactoryRunTracker["Service"]["tailedFiles"] = Effect.sync(() => {
    const runsList = [...runs.values()];
    return [
      ...runsList.flatMap((run) => (run.followScope === null ? [] : [run.eventsTail.path])),
      ...runsList.flatMap((run) =>
        [...run.roleTails.values()].flatMap((role) =>
          role.scope === null ? [] : [role.tail.path],
        ),
      ),
    ];
  });

  const attachRecordedRun = (payload: FactoryRunActivityPayload) =>
    attach(payload.threadId, payload.runDir, { recorded: payload }).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("could not follow a recorded factory run again", {
          runDir: payload.runDir,
          cause: error.message,
        }),
      ),
    );

  const reattachRecordedRuns: FactoryRunTracker["Service"]["reattachRecordedRuns"] = cards
    .listByKind("run")
    .pipe(
      Effect.flatMap((recorded) =>
        // Oldest first, so a thread's newest run sets its label.
        Effect.forEach(
          recorded,
          (record) => {
            const payload = recordedRunOf(record);
            if (Option.isNone(payload)) return Effect.void;
            if (isFactoryRunFinished(payload.value.status)) {
              return Effect.sync(() =>
                shellSummaries.set(payload.value.threadId, shellSummaryOfRecord(payload.value)),
              );
            }
            return attachRecordedRun(payload.value);
          },
          { discard: true },
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning("could not read the recorded factory runs", { cause: error.message }),
      ),
    );

  const attachRecorded: FactoryRunTracker["Service"]["attachRecorded"] = Effect.fn(
    "FactoryRunTracker.attachRecorded",
  )(function* (threadId: ThreadId, runId: string) {
    if (yield* isAttached(threadId, runId)) return;
    const record = yield* cards
      .get(TurnItemId.make(factoryRunActivityId(threadId, runId)))
      .pipe(Effect.orElseSucceed(() => Option.none<FactoryCardQuery.FactoryCardRecord>()));
    const payload = Option.flatMap(record, recordedRunOf);
    if (Option.isSome(payload)) yield* attachRecordedRun(payload.value);
  });

  return FactoryRunTracker.of({
    attach,
    isAttached,
    drain,
    stream,
    tailedFiles,
    reattachRecordedRuns,
    attachRecorded,
  });
});

export const layer = Layer.effect(FactoryRunTracker, make);

/** The run a recorded run card names, when it is a run card and its id matches its payload. */
function recordedRunOf(
  record: FactoryCardQuery.FactoryCardRecord,
): Option.Option<FactoryRunActivityPayload> {
  if (record.card.kind !== "run") return Option.none();
  const payload = record.card.payload;
  return record.turnItemId === factoryRunActivityId(payload.threadId, payload.runId)
    ? Option.some(payload)
    : Option.none();
}

/**
 * After a restart, follows again every recorded run that was not finished.
 * Without a tracker in the runtime it does nothing, so startup tests that build
 * no tracker are unaffected.
 */
export const reattachFactoryRuns = Effect.serviceOption(FactoryRunTracker).pipe(
  Effect.flatMap((tracker) =>
    Option.isNone(tracker) ? Effect.void : tracker.value.reattachRecordedRuns,
  ),
);

function shellSummaryOfRecord(payload: FactoryRunActivityPayload): FactoryRunShellSummary {
  return {
    status: payload.status,
    phaseIndex: payload.phase?.index ?? 0,
    phaseCount: payload.phaseCount,
    node: payload.node,
  };
}

/**
 * What `subscribeFactoryRun` returns. A run not followed now, such as a
 * finished run after a restart, is read again from the directory its run card
 * records before the stream starts.
 */
export const subscribeFactoryRun = (
  tracker: FactoryRunTracker["Service"],
  input: FactorySubscribeRunInput,
): Stream.Stream<FactoryRunStreamItem> =>
  Stream.unwrap(
    tracker
      .attachRecorded(input.threadId, input.runId)
      .pipe(Effect.as(tracker.stream(input.threadId, input.runId))),
  );
