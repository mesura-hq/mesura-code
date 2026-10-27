import { factoryRunShortLabel } from "@t3tools/client-runtime/factory/run-presentation";
import type { FactoryRunShellSummary, ThreadAgentSignal } from "@t3tools/contracts";

import type { SidebarThreadStatus } from "./Sidebar.logic";

export type SidebarThreadAttentionKind =
  | "approval"
  | "input"
  | "request"
  | "failed"
  | "limited"
  | "factory"
  | "working"
  | "waiting"
  | "woke"
  | "done";

/**
 * `quiet` is busy work the developer need not look at; `loud` needs the developer; `calm` is
 * finished.
 */
export type SidebarThreadAttentionEmphasis = "quiet" | "loud" | "calm";

export interface SidebarThreadAttention {
  readonly kind: SidebarThreadAttentionKind;
  readonly text: string;
  readonly emphasis: SidebarThreadAttentionEmphasis;
}

export interface SidebarThreadAttentionInput {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly agentSignal: ThreadAgentSignal | null | undefined;
  readonly factoryRun: FactoryRunShellSummary | null | undefined;
  /** A provider goal in progress reads `Goal` instead of `Working`. */
  readonly goalActive?: boolean;
}

const NEEDS_INPUT: SidebarThreadAttention = {
  kind: "input",
  text: "Needs input",
  emphasis: "loud",
};
// A run that stopped on a question or was stopped waits on the developer.
const FACTORY_NEEDS_INPUT_STATUSES: ReadonlySet<string> = new Set(["waiting", "stopped"]);
/** Precedence follows the prototype's `statusAfter`: what needs the developer first, then busy work, then finished. */
export function resolveSidebarThreadAttention(
  input: SidebarThreadAttentionInput,
): SidebarThreadAttention | null {
  const { status, agentSignal, factoryRun } = input;
  if (status === "approval") return { kind: "approval", text: "Approval", emphasis: "loud" };
  if (
    status === "input" ||
    agentSignal?.kind === "needs_input" ||
    (factoryRun != null && FACTORY_NEEDS_INPUT_STATUSES.has(factoryRun.status))
  ) {
    return NEEDS_INPUT;
  }
  if (status === "request") return { kind: "request", text: "Request", emphasis: "loud" };
  if (status === "failed") return { kind: "failed", text: "Failed", emphasis: "loud" };
  if (status === "limited") return { kind: "limited", text: "Limited", emphasis: "loud" };
  if (factoryRun?.status === "running") {
    return { kind: "factory", text: factoryRunShortLabel(factoryRun) ?? "", emphasis: "quiet" };
  }
  if (status === "working") {
    return { kind: "working", text: input.goalActive ? "Goal" : "Working", emphasis: "quiet" };
  }
  if (status === "waiting") return { kind: "waiting", text: "Waiting", emphasis: "quiet" };
  if (input.isWoke) return { kind: "woke", text: "Woke", emphasis: "calm" };
  return input.isUnread ? { kind: "done", text: "Done", emphasis: "calm" } : null;
}

export type SidebarThreadAttentionIcon =
  | "approval"
  | "input"
  | "request"
  | "failed"
  | "done"
  | "woke"
  | null;

export interface SidebarThreadAttentionLook {
  readonly className: string;
  readonly icon: SidebarThreadAttentionIcon;
  /** The 2 px left edge Approval and Failed rows carry in their label's color; empty for the rest. */
  readonly rowEdgeClassName: string;
}

const QUIET_LOOK: SidebarThreadAttentionLook = {
  className: "font-normal text-muted-foreground opacity-75",
  icon: null,
  rowEdgeClassName: "",
};
// Working rows read azure, apart from Waiting's grey, and carry the Working section's band
// (sidebar/workingSweep.tsx); the developer chose it from the working-state prototype.
const WORKING_LOOK: SidebarThreadAttentionLook = {
  className: "font-medium text-(--mesura-working)",
  icon: null,
  rowEdgeClassName: "",
};

// The prototype's emphasis levels on the sidebar's own hues. Limited, Woke and Done keep the look
// they had before the label moved here; Limited therefore carries no edge. Needs input is loud
// but carries no edge either: its label and icon are enough (developer, 2026-10-26).
const LOOK_BY_KIND: Readonly<Record<SidebarThreadAttentionKind, SidebarThreadAttentionLook>> = {
  approval: {
    className: "font-semibold text-warning-foreground",
    icon: "approval",
    rowEdgeClassName: "shadow-[inset_2px_0_0_var(--color-warning)]",
  },
  input: {
    className: "font-semibold text-needs-input",
    icon: "input",
    rowEdgeClassName: "",
  },
  request: {
    className: "font-semibold text-guest-foreground",
    icon: "request",
    rowEdgeClassName: "",
  },
  failed: {
    className: "font-semibold text-error",
    icon: "failed",
    rowEdgeClassName: "shadow-[inset_2px_0_0_var(--color-error)]",
  },
  limited: { className: "font-medium text-warning", icon: "failed", rowEdgeClassName: "" },
  factory: WORKING_LOOK,
  working: WORKING_LOOK,
  waiting: QUIET_LOOK,
  woke: { className: "font-medium text-warning", icon: "woke", rowEdgeClassName: "" },
  done: { className: "font-medium text-success", icon: "done", rowEdgeClassName: "" },
};

/** The labels that carry the Working section's band. */
export function sidebarThreadAttentionSweeps(kind: SidebarThreadAttentionKind): boolean {
  return kind === "working" || kind === "factory";
}

export function sidebarThreadAttentionLook(
  kind: SidebarThreadAttentionKind,
): SidebarThreadAttentionLook {
  return LOOK_BY_KIND[kind];
}
