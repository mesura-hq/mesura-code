/**
 * FactoryRunUsage - what a factory run used of the developer's plans, read from the
 * providers' own readings already on disk (`claude -p` rate_limit_event lines, Codex
 * rollout rate_limits) plus this machine's spend. Runs recorded before it work too.
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
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as UsageService from "../usage/UsageService.ts";
import { FactoryRunTracker, subscribeFactoryRun } from "./FactoryRunTracker.ts";

const PROVIDERS: ReadonlyArray<FactoryRunQuotaProvider> = ["claude", "codex"];

/** The usage service answers hourly windows of at most a day. */
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What `select` keeps from each line of a file, streamed: a resumed session's rollout grows past
 * hundreds of megabytes of earlier turns, so lines are parsed and dropped as they pass, never held.
 * A file that cannot be read keeps nothing.
 */
const selectFromLines = <A>(
  fs: FileSystem.FileSystem,
  file: string,
  select: (line: string) => ReadonlyArray<A>,
) =>
  fs.stream(file).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runFold(
      (): Array<A> => [],
      (kept, line) => {
        for (const item of select(line)) kept.push(item);
        return kept;
      },
    ),
    Effect.map((kept): ReadonlyArray<A> => kept),
    Effect.orElseSucceed((): ReadonlyArray<A> => []),
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
  const keepEvent = (line: string) => (line.includes('"rate_limit_event"') ? [line] : []);
  return selectFromLines(fs, path.resolve(runDir, dispatch.outputFile), keepEvent).pipe(
    Effect.map((events) => {
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
 * A Codex session's rollout. Codex files it under the day the session started and
 * appends every resumed turn there, so search the days around the run's first turn
 * first, then every earlier day, newest first.
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
    Effect.filterOrElse(
      (found) => found.length > 0,
      () => firstRollouts(fs, path, rest, sessionId),
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
    // Only this run's readings are kept: the rollout also holds the session's other turns.
    const keepRunSample = (line: string) =>
      readCodexQuotaLine(line).filter((sample) =>
        intervals.some(
          (interval) =>
            sample.observedAtMs >= interval.startMs && sample.observedAtMs <= interval.endMs,
        ),
      );
    return findCodexRollouts(fs, path, codexHome, sessionId, firstTurnMs).pipe(
      Effect.flatMap((files) =>
        Effect.forEach(files, (file) => selectFromLines(fs, file, keepRunSample)),
      ),
      Effect.map((files) => files.flat()),
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
 * Every input the share was computed from, beside its result, so a later
 * reader can redo the arithmetic. Written next to the server's state, never
 * sent to clients: the samples alone can run to thousands of lines.
 */
export interface FactoryRunUsageAudit {
  readonly runId: string;
  readonly runDir: string;
  readonly readAt: string;
  readonly runStartedAt: string | null;
  readonly runEndedAt: string | null;
  readonly providers: ReadonlyArray<{
    readonly provider: FactoryRunQuotaProvider;
    readonly samples: ReadonlyArray<FactoryQuotaSample>;
    readonly turns: ReadonlyArray<FactoryTurnSpend>;
    readonly span: { readonly firstAt: string; readonly lastAt: string } | null;
    readonly machineSpendUsd: number | null;
    readonly machineSpendInSpanUsd: number | null;
    readonly result: FactoryRunUsage["providers"][number];
  }>;
}

/**
 * The run's usage of each plan, from its folded state. A provider the run
 * dispatched no turn to is left out; a provider whose readings are missing
 * still shows the run's spend.
 */
export const readFactoryRunUsageOf = (
  state: FactoryRunState,
  usage: Option.Option<UsageService.UsageService["Service"]>,
  codexHome: string = defaultCodexHome(),
) =>
  readFactoryRunUsageWithAudit(state, usage, codexHome).pipe(Effect.map((result) => result.usage));

const readFactoryRunUsageWithAudit = Effect.fn("FactoryRunUsage.read")(function* (
  state: FactoryRunState,
  usage: Option.Option<UsageService.UsageService["Service"]>,
  codexHome: string = defaultCodexHome(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readAt = DateTime.formatIso(yield* DateTime.now);
  const audit = (providers: FactoryRunUsageAudit["providers"]): FactoryRunUsageAudit => ({
    runId: state.runId,
    runDir: state.runDir,
    readAt,
    runStartedAt: state.startedAt,
    runEndedAt: state.finishedAt ?? state.lastEventAt,
    providers,
  });
  if (state.startedAt === null) {
    return {
      usage: {
        runId: state.runId,
        providers: [],
        machineSpend: "unavailable",
        readAt,
      } satisfies FactoryRunUsage,
      audit: audit([]),
    };
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
      // The machine's spend over exactly the span the readings' movement covers: after the first
      // reading, up to and with the last. The usage summary counts [since, until), hence the +1 ms.
      const spanBuckets =
        buckets === null || target === undefined
          ? null
          : yield* machineBuckets(
              usage,
              Date.parse(target.firstAt) + 1,
              Date.parse(target.lastAt) + 1,
            );
      const input = {
        provider,
        windows,
        turns: turnSpends(state, provider, buckets),
        machineSpendUsd: buckets === null ? null : spendOf(buckets, provider),
        machineSpendInSpanUsd: spanBuckets === null ? null : spendOf(spanBuckets, provider),
      };
      const result = factoryRunUsageProvider(input);
      return {
        result,
        audit: {
          provider,
          samples,
          turns: input.turns,
          span: target === undefined ? null : { firstAt: target.firstAt, lastAt: target.lastAt },
          machineSpendUsd: input.machineSpendUsd,
          machineSpendInSpanUsd: input.machineSpendInSpanUsd,
          result,
        },
      };
    }),
  );
  return {
    usage: {
      runId: state.runId,
      providers: providers.map((provider) => provider.result),
      machineSpend: buckets === null ? "unavailable" : "read",
      readAt,
    } satisfies FactoryRunUsage,
    audit: audit(providers.map((provider) => provider.audit)),
  };
});

/**
 * Keeps the newest audit of each run under the server's state, one file per
 * run, so the estimate can be checked against its inputs later. A failed
 * write never fails the read.
 */
const encodeAudit = Schema.encodeUnknownEffect(fromJsonStringPretty(Schema.Unknown));

const writeFactoryRunUsageAudit = Effect.fn("FactoryRunUsage.writeAudit")(
  function* (directory: string, audit: FactoryRunUsageAudit) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = path.join(directory, `${audit.runId.replace(/[^\w.-]/g, "_")}.json`);
    yield* fs.writeFileString(file, `${yield* encodeAudit(audit)}\n`);
  },
  (effect) => Effect.ignore(effect),
);

/** The `factory.readRunUsage` handler: the run's state from the tracker, then its usage. */
export const makeReadFactoryRunUsage = Effect.gen(function* () {
  const tracker = yield* FactoryRunTracker;
  // Optional, so a server built without usage reading still answers with the movement.
  const usage = yield* Effect.serviceOption(UsageService.UsageService);
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const auditDirectory = (yield* Path.Path).join(
    (yield* ServerConfig.ServerConfig).stateDir,
    "factory-usage",
  );
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
          : readFactoryRunUsageWithAudit(item.value.state, usage).pipe(
              Effect.tap((result) => writeFactoryRunUsageAudit(auditDirectory, result.audit)),
              Effect.map((result) => result.usage),
            ),
      ),
      Effect.provide(context),
    );
});
