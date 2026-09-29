/**
 * Mesura: the shared host stats model. `applyHostStatsMessage` folds the
 * `subscribeHostStats` stream into one environment's history, and
 * `projectHostStats` turns every environment's history and connection into
 * the rows the web dock and the mobile Hosts screen render. Every decision
 * about whether a number can be trusted lives here, so the two clients cannot
 * disagree about it.
 */
import {
  HOST_STATS_CONTRACT_VERSION,
  fromHostStatsBucketColumns,
  type EnvironmentId,
  type HostStatsBucket,
  type HostStatsGpu,
  type HostStatsHostFacts,
  type HostStatsMessage,
  type HostStatsSample,
  type HostStatsSampleMessage,
  type HostStatsSnapshotMessage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import {
  HOST_STATS_STALE_AFTER_MS,
  hostStatsLevel,
  type HostStatsLevel,
  type HostStatsLevelMetric,
} from "./hostStatsLevels.ts";

/** One environment's history, as the client holds it between messages. */
export interface HostStatsHistory {
  /** The server's contract version. On another version nothing else here is read. */
  readonly contractVersion: number;
  readonly host: HostStatsHostFacts;
  readonly sampleIntervalMs: number;
  readonly bucketMs: number;
  readonly windowMs: number;
  /** Ordered by `start`, one per `start`, none older than the window. */
  readonly buckets: ReadonlyArray<HostStatsBucket>;
  /** Per bucket, the host time its content was known as of: the `serverNow` that carried it. */
  readonly bucketsAsOf: ReadonlyArray<number>;
  readonly latest: HostStatsSample | null;
  /**
   * Host clock minus local clock: the largest `serverNow - receivedAtLocal`
   * since the last snapshot. Every estimate falls short of the true offset by
   * that message's delay, so the largest is the least delayed, and any error
   * left makes a reading look older, never younger.
   */
  readonly offsetMs: number;
  /** `serverNow` of the newest message applied. */
  readonly newestServerNow: number;
}

export type HostStatsHostState = "live" | "stale" | "offline" | "needs-update" | "pending";

export type HostStatsRowId =
  | "cpu"
  | "memory"
  | "swap"
  | "disk"
  | "gpu"
  | "temperature"
  | "network"
  | "agents"
  | "servers";

/** `sleeping`: the host has GPUs, and every one it could have measured is runtime-suspended. */
export type HostStatsRowAvailability = "available" | "not-available" | "sleeping";

/**
 * One metric line. What `value` and `secondary` hold, per row:
 * - cpu: busy percent; load1. `secondaryLevel` is the load per core.
 * - memory, swap: used percent; used bytes.
 * - disk: used percent; free bytes.
 * - gpu: busy percent of the busiest active GPU; its memory used percent, which sets `level`.
 *   With no active GPU and one asleep, the row is `sleeping`, with its past series.
 * - temperature: CPU degrees Celsius; null.
 * - network: receive bytes per second; send bytes per second.
 * - agents: agents running; agent sessions open.
 * - servers: installed Mesura Code servers; dev servers.
 *
 * Series are percent for cpu, memory and gpu, degrees for temperature, bytes
 * per second received plus sent for network, and the running maximum for agents.
 * Swap and disk render as bars, and servers as a count, so they carry no series.
 * cpu and gpu also carry `peakSeries`, each bucket's maximum on the same axis.
 */
export interface HostStatsRow {
  readonly value: number | null;
  readonly secondary: number | null;
  /** Null unless the row is available. */
  readonly level: HostStatsLevel | null;
  /** The level of `secondary` where it has one of its own: load per core on the CPU row. */
  readonly secondaryLevel: HostStatsLevel | null;
  readonly availability: HostStatsRowAvailability;
  /** One slot per bucket of the window, null for a gap; null when the row has no series. */
  readonly series: ReadonlyArray<number | null> | null;
  /** Per slot, the bucket's maximum where it keeps one: cpu and gpu. Null on every other row. */
  readonly peakSeries: ReadonlyArray<number | null> | null;
  /** Total bytes the row is measured against: memory, swap and disk. Null on every other row. */
  readonly total: number | null;
}

export interface HostStatsHostView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  /** The connection, which `state` cannot say: stale and needs-update hosts may be connected or not. */
  readonly connected: boolean;
  readonly platform: string | null;
  readonly uptimeMs: number | null;
  readonly state: HostStatsHostState;
  /** Host-clock age of the latest sample; null when no sample was read this session. */
  readonly lastReadingAgeMs: number | null;
  /** Host-clock `start` of `series[0]`. */
  readonly seriesStartMs: number | null;
  readonly bucketMs: number | null;
  /** Null when there is nothing to show: pending, needs update, or never read. */
  readonly rows: Readonly<Record<HostStatsRowId, HostStatsRow>> | null;
}

/** What one environment's `hostStats` atom holds: its folded history, and whether the stream failed. */
export interface HostStatsSubscription {
  readonly history: HostStatsHistory | null;
  readonly failed: boolean;
}

const NEVER_SUBSCRIBED: HostStatsSubscription = { history: null, failed: false };

/**
 * Reads a `hostStats` atom result. A failed subscription keeps the history it
 * had folded while it retries, so its age alone decides how long that history
 * still reads as live.
 */
export function readHostStatsSubscription<E>(
  result: AsyncResult.AsyncResult<HostStatsSubscription, E>,
): HostStatsSubscription {
  const subscription = Option.getOrElse(AsyncResult.value(result), () => NEVER_SUBSCRIBED);
  return AsyncResult.isFailure(result) && !subscription.failed
    ? { ...subscription, failed: true }
    : subscription;
}

export interface ProjectHostStatsInput {
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  /** An environment with no entry has never been subscribed. */
  readonly subscriptions: ReadonlyMap<EnvironmentId, HostStatsSubscription>;
  readonly nowLocal: number;
}

const alignedStart = (time: number, bucketMs: number) => Math.floor(time / bucketMs) * bucketMs;

const slotCount = (history: Pick<HostStatsHistory, "bucketMs" | "windowMs">) =>
  Math.round(history.windowMs / history.bucketMs);

/** `start` of the oldest slot of a window whose newest slot holds `hostNow`. */
function windowStart(
  history: Pick<HostStatsHistory, "bucketMs" | "windowMs">,
  hostNow: number,
): number {
  return alignedStart(hostNow, history.bucketMs) - (slotCount(history) - 1) * history.bucketMs;
}

type HeldBuckets = Pick<HostStatsHistory, "buckets" | "bucketsAsOf">;

function trimToWindow(
  history: Pick<HostStatsHistory, "bucketMs" | "windowMs">,
  held: HeldBuckets,
  hostNow: number,
): HeldBuckets {
  const oldestStart = windowStart(history, hostNow);
  const firstKept = held.buckets.findIndex((bucket) => bucket.start >= oldestStart);
  if (firstKept === 0) return held;
  if (firstKept === -1) return { buckets: [], bucketsAsOf: [] };
  return {
    buckets: held.buckets.slice(firstKept),
    bucketsAsOf: held.bucketsAsOf.slice(firstKept),
  };
}

function applySnapshot(
  previous: HostStatsHistory | null,
  snapshot: HostStatsSnapshotMessage,
  offsetMs: number,
): HostStatsHistory | null {
  const base = {
    contractVersion: snapshot.contractVersion,
    host: snapshot.host,
    sampleIntervalMs: snapshot.sampleIntervalMs,
    bucketMs: snapshot.bucketMs,
    windowMs: snapshot.windowMs,
    offsetMs,
    newestServerNow: snapshot.serverNow,
  };
  // Another version may give these fields other meanings, so keep only what
  // says so; the projection shows the host as needing an update.
  if (snapshot.contractVersion !== HOST_STATS_CONTRACT_VERSION) {
    return { ...base, buckets: [], bucketsAsOf: [], latest: null };
  }
  // A snapshot that cannot place buckets on an axis is malformed: keep what we had.
  if (snapshot.bucketMs <= 0 || snapshot.windowMs < snapshot.bucketMs) return previous;
  let buckets: ReadonlyArray<HostStatsBucket>;
  try {
    buckets = fromHostStatsBucketColumns(snapshot.buckets);
  } catch {
    return previous;
  }
  // The server is the source of truth for its history: a snapshot replaces
  // every held bucket, so a reconnect can neither duplicate nor reorder. It
  // starts a session, so it also resets the offset and the newest `serverNow`,
  // even when the host clock stepped back across a restart.
  const held = trimToWindow(
    base,
    { buckets, bucketsAsOf: buckets.map(() => snapshot.serverNow) },
    snapshot.serverNow,
  );
  return { ...base, ...held, latest: snapshot.latest };
}

/**
 * Keeps, per `start`, the bucket known as of the latest host time. That makes
 * the merge order-independent and idempotent, and means a delayed update can
 * only fill a bucket nothing newer has described; it never overwrites one.
 */
function mergeBucket(held: HeldBuckets, incoming: HostStatsBucket, asOf: number): HeldBuckets {
  const index = held.buckets.findIndex((bucket) => bucket.start >= incoming.start);
  const at = index === -1 ? held.buckets.length : index;
  const replaces = index !== -1 && held.buckets[index]!.start === incoming.start;
  if (replaces && held.bucketsAsOf[index]! >= asOf) return held;
  const removed = replaces ? 1 : 0;
  return {
    buckets: [...held.buckets.slice(0, at), incoming, ...held.buckets.slice(at + removed)],
    bucketsAsOf: [...held.bucketsAsOf.slice(0, at), asOf, ...held.bucketsAsOf.slice(at + removed)],
  };
}

function applySample(
  history: HostStatsHistory | null,
  message: HostStatsSampleMessage,
  offsetMs: number,
): HostStatsHistory | null {
  // Updates only refine a snapshot; without one there is no axis to place them on.
  if (history === null || history.contractVersion !== HOST_STATS_CONTRACT_VERSION) {
    return history;
  }
  if (message.bucket.start % history.bucketMs !== 0) return history;
  const held = mergeBucket(history, message.bucket, message.serverNow);
  // Only a message newer than every one applied speaks for the host's current
  // time. An older or duplicated one arrived late, and its estimate carries
  // that delay; the maximum below would discard it anyway.
  if (message.serverNow <= history.newestServerNow) {
    if (held === history) return history;
    return { ...history, ...trimToWindow(history, held, history.newestServerNow) };
  }
  const latest =
    history.latest === null || message.sample.sampledAt > history.latest.sampledAt
      ? message.sample
      : history.latest;
  return {
    ...history,
    ...trimToWindow(history, held, message.serverNow),
    latest,
    offsetMs: Math.max(history.offsetMs, offsetMs),
    newestServerNow: message.serverNow,
  };
}

/**
 * Folds one message into an environment's history. Total: a message this
 * client cannot read leaves the history as it was, or, from another contract
 * version, records only that version.
 */
export function applyHostStatsMessage(
  history: HostStatsHistory | null,
  message: HostStatsMessage,
  receivedAtLocal: number,
): HostStatsHistory | null {
  const offsetMs = message.serverNow - receivedAtLocal;
  return message.type === "snapshot"
    ? applySnapshot(history, message, offsetMs)
    : applySample(history, message, offsetMs);
}

/**
 * The `transform` of the `hostStats` subscription atom. The atom keeps only
 * the last value a stream chunk carries, so the history is folded here, before
 * the atom, where a snapshot and an update landing together both count.
 */
/** How long a failed `hostStats` stream waits before subscribing again. */
export interface HostStatsRetry {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export const HOST_STATS_RETRY: HostStatsRetry = { initialDelayMs: 5_000, maxDelayMs: 300_000 };

/** Doubles from `initialDelayMs` after each failure in a row, up to `maxDelayMs`. */
export function hostStatsRetryDelayMs(
  failuresInARow: number,
  retry: HostStatsRetry = HOST_STATS_RETRY,
): number {
  return Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** Math.min(failuresInARow, 30));
}

type HostStatsStreamEvent =
  | { readonly _tag: "message"; readonly message: HostStatsMessage }
  | { readonly _tag: "failed" };

const FAILED_EVENT: HostStatsStreamEvent = { _tag: "failed" };

/**
 * The `transform` of the `hostStats` subscription atom.
 *
 * - The atom keeps only the last value a stream chunk carries, so the history
 *   is folded here, before the atom, where a snapshot and an update landing
 *   together both count.
 * - The RPC client drains transport failures itself and resubscribes on the
 *   next session, but ends the stream on anything else: a message it cannot
 *   decode, or a refusal. This fold marks the subscription failed, keeps the
 *   history, and subscribes again after `hostStatsRetryDelayMs`, so a host
 *   recovers while the dock stays open. The delay resets once an attempt
 *   delivers an update after its snapshot.
 */
export function accumulateHostStatsMessages<E, R>(
  messages: Stream.Stream<HostStatsMessage, E, R>,
  retry: HostStatsRetry = HOST_STATS_RETRY,
): Stream.Stream<HostStatsSubscription, never, R> {
  return Stream.suspend(() => {
    let failuresInARow = 0;
    const attempt = messages.pipe(
      Stream.map((message): HostStatsStreamEvent => {
        if (message.type === "sample") failuresInARow = 0;
        return { _tag: "message", message };
      }),
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.fromEffect(Effect.interrupt)
          : Stream.make(FAILED_EVENT),
      ),
    );
    const attempts = (): Stream.Stream<HostStatsStreamEvent, never, R> =>
      attempt.pipe(
        Stream.concat(
          Stream.suspend(() => {
            const delayMs = hostStatsRetryDelayMs(failuresInARow, retry);
            failuresInARow += 1;
            return Stream.fromEffect(Effect.sleep(delayMs)).pipe(
              Stream.drain,
              Stream.concat(attempts()),
            );
          }),
        ),
      );
    return attempts().pipe(
      Stream.mapAccumEffect(
        (): HostStatsSubscription => NEVER_SUBSCRIBED,
        (current, event) =>
          Effect.map(Clock.currentTimeMillis, (receivedAtLocal) => {
            const next: HostStatsSubscription =
              event._tag === "failed"
                ? { history: current.history, failed: true }
                : {
                    history: applyHostStatsMessage(current.history, event.message, receivedAtLocal),
                    failed: false,
                  };
            const changed = next.history !== current.history || next.failed !== current.failed;
            return changed ? ([next, [next]] as const) : ([current, []] as const);
          }),
      ),
    );
  });
}

/** Whether a server advertises the stream. Unknown until its config arrives. */
export function hasHostStatsCapability(presentation: EnvironmentPresentation): boolean | null {
  if (presentation.serverConfig === null) return null;
  return presentation.serverConfig.environment.capabilities.hostStats === true;
}

function hostState(
  presentation: EnvironmentPresentation,
  subscription: HostStatsSubscription,
  lastReadingAgeMs: number | null,
): HostStatsHostState {
  const history = subscription.history;
  if (history !== null && history.contractVersion !== HOST_STATS_CONTRACT_VERSION) {
    return "needs-update";
  }
  const connected = presentation.connection.phase === "connected";
  if (connected && hasHostStatsCapability(presentation) === false) return "needs-update";
  // Offline keeps and labels what was read; it never hides it.
  if (!connected) return "offline";
  // The subscription surfaces a message it cannot decode, or a refusal, as a
  // failure that never retries: with no sample read, waiting would be forever.
  if (lastReadingAgeMs === null) return subscription.failed ? "needs-update" : "pending";
  // Judged by sample age, never by the socket: a stalled server keeps it open.
  return lastReadingAgeMs > HOST_STATS_STALE_AFTER_MS ? "stale" : "live";
}

const NOT_AVAILABLE: HostStatsRow = {
  value: null,
  secondary: null,
  level: null,
  secondaryLevel: null,
  availability: "not-available",
  series: null,
  peakSeries: null,
  total: null,
};

function availableRow(
  value: number | null,
  level: HostStatsLevel,
  extras: Partial<
    Pick<HostStatsRow, "secondary" | "secondaryLevel" | "series" | "peakSeries" | "total">
  > = {},
): HostStatsRow {
  return {
    value,
    secondary: extras.secondary ?? null,
    level,
    secondaryLevel: extras.secondaryLevel ?? null,
    availability: "available",
    series: extras.series ?? null,
    peakSeries: extras.peakSeries ?? null,
    total: extras.total ?? null,
  };
}

function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

function levelOrOk(metric: HostStatsLevelMetric, value: number | null): HostStatsLevel {
  return value === null ? "ok" : hostStatsLevel(metric, value);
}

/** The busiest active GPU, matching how the server folds several GPUs into one bucket. */
function busiestActiveGpu(gpus: ReadonlyArray<HostStatsGpu> | null): HostStatsGpu | null {
  let busiest: HostStatsGpu | null = null;
  for (const gpu of gpus ?? []) {
    if (gpu.state !== "active") continue;
    if (busiest === null || (gpu.busyPercent ?? -1) > (busiest.busyPercent ?? -1)) busiest = gpu;
  }
  return busiest;
}

function sumOfPresent(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function projectRows(
  history: HostStatsHistory,
  seriesStartMs: number,
): Record<HostStatsRowId, HostStatsRow> {
  const slots = slotCount(history);
  const seriesOf = (pick: (bucket: HostStatsBucket) => number | null) => {
    const series: Array<number | null> = Array.from({ length: slots }, () => null);
    let hasValue = false;
    for (const bucket of history.buckets) {
      const slot = (bucket.start - seriesStartMs) / history.bucketMs;
      if (!Number.isInteger(slot) || slot < 0 || slot >= slots) continue;
      const value = pick(bucket);
      if (value === null) continue;
      series[slot] = value;
      hasValue = true;
    }
    return hasValue ? series : null;
  };

  const latest = history.latest;
  if (latest === null) {
    return {
      cpu: NOT_AVAILABLE,
      memory: NOT_AVAILABLE,
      swap: NOT_AVAILABLE,
      disk: NOT_AVAILABLE,
      gpu: NOT_AVAILABLE,
      temperature: NOT_AVAILABLE,
      network: NOT_AVAILABLE,
      agents: NOT_AVAILABLE,
      servers: NOT_AVAILABLE,
    };
  }

  const cpuCount = latest.cpuCount ?? history.host.cpuCount;
  const loadPerCore = latest.load1 !== null && cpuCount > 0 ? latest.load1 / cpuCount : null;
  const memoryPercent = percentOf(latest.memUsedBytes, latest.memTotalBytes);
  const swapPercent = percentOf(latest.swapUsedBytes, latest.swapTotalBytes);
  const diskPercent = percentOf(latest.diskUsedBytes, latest.diskTotalBytes);
  const diskFreeBytes =
    latest.diskTotalBytes === null || latest.diskUsedBytes === null
      ? null
      : latest.diskTotalBytes - latest.diskUsedBytes;
  const gpu = busiestActiveGpu(latest.gpus);
  const gpuMemoryPercent = gpu === null ? null : percentOf(gpu.vramUsedBytes, gpu.vramTotalBytes);
  const memTotal = latest.memTotalBytes;

  return {
    cpu:
      latest.cpuPercent === null
        ? NOT_AVAILABLE
        : availableRow(latest.cpuPercent, hostStatsLevel("cpuPercent", latest.cpuPercent), {
            secondary: latest.load1,
            secondaryLevel:
              loadPerCore === null ? null : hostStatsLevel("loadPerCore", loadPerCore),
            series: seriesOf((bucket) => bucket.cpuAvg),
            peakSeries: seriesOf((bucket) => bucket.cpuMax),
          }),
    memory:
      memoryPercent === null
        ? NOT_AVAILABLE
        : availableRow(memoryPercent, hostStatsLevel("memoryPercent", memoryPercent), {
            secondary: latest.memUsedBytes,
            total: latest.memTotalBytes,
            series: seriesOf((bucket) => percentOf(bucket.memUsedAvg, memTotal)),
          }),
    swap:
      swapPercent === null
        ? NOT_AVAILABLE
        : availableRow(swapPercent, hostStatsLevel("swapPercent", swapPercent), {
            secondary: latest.swapUsedBytes,
            total: latest.swapTotalBytes,
          }),
    disk:
      diskPercent === null
        ? NOT_AVAILABLE
        : availableRow(diskPercent, hostStatsLevel("diskPercent", diskPercent), {
            secondary: diskFreeBytes,
            total: latest.diskTotalBytes,
          }),
    gpu:
      gpu === null && latest.gpus?.some((candidate) => candidate.state === "sleeping")
        ? {
            ...NOT_AVAILABLE,
            availability: "sleeping",
            series: seriesOf((bucket) => bucket.gpuBusyAvg),
            peakSeries: seriesOf((bucket) => bucket.gpuBusyMax),
          }
        : gpu === null || (gpu.busyPercent === null && gpuMemoryPercent === null)
          ? NOT_AVAILABLE
          : availableRow(gpu.busyPercent, levelOrOk("gpuMemoryPercent", gpuMemoryPercent), {
              secondary: gpuMemoryPercent,
              series: seriesOf((bucket) => bucket.gpuBusyAvg),
              peakSeries: seriesOf((bucket) => bucket.gpuBusyMax),
            }),
    temperature:
      latest.cpuTemperatureC === null
        ? NOT_AVAILABLE
        : availableRow(
            latest.cpuTemperatureC,
            hostStatsLevel("cpuTemperatureC", latest.cpuTemperatureC),
            { series: seriesOf((bucket) => bucket.cpuTempMax) },
          ),
    network:
      latest.netRxBytesPerSec === null && latest.netTxBytesPerSec === null
        ? NOT_AVAILABLE
        : availableRow(latest.netRxBytesPerSec, "ok", {
            secondary: latest.netTxBytesPerSec,
            series: seriesOf((bucket) => sumOfPresent(bucket.netRxAvg, bucket.netTxAvg)),
          }),
    agents:
      latest.agentsRunning === null
        ? NOT_AVAILABLE
        : availableRow(latest.agentsRunning, "ok", {
            secondary: latest.agentSessionsOpen,
            series: seriesOf((bucket) => bucket.agentsRunningMax),
          }),
    servers:
      latest.mesuraServers === null
        ? NOT_AVAILABLE
        : availableRow(latest.mesuraServers.installed, "ok", {
            secondary: latest.mesuraServers.dev,
          }),
  };
}

function projectHost(
  environmentId: EnvironmentId,
  presentation: EnvironmentPresentation,
  subscription: HostStatsSubscription,
  nowLocal: number,
): HostStatsHostView {
  const target = presentation.entry.target;
  const history = subscription.history;
  // Every age is measured on the host's own clock, so skew between machines cancels out.
  const hostNow = history === null ? null : nowLocal + history.offsetMs;
  const latest = history?.latest ?? null;
  const lastReadingAgeMs =
    hostNow === null || latest === null ? null : Math.max(0, hostNow - latest.sampledAt);
  const state = hostState(presentation, subscription, lastReadingAgeMs);
  const readable = state !== "needs-update" && history !== null && hostNow !== null;
  const seriesStartMs = readable ? windowStart(history, hostNow) : null;
  return {
    environmentId,
    label: target.label,
    isPrimary: target._tag === "PrimaryConnectionTarget",
    connected: presentation.connection.phase === "connected",
    platform: history?.host.platform ?? null,
    uptimeMs:
      history === null || hostNow === null ? null : Math.max(0, hostNow - history.host.bootedAt),
    state,
    lastReadingAgeMs,
    seriesStartMs,
    bucketMs: readable ? history.bucketMs : null,
    rows: readable ? projectRows(history, seriesStartMs!) : null,
  };
}

function compareHosts(left: HostStatsHostView, right: HostStatsHostView): number {
  if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
  return (
    left.label.localeCompare(right.label) || left.environmentId.localeCompare(right.environmentId)
  );
}

/**
 * One view per environment in the catalog, primary first, then by label. An
 * environment removed from the catalog disappears even if its history is held.
 */
export function projectHostStats(input: ProjectHostStatsInput): ReadonlyArray<HostStatsHostView> {
  const views: HostStatsHostView[] = [];
  for (const [environmentId, presentation] of input.presentations) {
    views.push(
      projectHost(
        environmentId,
        presentation,
        input.subscriptions.get(environmentId) ?? NEVER_SUBSCRIBED,
        input.nowLocal,
      ),
    );
  }
  return views.sort(compareHosts);
}
