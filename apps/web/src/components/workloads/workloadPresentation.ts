import type {
  WorkloadControlInput,
  WorkloadControlRefusal,
  WorkloadControlResult,
  WorkloadSummary,
} from "@t3tools/contracts";

const refusals = {
  "invalid-input": "The workload request is invalid.",
  "registry-unavailable": "The workload registry is unavailable.",
  "record-unavailable": "The workload record is unavailable.",
  "stale-generation": "The workload changed. Refresh and select the action again.",
  "snapshot-changed":
    "The workload changed during the request. Refresh and select the action again.",
  "owner-unavailable": "The owning thread is unavailable.",
  "owner-mismatch": "The owning thread changed.",
  "unsupported-host": "This host does not support workload controls.",
  "handoff-unavailable": "This host cannot safely hand off the control request.",
  "lock-unavailable": "Another request holds the workload lock.",
  deadline: "The request reached its time limit.",
  "manager-unknown": "The host cannot verify the workload state.",
  "binding-mismatch": "The running workload does not match its record.",
  "unit-loaded": "The workload is still loaded. Stop it before starting again.",
  "invalid-launch": "The recorded launch is invalid.",
  "replay-context-unavailable": "The original launch context is unavailable.",
  "wrapper-environment-incompatible": "This host cannot restore the original launch environment.",
} satisfies Record<WorkloadControlRefusal, string>;

export function workloadControlNotice(result: WorkloadControlResult) {
  switch (result.status) {
    case "completed":
      return result.operation === "stop"
        ? {
            title: result.result === "already-stopped" ? "Already stopped" : "Stopped",
            detail: `Host state: ${result.managerState}.`,
            tone: "neutral" as const,
          }
        : {
            title: "Start admitted",
            detail: `Registration: ${result.registration}. Host state: ${result.managerState}. Refreshing the current generation.`,
            tone: "neutral" as const,
          };
    case "refused":
      return {
        title: `${result.operation === "start" ? "Start" : "Stop"} refused`,
        detail: refusals[result.reason],
        tone: "warning" as const,
      };
    case "admission-rejected":
      return {
        title: "Start rejected",
        detail:
          "The host attempted admission and rejected the launch. The retained record did not change.",
        tone: "warning" as const,
      };
    case "partial":
      return result.operation === "stop"
        ? {
            title: "Stop outcome incomplete",
            detail: `Host state: ${result.managerState}. Refresh before another action.`,
            tone: "warning" as const,
          }
        : {
            title: "Start outcome incomplete",
            detail: `Stage: ${result.stage}. Admission: ${result.admission}. Registration: ${result.registration}. Host state: ${result.managerState}.`,
            tone: "warning" as const,
          };
  }
}

export function workloadControlInput(row: WorkloadSummary): WorkloadControlInput | null {
  return row.association.state === "assigned" && row.association.threadId !== null
    ? {
        recordId: row.recordId,
        expectedGeneration: row.generation,
        threadId: row.association.threadId,
      }
    : null;
}

export function workloadControlAvailability(row: WorkloadSummary) {
  const operation = row.managerState === "running" ? ("stop" as const) : ("start" as const);
  if (workloadControlInput(row) === null)
    return { operation, available: false, reason: "Unassigned workload; controls unavailable." };
  if (row.managerState === "unknown")
    return { operation, available: false, reason: "Workload state unavailable." };
  if (
    !row.controlsAvailable ||
    row.binding === "mismatched" ||
    row.binding === "unverified" ||
    row.binding === "unknown" ||
    row.registration !== "observed"
  ) {
    return {
      operation,
      available: false,
      reason: "The host cannot verify this workload for control.",
    };
  }
  return { operation, available: true, reason: null };
}

export function workloadRamLabel(bytes: number | null): string {
  if (bytes === null) return "RAM unavailable";
  if (bytes === 0) return "0 B RAM";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB RAM`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB RAM`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB RAM`;
}
