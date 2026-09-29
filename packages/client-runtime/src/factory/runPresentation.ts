/**
 * What a Software Factory run looks like on every client: the run card's
 * content and the thread row's status label, from the summaries the server's
 * run tracker publishes. Web and Android render from here so they cannot
 * disagree. Hermes has no ES2023 array methods: none are used here.
 */
import {
  isFactoryRunFinished,
  type FactoryRunPhaseStatus,
  type FactoryRunReturn,
  type FactoryRunShellSummary,
  type FactoryRunSummary,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

export type FactoryRunTone = "info" | "warning" | "success" | "error";
export type FactoryPhaseMarkTone = FactoryRunTone | "neutral";

export interface FactoryRunLabel {
  readonly text: string;
  readonly tone: FactoryRunTone;
}

export interface FactoryRunCardModel {
  readonly request: string | null;
  readonly status: FactoryRunLabel;
  readonly phase: { readonly index: number; readonly count: number; readonly title: string } | null;
  readonly node: string | null;
  readonly marks: ReadonlyArray<{ readonly index: number; readonly status: FactoryRunPhaseStatus }>;
  readonly returns: string;
  readonly cost: string;
  readonly lastEventAt: string | null;
  readonly question: string | null;
  /** Running or waiting: the card follows the timeline's end. */
  readonly live: boolean;
}

const NODE_NAMES: Readonly<Record<string, string>> = {
  "checks-build": "Build checks",
  "checks-harden": "Harden checks",
};

const CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨";

/** `fence` → `Fence`, `verify-1` → `Verify ①`, `report-draft` → `Report draft`. */
export function factoryNodeDisplayName(node: string): string {
  const named = NODE_NAMES[node];
  if (named !== undefined) return named;
  const words = node.split("-").filter((word) => word.length > 0);
  const last = words[words.length - 1];
  if (words.length > 1 && last !== undefined && /^[1-9]$/.test(last)) {
    words[words.length - 1] = CIRCLED_DIGITS[Number(last) - 1]!;
  }
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const TONE_BY_FINISHED_STATUS = {
  done: "success",
  degraded: "error",
  stopped: "warning",
} as const satisfies Record<string, FactoryRunTone>;

/**
 * The label a thread row shows for its run: `phase 5/11 · Review` while
 * running, then `waiting`, `done`, `degraded` or `stopped`. Null for a
 * thread without a run.
 */
export function factoryRunLabel(
  run: FactoryRunShellSummary | null | undefined,
): FactoryRunLabel | null {
  if (run == null) return null;
  switch (run.status) {
    case "waiting":
      return { text: "waiting", tone: "warning" };
    case "done":
    case "degraded":
    case "stopped":
      return { text: run.status, tone: TONE_BY_FINISHED_STATUS[run.status] };
    case "running": {
      if (run.phaseIndex === 0) return { text: "starting", tone: "info" };
      const phase = `phase ${run.phaseIndex}/${run.phaseCount}`;
      return {
        text: run.node === null ? phase : `${phase} · ${factoryNodeDisplayName(run.node)}`,
        tone: "info",
      };
    }
  }
}

export function factoryPhaseMarkTone(status: FactoryRunPhaseStatus): FactoryPhaseMarkTone {
  switch (status) {
    case "running":
      return "info";
    case "clean":
      return "success";
    case "degraded":
      return "error";
    case "pending":
      return "neutral";
  }
}

/** The clock time of an event: absolute, so it never goes stale on screen. */
export function factoryEventClock(iso: string): string {
  // The reader's local clock and Intl formatting, which Effect's DateTime does not do.
  // @effect-diagnostics-next-line globalDate:off
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A run's clock reading. Below a second it reads `0s`; `formatDuration` would say `1ms`. */
export const factoryClockText = (ms: number) => (ms < 1_000 ? "0s" : formatDuration(ms));

/** `repair 2/5 — Verify ①: <change>`: one return, on the Run tab and in the report's steps. */
export function factoryReturnText(entry: FactoryRunReturn): string {
  return `${entry.kind} ${entry.n}/${entry.budget} — ${factoryNodeDisplayName(entry.node)}: ${entry.change}`;
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/**
 * Codex's own totals: `cached_input_tokens` is part of `input_tokens` and
 * `reasoning_output_tokens` part of `output_tokens`, so they are not added.
 */
export function factoryTokenTotal(tokens: Readonly<Record<string, number>>): number {
  return (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0);
}

export interface FactoryCostText {
  readonly text: string;
  /** Dollars and tokens both: the dollar figure leaves out the turns that reported tokens. */
  readonly floor: boolean;
}

/** `$12.40`, `3,161,680 tokens`, or `$10.03 + 3,161,680 tokens` marked as a floor. */
export function factoryCostText(cost: {
  readonly usd: number;
  readonly tokens: Readonly<Record<string, number>>;
}): FactoryCostText {
  const tokenTotal = factoryTokenTotal(cost.tokens);
  const tokens = `${tokenTotal.toLocaleString("en-US")} tokens`;
  if (cost.usd > 0 && tokenTotal > 0) return { text: `${usd(cost.usd)} + ${tokens}`, floor: true };
  if (tokenTotal > 0) return { text: tokens, floor: false };
  return { text: usd(cost.usd), floor: false };
}

/** The run card's content, from the compact summary of a `factory.run` activity. */
export function factoryRunCardModel(summary: FactoryRunSummary): FactoryRunCardModel {
  const status = factoryRunLabel({
    status: summary.status,
    phaseIndex: summary.phase?.index ?? 0,
    phaseCount: summary.phaseCount,
    node: summary.node,
  })!;
  return {
    request: summary.request ?? null,
    status,
    phase:
      summary.phase === null
        ? null
        : { index: summary.phase.index, count: summary.phaseCount, title: summary.phase.title },
    node: summary.node === null ? null : factoryNodeDisplayName(summary.node),
    marks: (summary.phaseStatuses ?? []).map((phaseStatus, index) => ({
      index: index + 1,
      status: phaseStatus,
    })),
    returns: `${summary.returns.used}/${summary.returns.budget} returns`,
    cost: usd(summary.cost.usd),
    lastEventAt: summary.lastEventAt,
    question: summary.question ?? null,
    live: !isFactoryRunFinished(summary.status),
  };
}
