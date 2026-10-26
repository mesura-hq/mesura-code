/**
 * FactoryRunUsage - what a Software Factory run used of the developer's plans.
 *
 * The run's role turns already left the provider's own readings on disk:
 * every `claude -p` output carries `rate_limit_event` lines, and every Codex
 * session rollout carries `rate_limits`. This reads them for the run's turns,
 * reads this machine's spend over the run and over the readings' span from the
 * usage service, and lets `@t3tools/shared/factoryRunUsage` turn both into the
 * run's share. Nothing
 * is recorded by the skill for it, so runs recorded before it existed work too.
 *
 * @module FactoryRunUsage
 */
import * as NodeOS from "node:os";

import {
  type FactoryReadRunUsageInput,
  type FactoryRunDispatch,
  type FactoryRunQuotaProvider,
  type FactoryRunState,
  type FactoryRunUsage,
  type UsageBucket,
  UsageDay,
} from "@t3tools/contracts";
import {
  factoryEstimateWindow,
  factoryQuotaWindows,
  factoryRunTurnsOf,
  factoryRunUsageProvider,
  readClaudeQuotaLine,
  readCodexQuotaLine,
  type FactoryQuotaSample,
  type FactoryTurnSpend,
} from "@t3tools/shared/factoryRunUsage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as UsageService from "../usage/UsageService.ts";
import { FactoryRunTracker, subscribeFactoryRun } from "./FactoryRunTracker.ts";

const PROVIDERS: ReadonlyArray<FactoryRunQuotaProvider> = ["claude", "codex"];

/** The usage service answers hourly windows of at most a day. */
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A role output or rollout larger than this is not read for readings. */
const MAX_READ_BYTES = 64 * 1024 * 1024;

const readLines = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.flatMap((info) =>
      Number(info.size) > MAX_READ_BYTES
        ? Effect.succeed<ReadonlyArray<string>>([])
        : fs.readFileString(file).pipe(Effect.map((text) => text.split("\n"))),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

/**
 * A Claude turn's readings. The lines carry no time, so they are spread
 * evenly over the turn, the first at its start and the last at its finish.
 */
function claudeTurnSamples(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  runDir: string,
  dispatch: FactoryRunDispatch,
) {
  return readLines(fs, path.resolve(runDir, dispatch.outputFile)).pipe(
    Effect.map((lines) => {
      const events = lines.filter((line) => line.includes('"rate_limit_event"'));
      const startMs = Date.parse(dispatch.startedAt);
      const endMs = dispatch.finishedAt === null ? startMs : Date.parse(dispatch.finishedAt);
      return events.flatMap((line, index) =>
        readClaudeQuotaLine(
          line,
          events.length < 2 ? endMs : startMs + ((endMs - startMs) * index) / (events.length - 1),
        ),
      );
    }),
  );
}

/** Where Codex keeps its sessions, as the Codex CLI resolves it. */
const defaultCodexHome = () => process.env.CODEX_HOME?.trim() || `${NodeOS.homedir()}/.codex`;

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** `YYYY-MM-DD` in UTC. */
const dayOf = (ms: number) => UsageDay.make(isoOf(ms).slice(0, 10));

/** The `sessions/YYYY/MM/DD` directory of a UTC day offset from `ms`. */
const dayDirectory = (path: Path.Path, home: string, ms: number) => {
  const [yyyy, mm, dd] = dayOf(ms).split("-");
  return path.join(home, "sessions", yyyy!, mm!, dd!);
};

/** The rollouts in one day directory that belong to the session. */
const rolloutsIn = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  sessionId: string,
) =>
  fs.readDirectory(directory).pipe(
    Effect.map((names) =>
      names
        .filter((name) => name.endsWith(`-${sessionId}.jsonl`))
        .map((name) => path.join(directory, name)),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

/** Every `sessions/YYYY/MM/DD` directory up to `untilDay`, newest first. */
const dayDirectoriesUntil = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  untilDay: string,
) => {
  const root = path.join(home, "sessions");
  const names = (directory: string) =>
    fs.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return names(root).pipe(
    Effect.flatMap((years) =>
      Effect.forEach(years, (yyyy) =>
        names(path.join(root, yyyy)).pipe(
          Effect.flatMap((months) =>
            Effect.forEach(months, (mm) =>
              names(path.join(root, yyyy, mm)).pipe(
                Effect.map((days) => days.map((dd) => `${yyyy}-${mm}-${dd}`)),
              ),
            ),
          ),
        ),
      ),
    ),
    Effect.map((found) =>
      found
        .flat(2)
        .filter((day) => day <= untilDay)
        .sort((left, right) => right.localeCompare(left))
        .map((day) => path.join(root, ...day.split("-"))),
    ),
  );
};

/**
 * A Codex session's rollout. Codex files it under the local day the session
 * started and appends every resumed turn to that file, so a session resumed
 * days later, or begun before the run, is still in its first day's directory.
 * The days around its first turn in the run are looked at first, then every
 * earlier day, newest first.
 */
function findCodexRollouts(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  codexHome: string,
  sessionId: string,
  firstTurnMs: number,
) {
  const near = [-1, 0, 1].map((offset) =>
    dayDirectory(path, codexHome, firstTurnMs + offset * USAGE_WINDOW_MS),
  );
  return Effect.forEach(near, (directory) => rolloutsIn(fs, path, directory, sessionId)).pipe(
    Effect.map((found) => [...new Set(found.flat())]),
    Effect.flatMap((found) =>
      found.length > 0
        ? Effect.succeed<ReadonlyArray<string>>(found)
        : dayDirectoriesUntil(fs, path, codexHome, dayOf(firstTurnMs)).pipe(
            Effect.flatMap((directories) => firstRollouts(fs, path, directories, sessionId)),
          ),
    ),
  );
}

/** The session's rollouts in the first of `directories` that holds any. */
const firstRollouts = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directories: ReadonlyArray<string>,
  sessionId: string,
): Effect.Effect<ReadonlyArray<string>> => {
  const [directory, ...rest] = directories;
  if (directory === undefined) return Effect.succeed([]);
  return rolloutsIn(fs, path, directory, sessionId).pipe(
    Effect.flatMap((found) =>
      found.length > 0 ? Effect.succeed(found) : firstRollouts(fs, path, rest, sessionId),
    ),
  );
};

/**
 * The readings of the run's Codex turns. Each session's rollout is found and
 * read once, then its readings are kept for the time its turns ran: the
 * rollout also holds the session's turns outside this run.
 */
function codexSamples(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  codexHome: string,
  dispatches: ReadonlyArray<FactoryRunDispatch>,
) {
  const sessions = new Map<string, FactoryRunDispatch[]>();
  for (const dispatch of dispatches) {
    if (dispatch.sessionId === null) continue;
    sessions.set(dispatch.sessionId, [...(sessions.get(dispatch.sessionId) ?? []), dispatch]);
  }
  return Effect.forEach([...sessions.entries()], ([sessionId, turns]) => {
    const intervals = turns.map((turn) => ({
      startMs: Date.parse(turn.startedAt),
      endMs: turn.finishedAt === null ? Number.POSITIVE_INFINITY : Date.parse(turn.finishedAt),
    }));
    const firstTurnMs = Math.min(...intervals.map((interval) => interval.startMs));
    return findCodexRollouts(fs, path, codexHome, sessionId, firstTurnMs).pipe(
      Effect.flatMap((files) => Effect.forEach(files, (file) => readLines(fs, file))),
      Effect.map((files) =>
        files
          .flat()
          .flatMap((line) => readCodexQuotaLine(line))
          .filter((sample) =>
            intervals.some(
              (interval) =>
                sample.observedAtMs >= interval.startMs && sample.observedAtMs <= interval.endMs,
            ),
          ),
      ),
    );
  }).pipe(Effect.map((found): ReadonlyArray<FactoryQuotaSample> => found.flat()));
}

/**
 * The run's finished turns on a provider with their own spend at list price:
 * Claude reports dollars, Codex is priced at the rates the machine's own
 * buckets for the same model imply, so the run and the machine are measured
 * in one price basis. A turn with nothing priceable is left out.
 */
function turnSpends(
  state: FactoryRunState,
  provider: FactoryRunQuotaProvider,
  buckets: ReadonlyArray<UsageBucket> | null,
): ReadonlyArray<FactoryTurnSpend> {
  return factoryRunTurnsOf(state, provider).flatMap((turn) => {
    if (turn.finishedAt === null) return [];
    const spendUsd = turnSpendUsd(turn, provider, buckets);
    if (spendUsd === null) return [];
    return [{ startMs: Date.parse(turn.startedAt), endMs: Date.parse(turn.finishedAt), spendUsd }];
  });
}

function turnSpendUsd(
  turn: FactoryRunDispatch,
  provider: FactoryRunQuotaProvider,
  buckets: ReadonlyArray<UsageBucket> | null,
): number | null {
  if (provider === "claude") return turn.costUsd;
  if (buckets === null || turn.tokens === null) return null;
  const rates = bucketRates(buckets, provider, turn.model);
  if (rates === null) return null;
  const input = turn.tokens.input_tokens ?? 0;
  const cached = Math.min(input, turn.tokens.cached_input_tokens ?? 0);
  const output = turn.tokens.output_tokens ?? 0;
  return (input - cached) * rates.input + cached * rates.cacheRead + output * rates.output;
}

/** Dollars per token by category, from the machine's buckets for one model. */
function bucketRates(
  buckets: ReadonlyArray<UsageBucket>,
  provider: FactoryRunQuotaProvider,
  model: string,
): { input: number; cacheRead: number; output: number } | null {
  let input = 0;
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheReadTokens = 0;
  let output = 0;
  let outputTokens = 0;
  for (const bucket of buckets) {
    if (bucket.provider !== provider || bucket.model !== model) continue;
    if (bucket.categoryCostUsd === undefined) continue;
    input += bucket.categoryCostUsd.input;
    inputTokens += bucket.totals.uncachedInputTokens;
    cacheRead += bucket.categoryCostUsd.cacheRead;
    cacheReadTokens += bucket.totals.cachedInputTokens;
    output += bucket.categoryCostUsd.output;
    outputTokens += bucket.totals.outputTokens;
  }
  if (inputTokens + cacheReadTokens + outputTokens === 0) return null;
  return {
    input: inputTokens === 0 ? 0 : input / inputTokens,
    cacheRead: cacheReadTokens === 0 ? 0 : cacheRead / cacheReadTokens,
    output: outputTokens === 0 ? 0 : output / outputTokens,
  };
}

/**
 * Every bucket of this machine's usage over `[startMs, endMs]`, read a day at
 * a time; null when the usage service is absent or a read fails.
 */
function machineBuckets(
  usage: Option.Option<UsageService.UsageService["Service"]>,
  startMs: number,
  endMs: number,
) {
  if (Option.isNone(usage)) return Effect.succeed(null);
  const windows: Array<readonly [number, number]> = [];
  for (let from = startMs; from < endMs; from += USAGE_WINDOW_MS) {
    windows.push([from, Math.min(endMs, from + USAGE_WINDOW_MS)]);
  }
  return Effect.forEach(windows, ([from, to]) =>
    usage.value.readSummary({
      sinceDay: dayOf(from),
      untilDay: dayOf(to),
      timeZone: "UTC",
      resolution: "hour",
      sinceTime: isoOf(from),
      untilTime: isoOf(to),
    }),
  ).pipe(
    Effect.map((summaries) => summaries.flatMap((summary) => summary.buckets)),
    Effect.option,
    Effect.map(Option.getOrNull),
  );
}

const spendOf = (buckets: ReadonlyArray<UsageBucket>, provider: FactoryRunQuotaProvider) =>
  buckets
    .filter((bucket) => bucket.provider === provider)
    .reduce((sum, bucket) => sum + bucket.costUsd, 0);

/**
 * The run's usage of each plan, from its folded state. A provider the run
 * dispatched no turn to is left out; a provider whose readings are missing
 * still shows the run's spend.
 */
export const readFactoryRunUsageOf = Effect.fn("FactoryRunUsage.read")(function* (
  state: FactoryRunState,
  usage: Option.Option<UsageService.UsageService["Service"]>,
  codexHome: string = defaultCodexHome(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readAt = DateTime.formatIso(yield* DateTime.now);
  if (state.startedAt === null) {
    return {
      runId: state.runId,
      providers: [],
      machineSpend: "unavailable",
      readAt,
    } satisfies FactoryRunUsage;
  }
  const startMs = Date.parse(state.startedAt);
  const endMs = Date.parse(state.finishedAt ?? state.lastEventAt ?? state.startedAt);
  const buckets = yield* machineBuckets(usage, startMs, Math.max(endMs, startMs + 1));
  const providers = yield* Effect.forEach(
    PROVIDERS.filter((provider) => factoryRunTurnsOf(state, provider).length > 0),
    Effect.fnUntraced(function* (provider) {
      const dispatches = factoryRunTurnsOf(state, provider);
      const samples =
        provider === "claude"
          ? (yield* Effect.forEach(dispatches, (dispatch) =>
              claudeTurnSamples(fs, path, state.runDir, dispatch),
            )).flat()
          : yield* codexSamples(fs, path, codexHome, dispatches);
      const windows = factoryQuotaWindows(provider, samples);
      const target = factoryEstimateWindow(windows);
      // The machine's spend over exactly the span the estimate window's readings cover.
      const spanBuckets =
        buckets === null || target === undefined
          ? null
          : yield* machineBuckets(usage, Date.parse(target.firstAt), Date.parse(target.lastAt));
      return factoryRunUsageProvider({
        provider,
        windows,
        turns: turnSpends(state, provider, buckets),
        machineSpendUsd: buckets === null ? null : spendOf(buckets, provider),
        machineSpendInSpanUsd: spanBuckets === null ? null : spendOf(spanBuckets, provider),
      });
    }),
  );
  return {
    runId: state.runId,
    providers,
    machineSpend: buckets === null ? "unavailable" : "read",
    readAt,
  } satisfies FactoryRunUsage;
});

/** The `factory.readRunUsage` handler: the run's state from the tracker, then its usage. */
export const makeReadFactoryRunUsage = Effect.gen(function* () {
  const tracker = yield* FactoryRunTracker;
  // Optional, so a server built without usage reading still answers with the movement.
  const usage = yield* Effect.serviceOption(UsageService.UsageService);
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  return (input: FactoryReadRunUsageInput): Effect.Effect<FactoryRunUsage> =>
    subscribeFactoryRun(tracker, input).pipe(
      Stream.runHead,
      Effect.flatMap((item) =>
        Option.isNone(item)
          ? Effect.gen(function* () {
              const readAt = DateTime.formatIso(yield* DateTime.now);
              return {
                runId: input.runId,
                providers: [],
                machineSpend: "unavailable",
                readAt,
              } satisfies FactoryRunUsage;
            })
          : readFactoryRunUsageOf(item.value.state, usage),
      ),
      Effect.provide(context),
    );
});
