import { type OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  capacityRetryRemainingMs,
  capacityRetryView,
  formatCountdown,
} from "./capacityRetry.logic";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

const startedAt = DateTime.makeUnsafe("2026-11-04T12:00:00.000Z");
const updatedAt = DateTime.makeUnsafe("2026-11-04T12:01:10.000Z");

const capacityItem = (overrides: Partial<ErrorTurnItem> = {}): ErrorTurnItem => ({
  id: TurnItemId.make("item-capacity"),
  threadId: ThreadId.make("thread-capacity"),
  runId: RunId.make("run-capacity"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: "Provider retry",
  startedAt,
  completedAt: null,
  updatedAt,
  type: "error",
  failure: {
    class: "provider_error",
    message: "Selected model is at capacity. Please try a different model.",
    code: "serverOverloaded",
    retryable: true,
  },
  retry: { attempt: 3, maxAttempts: 10, retryDelayMs: 40_000 },
  ...overrides,
});

describe("capacityRetryView", () => {
  it("schedules the next attempt from the row's last update and marks the ladder", () => {
    const view = capacityRetryView(capacityItem());
    expect(view).toMatchObject({ label: "Model at capacity", detail: null, attempt: 3 });
    expect(view?.nextAttemptAtMs).toBe(DateTime.toEpochMillis(updatedAt) + 40_000);
    expect(view?.steps.map((step) => `${step.label}:${step.state}`)).toEqual([
      "10s:done",
      "20s:done",
      "40s:current",
      "1m:pending",
      "2m:pending",
      "5m:pending",
      "10m:pending",
      "20m:pending",
      "40m:pending",
      "60m:pending",
    ]);
  });

  it("describes each way the wait ends", () => {
    expect(
      capacityRetryView(capacityItem({ status: "completed", completedAt: updatedAt })),
    ).toMatchObject({
      label: "Provider recovered",
      detail: "after 3 retries",
      nextAttemptAtMs: null,
    });
    expect(
      capacityRetryView(
        capacityItem({
          status: "failed",
          updatedAt: DateTime.makeUnsafe("2026-11-04T14:18:30.000Z"),
          retry: { attempt: 10, maxAttempts: 10, retryDelayMs: 3_600_000 },
        }),
      ),
    ).toMatchObject({
      label: "Model at capacity",
      detail:
        "gave up after 10/10 retries · 2h 18m 30s. Selected model is at capacity. Please try a different model.",
    });
    const stopped = capacityRetryView(capacityItem({ status: "interrupted" }));
    expect(stopped).toMatchObject({ label: "Provider retry stopped", detail: "at retry 3/10" });
    expect(stopped?.steps).toEqual([]);
  });

  it("leaves other provider errors to the upstream row", () => {
    expect(
      capacityRetryView(
        capacityItem({ failure: { ...capacityItem().failure, code: "api_error_529" } }),
      ),
    ).toBeNull();
    const { retry: _retry, ...withoutRetry } = capacityItem();
    expect(capacityRetryView(withoutRetry)).toBeNull();
  });

  it("hides the ladder when the server runs another schedule", () => {
    const view = capacityRetryView(
      capacityItem({ retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 4_000 } }),
    );
    expect(view?.steps).toEqual([]);
    expect(view?.nextAttemptAtMs).toBe(DateTime.toEpochMillis(updatedAt) + 4_000);
  });
});

describe("formatCountdown", () => {
  it("rounds up to whole seconds and never goes negative", () => {
    expect(formatCountdown(39_001)).toBe("0:40");
    expect(formatCountdown(725_000)).toBe("12:05");
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});

describe("capacityRetryRemainingMs", () => {
  it("never shows more than the scheduled delay or less than zero", () => {
    const view = capacityRetryView(capacityItem())!;
    const deadline = DateTime.toEpochMillis(updatedAt) + 40_000;
    expect(capacityRetryRemainingMs(view, deadline - 15_000)).toBe(15_000);
    // A device clock an hour behind the server's.
    expect(capacityRetryRemainingMs(view, deadline - 3_600_000)).toBe(40_000);
    // A device clock ahead of the server's.
    expect(capacityRetryRemainingMs(view, deadline + 600_000)).toBe(0);
  });
});
