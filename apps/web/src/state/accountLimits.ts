/** Multi-environment projection for provider subscription limits. */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  accountLimitsNamespaceOf,
  accountLimitsWindowKey,
  isFoldableSubscriptionKey,
  type AccountLimitsNamespace,
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
  | "stale-refresh-failed"
  /** The reading arrived and this version could not parse it — our bug. */
  | "not-understood";

/** One window as it will be rendered, dated by the environment that reported it. */
export interface AccountLimitsRowWindow {
  readonly window: AccountLimitsWindow;
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
  /** The agent that read it, when one did. Absent on a directly polled plan. */
  readonly driver?: ProviderDriverKind | undefined;
  /** The subscription's own name, e.g. "OpenCode Go" — not the agent's. */
  readonly providerLabel: string;
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

/**
 * The newest reading of each subscription an environment reported.
 *
 * Keyed by the subscription, never by the instance that read it. Keying by the
 * instance collapses two DIFFERENT subscriptions that one agent reads into one
 * — which is the whole OpenCode case, where a single instance drives several
 * plans and the second silently replaced the first.
 */
function newestSnapshotsBySubscription(
  snapshots: ReadonlyArray<AccountLimitsSnapshot>,
): ReadonlyMap<string, AccountLimitsSnapshot> {
  const newest = new Map<string, AccountLimitsSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshot.subscription.key;
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
  // "We could not understand it" is our bug and reads differently from an
  // outage, so it outranks the generic failed state rather than hiding inside it.
  if (snapshot?.lastAttempt.status === "failed" && snapshot.lastAttempt.reason === "unrecognized") {
    return "not-understood";
  }
  if (snapshot === null || snapshot.observation === null) {
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
  // Above the stale failure on purpose: "we could not parse it" names a bug
  // somebody can act on, while a stale failure only says the last try missed.
  // It carries no staleness of its own, so age never demotes it.
  "not-understood",
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

/**
 * What a subscription is called, and the account it belongs to.
 *
 * The vendor names the row — "Claude", not the address it is registered to —
 * because that is what a person recognises at a glance. The address is a
 * disambiguator, so it becomes the subtitle and only shows when two rows of the
 * same vendor would otherwise read alike.
 *
 * A subscription the vendor named itself, like a plan, already carries the
 * right title in its label and keeps it.
 */
const VENDOR_NAME: Readonly<Record<AccountLimitsNamespace, string>> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  "opencode-go": "OpenCode Go",
  zai: "GLM Coding Plan",
};

function subscriptionPresentation(subscription: { readonly key: string; readonly label: string }): {
  readonly title: string;
  readonly accountName: string | null;
} {
  const namespace = accountLimitsNamespaceOf(subscription.key);
  if (namespace === null) return { title: subscription.label, accountName: null };
  const title = VENDOR_NAME[namespace];
  // The label repeats the title for a plan the vendor named, and only differs
  // when it is an account address — which is exactly when it is worth showing.
  return { title, accountName: subscription.label === title ? null : subscription.label };
}

/**
 * Whether this agent ever reports account limits, and so deserves a row saying
 * it has not reported one yet.
 *
 * HACK: the client should not know which drivers these are. The honest answer
 * is a capability on the provider snapshot the server already builds, since the
 * server is the only side that knows which drivers implement the reader. This
 * list exists because adding that capability means touching the provider
 * contract and every driver's snapshot, which is more than this change carries.
 * Remove it once `ServerProvider` carries the capability.
 *
 * Note this gate applies ONLY to the placeholder pass. A reading that actually
 * arrived is shown whatever produced it — the server does not send one for a
 * driver it cannot read, so the readings need no allowlist and must not get one.
 */
function reportsAccountLimits(driver: ProviderDriverKind): boolean {
  return driver === "claudeAgent" || driver === "codex";
}

/**
 * Whether this instance belongs in the panel at all.
 *
 * An instance whose CLI is missing answers every read with a failure, and a row
 * that says "Refresh failed" forever reads as a broken subscription rather than
 * as a provider that is not installed here. But `ready` is a narrow bar — an
 * instance can sit at `warning` and still be the one metering the account — so
 * a reading we already hold keeps its row whatever the probe currently says.
 */
function canReportAccountLimits(
  entry: ProviderInstanceEntry | undefined,
  snapshot: AccountLimitsSnapshot | null,
): boolean {
  // The reader named an instance this environment no longer lists.
  if (entry === undefined) return false;
  return isProviderInstancePickerReady(entry) || snapshot?.observation != null;
}

interface AccountLimitsCandidate {
  readonly groupKey: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly environmentNowMs: number | null;
  readonly driver?: ProviderDriverKind | undefined;
  /** The subscription's name, which is what the row is titled by. */
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly snapshot: AccountLimitsSnapshot | null;
  readonly state: AccountLimitsRowState;
  /** The account the provider named, when it named one. */
  readonly accountName: string | null;
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
      const key = accountLimitsWindowKey(rowWindow.window);
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
function leadCandidate(candidates: ReadonlyArray<AccountLimitsCandidate>): AccountLimitsCandidate {
  // A group only exists because a candidate was pushed into it, so the sort
  // always has something to return.
  return [...candidates].sort((left, right) => {
    const leftAge = left.readingAgeMs ?? Number.POSITIVE_INFINITY;
    const rightAge = right.readingAgeMs ?? Number.POSITIVE_INFINITY;
    return leftAge - rightAge;
  })[0]!;
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
    const snapshots = newestSnapshotsBySubscription(environment.summary.snapshots);
    const currentEnvironmentTime = environmentNowMs(environment, nowMs);
    // Walk the subscriptions the environment reported, not the agents it has
    // configured. An agent is one way a subscription gets read, and some are
    // read by none — so iterating agents would drop exactly the new rows.
    const entriesByInstance = new Map(
      deriveProviderInstanceEntries(environment.providers).map((entry) => [
        String(entry.instanceId),
        entry,
      ]),
    );
    // Every instance that reported anything, taken before the dedup: one whose
    // reading lost to a fresher one for the same subscription still reported,
    // and giving it a second "no reading yet" row would double the account.
    const readInstances = new Set(
      environment.summary.snapshots.flatMap((snapshot) =>
        snapshot.reader === undefined ? [] : [String(snapshot.reader.providerInstanceId)],
      ),
    );
    for (const snapshot of snapshots.values()) {
      const reader = snapshot.reader;
      const entry =
        reader === undefined ? undefined : entriesByInstance.get(String(reader.providerInstanceId));
      // A reader this environment no longer lists costs the row its icon, not
      // its existence: the numbers are still a real subscription's, and
      // dropping it would blink a row out on a reconnect race.
      if (entry !== undefined && !canReportAccountLimits(entry, snapshot)) continue;
      // A reading the server marked unfoldable keys on the environment plus its
      // own key, never on the instance that read it. The server already tells
      // several unnamed plans from one instance apart by an ordinal in that
      // key, and keying on the instance would throw that away and merge two
      // subscriptions' windows under one label. The `#env:` prefix keeps these
      // apart from real keys, which always start with a vendor namespace.
      const foldable = isFoldableSubscriptionKey(snapshot.subscription.key)
        ? snapshot.subscription
        : null;
      const presentation = subscriptionPresentation(snapshot.subscription);
      const partial = {
        groupKey: foldable?.key ?? `#env:${environment.environmentId}:${snapshot.subscription.key}`,
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        environmentNowMs: Number.isFinite(currentEnvironmentTime) ? currentEnvironmentTime : null,
        ...(reader && entry ? { driver: reader.driver } : {}),
        displayName: presentation.title,
        ...(entry?.accentColor ? { accentColor: entry.accentColor } : {}),
        snapshot,
        state: rowState(snapshot, currentEnvironmentTime),
        accountName: presentation.accountName,
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

    // An agent that is configured but has produced no reading yet still gets a
    // row, saying so. Walking only the subscriptions would drop it, and a
    // freshly configured Claude vanishing from the panel reads as broken.
    //
    // Only agents that actually report limits, though. An agent that never
    // will — Cursor, Grok — would otherwise hold a "No reading yet" row for
    // ever, since the thing that clears one is a reading arriving.
    for (const entry of deriveProviderInstanceEntries(environment.providers)) {
      if (!reportsAccountLimits(entry.driverKind)) continue;
      if (readInstances.has(String(entry.instanceId))) continue;
      if (!canReportAccountLimits(entry, null)) continue;
      const partial = {
        groupKey: `#env:${environment.environmentId}:${entry.instanceId}`,
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        environmentNowMs: Number.isFinite(currentEnvironmentTime) ? currentEnvironmentTime : null,
        driver: entry.driverKind,
        displayName: entry.displayName,
        ...(entry.accentColor ? { accentColor: entry.accentColor } : {}),
        snapshot: null,
        state: rowState(null, currentEnvironmentTime),
        accountName: null,
      } satisfies Omit<AccountLimitsCandidate, "windows" | "readingAgeMs">;
      const candidate: AccountLimitsCandidate = {
        ...partial,
        windows: [],
        readingAgeMs: null,
      };
      const group = groups.get(candidate.groupKey);
      if (group) group.push(candidate);
      else groups.set(candidate.groupKey, [candidate]);
    }
  }

  const rows = [...groups].map(([key, candidates]) => {
    const lead = leadCandidate(candidates);
    const windows = freshestWindows(candidates);
    return {
      key,
      driver: lead.driver,
      providerLabel: lead.displayName,
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
      accountName: lead.accountName,
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
  readonly accountName: string | null;
}

/**
 * A row only needs a subtitle when another row would read the same. Two Codex
 * instances the user already named apart tell themselves apart, so counting per
 * driver rather than per rendered title would put an address under both of them
 * for nothing.
 */
function withSubtitles(rows: ReadonlyArray<RowDraft>): ReadonlyArray<AccountLimitsRow> {
  const titleOf = (row: { readonly driver?: string | undefined; readonly providerLabel: string }) =>
    `${row.driver ?? "-"}:${row.providerLabel}`;
  const titles = new Map<string, number>();
  for (const row of rows) {
    titles.set(titleOf(row), (titles.get(titleOf(row)) ?? 0) + 1);
  }
  return rows.map(({ accountName, ...row }) => {
    if ((titles.get(titleOf(row)) ?? 0) < 2) return { ...row, subtitle: null };
    const environmentLabels = [...new Set(row.environments.map((entry) => entry.label))];
    return {
      ...row,
      subtitle: accountName ?? environmentLabels.join(", "),
    };
  });
}

/** Exported for its unit test; `candidateWindows` above is the only caller. */
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
