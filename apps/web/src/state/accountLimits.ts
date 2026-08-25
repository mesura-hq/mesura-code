/** Multi-environment projection for provider subscription limits. */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  type AccountLimitsSnapshot,
  type AccountLimitsSummary,
  type AccountLimitsWindow,
  type EnvironmentId,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const ACCOUNT_LIMITS_STALE_AFTER_MS = 5 * 60 * 1000;
const SPARK_METER_IDS = new Set(["codex_bengalfox", "codex_spark"]);
const SPARK_METER_LABEL = "GPT-5.3-Codex-Spark";
const HIDDEN_CLAUDE_PLACEHOLDER_METER_IDS = new Set(["nimbus_quill"]);

export interface EnvironmentAccountLimitsInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: AccountLimitsSummary | null;
  readonly receivedAtMs: number | null;
}

export type EnvironmentAccountLimitsState =
  | "pending"
  | "disconnected"
  | "error"
  | "unsupported-contract"
  | "ready";

export interface EnvironmentAccountLimitsStatus extends EnvironmentAccountLimitsInput {
  readonly state: EnvironmentAccountLimitsState;
}

export type AccountLimitsRowState =
  | "missing"
  | "current"
  | "stale"
  | "refresh-failed"
  | "stale-refresh-failed";

/** One window as it will be rendered, with the environment that reported it. */
export interface AccountLimitsRowWindow {
  readonly window: AccountLimitsWindow;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** The reporting environment's current time, for the reset countdown. */
  readonly environmentNowMs: number | null;
  /** How old this number is on the environment that reported it. */
  readonly ageMs: number | null;
}

export interface AccountLimitsRowEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * One subscription, as one row, whatever number of environments report it.
 */
export interface AccountLimitsRow {
  /** Group identity: the account key when the provider named one. */
  readonly key: string;
  readonly driver: ProviderDriverKind;
  /** The provider instance's display name, e.g. "Claude". */
  readonly accountLabel: string;
  readonly accentColor?: string | undefined;
  readonly plan: string | null;
  /**
   * What tells this row apart from the other rows of the same provider: the
   * account the provider named, or the environment when it named none. Null
   * when the provider has one row and nothing needs telling apart.
   */
  readonly subtitle: string | null;
  readonly environments: ReadonlyArray<AccountLimitsRowEnvironment>;
  readonly windows: ReadonlyArray<AccountLimitsRowWindow>;
  readonly state: AccountLimitsRowState;
  /** Age of the freshest number in this row. */
  readonly readingAgeMs: number | null;
}

export interface AccountLimitsProjection {
  readonly environments: ReadonlyArray<EnvironmentAccountLimitsStatus>;
  readonly rows: ReadonlyArray<AccountLimitsRow>;
  readonly isPending: boolean;
  readonly isPartial: boolean;
}

function environmentState(input: EnvironmentAccountLimitsInput): EnvironmentAccountLimitsState {
  if (input.summary !== null && input.summary.contractVersion !== ACCOUNT_LIMITS_CONTRACT_VERSION) {
    return "unsupported-contract";
  }
  if (input.connectionPhase !== "connected") return "disconnected";
  if (input.error !== null) return "error";
  if (input.summary !== null) return "ready";
  return input.isPending ? "pending" : "error";
}

function timestampMillis(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function newestSnapshotsByInstance(
  snapshots: ReadonlyArray<AccountLimitsSnapshot>,
): ReadonlyMap<string, AccountLimitsSnapshot> {
  const newest = new Map<string, AccountLimitsSnapshot>();
  for (const snapshot of snapshots) {
    const key = String(snapshot.providerInstanceId);
    const previous = newest.get(key);
    if (
      previous === undefined ||
      timestampMillis(snapshot.lastAttempt.attemptedAt) >=
        timestampMillis(previous.lastAttempt.attemptedAt)
    ) {
      newest.set(key, snapshot);
    }
  }
  return newest;
}

function rowState(snapshot: AccountLimitsSnapshot | null, nowMs: number): AccountLimitsRowState {
  if (snapshot?.observation === null || snapshot === null) {
    return snapshot?.lastAttempt.status === "failed" ? "refresh-failed" : "missing";
  }
  const observedAt = timestampMillis(snapshot.observation.observedAt);
  const isStale =
    observedAt === Number.NEGATIVE_INFINITY || nowMs - observedAt >= ACCOUNT_LIMITS_STALE_AFTER_MS;
  if (snapshot.lastAttempt.status === "failed") {
    return isStale ? "stale-refresh-failed" : "refresh-failed";
  }
  return isStale ? "stale" : "current";
}

/**
 * Best first. A subscription read from two environments is only as broken as
 * its healthiest reading: one machine failing to refresh says nothing about the
 * numbers another machine just read from the same account.
 */
const ROW_STATE_ORDER: ReadonlyArray<AccountLimitsRowState> = [
  "current",
  "stale",
  "refresh-failed",
  "stale-refresh-failed",
  "missing",
];

function bestRowState(
  left: AccountLimitsRowState,
  right: AccountLimitsRowState,
): AccountLimitsRowState {
  return ROW_STATE_ORDER.indexOf(left) <= ROW_STATE_ORDER.indexOf(right) ? left : right;
}

function environmentNowMs(environment: EnvironmentAccountLimitsInput, clientNowMs: number): number {
  if (environment.summary === null || environment.receivedAtMs === null) {
    return Number.POSITIVE_INFINITY;
  }
  const readAt = timestampMillis(environment.summary.readAt);
  if (readAt === Number.NEGATIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return readAt + Math.max(0, clientNowMs - environment.receivedAtMs);
}

function ageMillis(observedAt: string | undefined, currentEnvironmentTime: number): number | null {
  if (observedAt === undefined) return null;
  const observed = timestampMillis(observedAt);
  if (!Number.isFinite(currentEnvironmentTime) || observed === Number.NEGATIVE_INFINITY) {
    return null;
  }
  return Math.max(0, currentEnvironmentTime - observed);
}

function isSupportedDriver(driver: ProviderDriverKind): boolean {
  return driver === "claudeAgent" || driver === "codex";
}

/**
 * Only a provider that could answer a limits read belongs in this panel. An
 * instance whose CLI is missing reports a refresh failure forever, which reads
 * as a broken subscription rather than as a provider that is not installed here.
 */
function canReportAccountLimits(entry: ProviderInstanceEntry): boolean {
  return isProviderInstancePickerReady(entry) && isSupportedDriver(entry.driverKind);
}

/** Windows are the same window across environments when their meter and id match. */
function windowKey(window: AccountLimitsWindow): string {
  return `${window.meter?.id ?? "primary"}:${window.id}`;
}

interface AccountLimitsCandidate {
  readonly groupKey: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly environmentNowMs: number | null;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly snapshot: AccountLimitsSnapshot | null;
  readonly state: AccountLimitsRowState;
  readonly accountLabel: string | null;
  readonly windows: ReadonlyArray<AccountLimitsRowWindow>;
  /** Age of this candidate's freshest window, for choosing what the row shows. */
  readonly readingAgeMs: number | null;
}

function candidateWindows(
  candidate: Omit<AccountLimitsCandidate, "windows" | "readingAgeMs">,
  currentEnvironmentTime: number,
): ReadonlyArray<AccountLimitsRowWindow> {
  const observation = candidate.snapshot?.observation ?? null;
  if (observation === null) return [];
  return selectVisibleAccountLimitWindows(observation.windows).map((window) => ({
    window,
    environmentId: candidate.environmentId,
    environmentLabel: candidate.environmentLabel,
    environmentNowMs: Number.isFinite(currentEnvironmentTime) ? currentEnvironmentTime : null,
    // A window carries its own date once the environment reports one. Older
    // environments date the whole observation, so fall back to that.
    ageMs: ageMillis(window.observedAt ?? observation.observedAt, currentEnvironmentTime),
  }));
}

/** Unknown age loses to any known age, so a dated reading always wins. */
function isFresher(candidate: AccountLimitsRowWindow, incumbent: AccountLimitsRowWindow): boolean {
  if (candidate.ageMs === null) return false;
  if (incumbent.ageMs === null) return true;
  return candidate.ageMs < incumbent.ageMs;
}

function freshestWindows(
  candidates: ReadonlyArray<AccountLimitsCandidate>,
): ReadonlyArray<AccountLimitsRowWindow> {
  const chosen = new Map<string, AccountLimitsRowWindow>();
  for (const candidate of candidates) {
    for (const rowWindow of candidate.windows) {
      const key = windowKey(rowWindow.window);
      const incumbent = chosen.get(key);
      if (incumbent === undefined || isFresher(rowWindow, incumbent)) chosen.set(key, rowWindow);
    }
  }
  return [...chosen.values()];
}

function smallestAge(ages: ReadonlyArray<number | null>): number | null {
  let smallest: number | null = null;
  for (const age of ages) {
    if (age === null) continue;
    if (smallest === null || age < smallest) smallest = age;
  }
  return smallest;
}

/**
 * The candidate whose numbers the row presents as its own — plan, provider
 * name, accent. The freshest reading wins so the row never labels itself from
 * a machine that has not talked to the provider in an hour.
 */
function leadCandidate(
  candidates: ReadonlyArray<AccountLimitsCandidate>,
): AccountLimitsCandidate | undefined {
  return [...candidates].sort((left, right) => {
    const leftAge = left.readingAgeMs ?? Number.POSITIVE_INFINITY;
    const rightAge = right.readingAgeMs ?? Number.POSITIVE_INFINITY;
    return leftAge - rightAge;
  })[0];
}

/**
 * Fold every environment's readings into one row per subscription.
 *
 * Two environments that drive the same account report the same account key, and
 * their readings are the same subscription seen at two moments — so they become
 * one row whose every window shows the freshest of the two. A reading with no
 * account key is never folded: it keeps its own row, labelled by environment,
 * which is what an environment too old to report an account still gets.
 */
export function projectAccountLimits(
  inputs: ReadonlyArray<EnvironmentAccountLimitsInput>,
  nowMs: number,
): AccountLimitsProjection {
  const environments = inputs.map((input) => ({ ...input, state: environmentState(input) }));
  const groups = new Map<string, AccountLimitsCandidate[]>();

  for (const environment of environments) {
    if (environment.state !== "ready" || environment.summary === null) continue;
    const snapshots = newestSnapshotsByInstance(environment.summary.snapshots);
    const currentEnvironmentTime = environmentNowMs(environment, nowMs);
    for (const entry of deriveProviderInstanceEntries(environment.providers)) {
      if (!canReportAccountLimits(entry)) continue;
      const stored = snapshots.get(String(entry.instanceId));
      const snapshot = stored?.driver === entry.driverKind ? stored : null;
      const partial = {
        // An unnamed account cannot be folded, so it keys on where it was read.
        groupKey: snapshot?.account?.key ?? `${environment.environmentId}:${entry.instanceId}`,
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        environmentNowMs: Number.isFinite(currentEnvironmentTime) ? currentEnvironmentTime : null,
        driver: entry.driverKind,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        snapshot,
        state: rowState(snapshot, currentEnvironmentTime),
        accountLabel: snapshot?.account?.label ?? null,
      } satisfies Omit<AccountLimitsCandidate, "windows" | "readingAgeMs">;
      const windows = candidateWindows(partial, currentEnvironmentTime);
      const candidate: AccountLimitsCandidate = {
        ...partial,
        windows,
        readingAgeMs: smallestAge(windows.map((rowWindow) => rowWindow.ageMs)),
      };
      const group = groups.get(candidate.groupKey);
      if (group) group.push(candidate);
      else groups.set(candidate.groupKey, [candidate]);
    }
  }

  const rows = [...groups].map(([key, candidates]) => {
    const lead = leadCandidate(candidates) ?? candidates[0]!;
    const windows = freshestWindows(candidates);
    return {
      key,
      driver: lead.driver,
      accountLabel: lead.displayName,
      accentColor: lead.accentColor,
      plan: lead.snapshot?.observation?.plan ?? null,
      subtitle: null,
      environments: candidates.map((candidate) => ({
        environmentId: candidate.environmentId,
        label: candidate.environmentLabel,
      })),
      windows,
      state: candidates.map((candidate) => candidate.state).reduce(bestRowState),
      readingAgeMs: smallestAge(windows.map((rowWindow) => rowWindow.ageMs)),
      accountLabelText: lead.accountLabel,
    };
  });

  const readyCount = environments.filter((environment) => environment.state === "ready").length;
  const pendingCount = environments.filter((environment) => environment.state === "pending").length;
  return {
    environments,
    rows: withSubtitles(rows),
    isPending: readyCount === 0 && pendingCount > 0,
    isPartial: readyCount > 0 && environments.some((environment) => environment.state !== "ready"),
  };
}

interface RowDraft extends Omit<AccountLimitsRow, "subtitle"> {
  readonly subtitle: null;
  /** The account the provider named, before we know whether it distinguishes. */
  readonly accountLabelText: string | null;
}

/**
 * A row only needs a subtitle when another row of the same provider would read
 * the same. Then the account name tells them apart, or the environments do when
 * no account was named.
 */
function withSubtitles(rows: ReadonlyArray<RowDraft>): ReadonlyArray<AccountLimitsRow> {
  const perDriver = new Map<string, number>();
  for (const row of rows) {
    perDriver.set(row.driver, (perDriver.get(row.driver) ?? 0) + 1);
  }
  return rows.map(({ accountLabelText, ...row }) => {
    if ((perDriver.get(row.driver) ?? 0) < 2) return { ...row, subtitle: null };
    const environmentLabels = [...new Set(row.environments.map((entry) => entry.label))];
    return {
      ...row,
      subtitle: accountLabelText ?? environmentLabels.join(", "),
    };
  });
}

export function selectVisibleAccountLimitWindows(
  windows: ReadonlyArray<AccountLimitsWindow>,
): ReadonlyArray<AccountLimitsWindow> {
  return windows.filter(
    (window) =>
      !SPARK_METER_IDS.has(window.meter?.id ?? "") &&
      !HIDDEN_CLAUDE_PLACEHOLDER_METER_IDS.has(window.meter?.id ?? "") &&
      window.meter?.label !== SPARK_METER_LABEL,
  );
}

const accountLimitsReceiptTimes = new WeakMap<AccountLimitsSummary, number>();

function accountLimitsReceiptTime(summary: AccountLimitsSummary): number {
  const existing = accountLimitsReceiptTimes.get(summary);
  if (existing !== undefined) return existing;
  const receivedAt = Date.now();
  accountLimitsReceiptTimes.set(summary, receivedAt);
  return receivedAt;
}

const environmentAccountLimitsAtom = Atom.make(
  (get): ReadonlyArray<EnvironmentAccountLimitsInput> => {
    const inputs: EnvironmentAccountLimitsInput[] = [];
    for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
      const result = get(serverEnvironment.accountLimits({ environmentId, input: {} }));
      const summary = Option.getOrNull(AsyncResult.value(result));
      inputs.push({
        environmentId,
        label: presentation.entry.target.label,
        connectionPhase: presentation.connection.phase,
        providers: presentation.serverConfig?.providers ?? [],
        isPending: result.waiting,
        error:
          result._tag === "Failure" ? "This environment could not report account limits." : null,
        summary,
        receivedAtMs: summary === null ? null : accountLimitsReceiptTime(summary),
      });
    }
    return inputs;
  },
).pipe(Atom.withLabel("web-account-limits:environments"));

export interface AccountLimitsView extends AccountLimitsProjection {
  readonly refresh: () => void;
}

export function useAccountLimits(): AccountLimitsView {
  const inputs = useAtomValue(environmentAccountLimitsAtom);
  const projection = projectAccountLimits(inputs, Date.now());
  const refresh = useCallback(() => {
    for (const environment of inputs) {
      appAtomRegistry.refresh(
        serverEnvironment.accountLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [inputs]);
  return { ...projection, refresh };
}
