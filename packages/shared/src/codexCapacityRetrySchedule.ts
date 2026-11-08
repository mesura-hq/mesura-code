// Mesura: Sol capacity outages lasted from 15 seconds to about 90 minutes between
// 2026-10-12 and 2026-11-04, so the retry outlasts upstream's 2-30 s schedule.
export const CODEX_CAPACITY_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  10_000, 20_000, 40_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000,
];

/** The failure code Codex reports for "Selected model is at capacity". */
export const CODEX_CAPACITY_FAILURE_CODE = "serverOverloaded";

export const CODEX_CAPACITY_MAX_RETRIES = CODEX_CAPACITY_RETRY_DELAYS_MS.length;

export function codexCapacityRetryDelayMs(attempt: number): number {
  return CODEX_CAPACITY_RETRY_DELAYS_MS[Math.min(attempt, CODEX_CAPACITY_MAX_RETRIES) - 1] ?? 0;
}
