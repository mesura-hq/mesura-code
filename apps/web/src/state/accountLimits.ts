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
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const ACCOUNT_LIMITS_STALE_AFTER_MS = 5 * 60 * 1000;
const SPARK_METER_ID = "codex_bengalfox";

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

export interface AccountLimitsRow {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly accountLabel: string;
  readonly accentColor?: string | undefined;
  readonly snapshot: AccountLimitsSnapshot | null;
  readonly state: AccountLimitsRowState;
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

function environmentNowMs(environment: EnvironmentAccountLimitsInput, clientNowMs: number): number {
  if (environment.summary === null || environment.receivedAtMs === null) {
    return Number.POSITIVE_INFINITY;
  }
  const readAt = timestampMillis(environment.summary.readAt);
  if (readAt === Number.NEGATIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return readAt + Math.max(0, clientNowMs - environment.receivedAtMs);
}

function isSupportedDriver(driver: ProviderDriverKind): boolean {
  return driver === "claudeAgent" || driver === "codex";
}

export function projectAccountLimits(
  inputs: ReadonlyArray<EnvironmentAccountLimitsInput>,
  nowMs: number,
): AccountLimitsProjection {
  const environments = inputs.map((input) => ({ ...input, state: environmentState(input) }));
  const rows: AccountLimitsRow[] = [];

  for (const environment of environments) {
    if (environment.state !== "ready" || environment.summary === null) continue;
    const snapshots = newestSnapshotsByInstance(environment.summary.snapshots);
    const currentEnvironmentTime = environmentNowMs(environment, nowMs);
    for (const entry of deriveProviderInstanceEntries(environment.providers)) {
      if (!entry.enabled || !entry.isAvailable || !isSupportedDriver(entry.driverKind)) continue;
      const candidate = snapshots.get(String(entry.instanceId));
      const snapshot = candidate?.driver === entry.driverKind ? candidate : null;
      rows.push({
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        providerInstanceId: entry.instanceId,
        driver: entry.driverKind,
        accountLabel: entry.displayName,
        accentColor: entry.accentColor,
        snapshot,
        state: rowState(snapshot, currentEnvironmentTime),
      });
    }
  }

  const readyCount = environments.filter((environment) => environment.state === "ready").length;
  const pendingCount = environments.filter((environment) => environment.state === "pending").length;
  return {
    environments,
    rows,
    isPending: readyCount === 0 && pendingCount > 0,
    isPartial: readyCount > 0 && environments.some((environment) => environment.state !== "ready"),
  };
}

export function selectVisibleAccountLimitWindows(
  windows: ReadonlyArray<AccountLimitsWindow>,
): ReadonlyArray<AccountLimitsWindow> {
  return windows.filter((window) => window.meter?.id !== SPARK_METER_ID);
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
