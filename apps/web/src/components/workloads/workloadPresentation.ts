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
  "owner-unavailable": "The owning thread is unavailable.",
  "owner-mismatch": "The owning thread changed.",
  "unsupported-host": "This host does not support workload controls.",
  "wrapper-unavailable": "The workload launcher is unavailable on this host.",
  deadline: "The request reached its time limit.",
  "manager-unknown": "The host cannot verify the workload state.",
  "unit-loaded": "The workload is still loaded. Stop it before starting again.",
  "invalid-launch": "The recorded launch is invalid.",
  "replay-context-unavailable": "The saved launch context is unavailable.",
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
            title: "Start accepted",
            detail: `Launch recorded. Host state: ${result.managerState}. Refreshing workload state.`,
            tone: "neutral" as const,
          };
    case "refused":
      return {
        title: `${result.operation === "start" ? "Start" : "Stop"} refused`,
        detail: refusals[result.reason],
        tone: "warning" as const,
      };
    case "incomplete": {
      if (result.operation === "stop") {
        return {
          title: "Stop outcome incomplete",
          detail: `Host state: ${result.managerState}. Refresh before another action.`,
          tone: "warning" as const,
        };
      }
      const outcome =
        result.admission === "unknown"
          ? "The start result is not confirmed."
          : result.registration === "failed"
            ? "Start was accepted, but its record could not be saved."
            : "Start was accepted. Its saved launch is unconfirmed.";
      return {
        title: "Start outcome incomplete",
        detail: `${outcome} Host state: ${result.managerState}. Refresh before another action.`,
        tone: "warning" as const,
      };
    }
  }
}

export function workloadControlInput(row: WorkloadSummary): WorkloadControlInput | null {
  return row.association.state === "assigned" && row.association.threadId !== null
    ? {
        recordId: row.recordId,
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
  if (!row.controlsAvailable) {
    return {
      operation,
      available: false,
      reason: "Workload controls unavailable on this host.",
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
