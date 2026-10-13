import { describe, expect, it } from "vite-plus/test";
import { WorkloadControlRefusal } from "@t3tools/contracts";
import { controlOutcomes, RECORD, THREAD, workload } from "../../state/workloads.testkit";
import {
  workloadControlAvailability,
  workloadControlInput,
  workloadControlNotice,
  workloadRamLabel,
} from "./workloadPresentation";

const identity = { recordId: RECORD };
describe("workload control presentation", () => {
  it.each(controlOutcomes)("distinguishes the %j outcome", (result, title, detail) => {
    const notice = workloadControlNotice(result);
    expect(notice.title).toBe(title);
    expect(notice.detail).toContain(detail);
  });
  it.each(WorkloadControlRefusal.literals)(
    "explains refusal %s without claiming a mutation",
    (reason) => {
      const notice = workloadControlNotice({
        ...identity,
        status: "refused",
        operation: "start",
        reason,
        mutationAttempted: false,
        managerState: "unknown",
      });
      expect(notice.title).toBe("Start refused");
      expect(notice.detail.length).toBeGreaterThan(10);
      expect(notice.tone).toBe("warning");
    },
  );
  it("takes the current record and owner, and cannot control an unassigned record", () => {
    expect(workloadControlInput(workload())).toEqual({
      recordId: RECORD,
      threadId: THREAD,
    });
    const unassigned = workload({
      association: { state: "unassigned", threadId: null, reason: "ambiguous" },
    });
    expect(workloadControlInput(unassigned)).toBeNull();
    expect(workloadControlAvailability(unassigned).available).toBe(false);
  });
  it("keeps unavailable host controls disabled", () => {
    expect(workloadControlAvailability(workload({ controlsAvailable: false })).available).toBe(
      false,
    );
  });
  it("keeps an unknown state unavailable and selects replay for a stopped record", () => {
    expect(workloadControlAvailability(workload({ managerState: "unknown" })).available).toBe(
      false,
    );
    expect(workloadControlAvailability(workload({ managerState: "stopped" }))).toEqual({
      operation: "start",
      available: true,
      reason: null,
    });
  });
  it("distinguishes an unavailable reading from a measured zero", () => {
    expect(workloadRamLabel(null)).toBe("RAM unavailable");
    expect(workloadRamLabel(0)).toBe("0 B RAM");
    expect(workloadRamLabel(16 * 1024 * 1024)).toBe("16 MiB RAM");
  });
});
