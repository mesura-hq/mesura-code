import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  CODEX_CAPACITY_FAILURE_CODE,
  CODEX_CAPACITY_RETRY_DELAYS_MS,
} from "@t3tools/shared/codexCapacityRetrySchedule";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

export type CapacityRetryStepState = "done" | "current" | "pending";

export interface CapacityRetryView {
  readonly label: string;
  /** Text after the label; null while waiting, where the countdown takes its place. */
  readonly detail: string | null;
  readonly attempt: number;
  readonly maxAttempts: number | null;
  /** Set only while a retry is scheduled. */
  readonly nextAttemptAtMs: number | null;
  readonly retryDelayMs: number | null;
  /** Only while waiting, and only for the schedule this client knows. */
  readonly steps: ReadonlyArray<{ readonly label: string; readonly state: CapacityRetryStepState }>;
}

/** Mesura: the capacity retry row (Codex "Selected model is at capacity"), or null for any other error. */
export function capacityRetryView(item: ErrorTurnItem): CapacityRetryView | null {
  const retry = item.retry;
  if (retry === undefined || item.failure.code !== CODEX_CAPACITY_FAILURE_CODE) return null;
  const progress =
    retry.maxAttempts === null ? `${retry.attempt}` : `${retry.attempt}/${retry.maxAttempts}`;
  const waiting = item.status === "running";
  const nextAttemptAtMs =
    waiting && retry.retryDelayMs !== null
      ? DateTime.toEpochMillis(item.updatedAt) + retry.retryDelayMs
      : null;
  const steps =
    waiting && retry.maxAttempts === CODEX_CAPACITY_RETRY_DELAYS_MS.length
      ? CODEX_CAPACITY_RETRY_DELAYS_MS.map((delayMs, index) => ({
          label: formatRetryStep(delayMs),
          state: stepState(index, retry.attempt),
        }))
      : [];
  const base = {
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    nextAttemptAtMs,
    retryDelayMs: retry.retryDelayMs,
    steps,
  };
  switch (item.status) {
    case "running":
      return { ...base, label: "Model at capacity", detail: null };
    case "completed":
      return {
        ...base,
        label: "Provider recovered",
        detail: `after ${retry.attempt} ${retry.attempt === 1 ? "retry" : "retries"}`,
      };
    case "failed":
      return {
        ...base,
        label: "Model at capacity",
        detail: `gave up after ${progress} retries${
          item.startedAt === null
            ? ""
            : ` · ${formatDuration(
                DateTime.toEpochMillis(item.updatedAt) - DateTime.toEpochMillis(item.startedAt),
              )}`
        }. ${item.failure.message}`,
      };
    default:
      return { ...base, label: "Provider retry stopped", detail: `at retry ${progress}` };
  }
}

function stepState(index: number, attempt: number): CapacityRetryStepState {
  if (index < attempt - 1) return "done";
  return index === attempt - 1 ? "current" : "pending";
}

function formatRetryStep(delayMs: number): string {
  return delayMs < 60_000 ? `${delayMs / 1_000}s` : `${delayMs / 60_000}m`;
}

/**
 * Time left on the wait. The deadline is server time and `nowMs` is this device's clock, which
 * NTP keeps within a second on the developer's devices; the cap keeps a slow clock from
 * showing more than the scheduled delay.
 */
export function capacityRetryRemainingMs(view: CapacityRetryView, nowMs: number): number {
  if (view.nextAttemptAtMs === null) return 0;
  const remainingMs = Math.max(0, view.nextAttemptAtMs - nowMs);
  return view.retryDelayMs === null ? remainingMs : Math.min(remainingMs, view.retryDelayMs);
}

/** "0:40", "12:05", "1:00:00": whole seconds left, never negative. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
