import { type ContextWindowSnapshot, formatContextWindowTokens } from "./contextWindowSnapshot.ts";

/**
 * The two labels around the composer's context ring: `65k ◯ 1M`. `max` is
 * `null` when the provider reports no total for the model, and the trigger then
 * shows the used count alone.
 */
export interface ContextWindowIndicatorLabels {
  readonly used: string;
  readonly max: string | null;
}

export function formatContextWindowIndicatorLabels(
  usage: Pick<ContextWindowSnapshot, "usedTokens" | "maxTokens">,
): ContextWindowIndicatorLabels {
  return {
    used: formatContextWindowTokens(usage.usedTokens),
    max: usage.maxTokens == null ? null : formatContextWindowTokens(usage.maxTokens),
  };
}

/**
 * The latest model request, split the way providers bill it. `inputTokens`
 * includes the cached and the newly cached tokens; `uncachedTokens` is what
 * remains. Cache fields are `null` when the provider does not report them, so
 * the UI can tell "not reported" from "zero".
 */
export interface ContextWindowRequestBreakdown {
  readonly inputTokens: number;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly uncachedTokens: number | null;
  /** Share of the input served from the cache, 0–100. */
  readonly cachedPercentage: number | null;
}

/** Below this share the cache counts as cold: the request paid for most of its input. */
export const COLD_CACHE_PERCENTAGE = 50;

type BreakdownSource = Pick<
  ContextWindowSnapshot,
  | "inputTokens"
  | "cachedInputTokens"
  | "cacheCreationTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "lastInputTokens"
  | "lastCachedInputTokens"
  | "lastCacheCreationTokens"
  | "lastOutputTokens"
  | "lastReasoningOutputTokens"
>;

/**
 * Prefers the `last*` fields, which describe the single latest request (Codex
 * sends both); the plain fields describe the same request for providers that
 * send only those.
 */
export function deriveContextWindowRequestBreakdown(
  usage: BreakdownSource,
): ContextWindowRequestBreakdown | null {
  const inputTokens = usage.lastInputTokens ?? usage.inputTokens ?? null;
  if (inputTokens === null || inputTokens <= 0) {
    return null;
  }
  const cacheReadTokens = usage.lastCachedInputTokens ?? usage.cachedInputTokens ?? null;
  const cacheWriteTokens = usage.lastCacheCreationTokens ?? usage.cacheCreationTokens ?? null;
  const uncachedTokens =
    cacheReadTokens === null
      ? null
      : Math.max(0, inputTokens - cacheReadTokens - (cacheWriteTokens ?? 0));
  return {
    inputTokens,
    outputTokens: usage.lastOutputTokens ?? usage.outputTokens ?? null,
    reasoningTokens: usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens ?? null,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedTokens,
    cachedPercentage:
      cacheReadTokens === null ? null : Math.min(100, (cacheReadTokens / inputTokens) * 100),
  };
}

/**
 * The cached share as a whole percent, floored so a request that paid for any
 * new input never reads `100%`: 218,000 of 219,000 cached reads `99%`.
 */
export function formatContextWindowCachedPercentage(cachedPercentage: number): string {
  return `${Math.floor(cachedPercentage)}%`;
}

export type ContextWindowSegmentKind = "cacheRead" | "cacheWrite" | "uncached" | "input" | "output";

/**
 * One coloured part of the ring or a bar. `fraction` is 0–1 of whatever the
 * list is scaled to: the whole context window for `deriveContextWindowSegments`,
 * the last request for `deriveContextWindowRequestSegments`.
 */
export interface ContextWindowSegment {
  readonly kind: ContextWindowSegmentKind;
  readonly tokens: number;
  readonly fraction: number;
}

export const CONTEXT_WINDOW_SEGMENT_LABELS: Readonly<Record<ContextWindowSegmentKind, string>> = {
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  uncached: "New",
  input: "Input",
  output: "Output",
};

type ContextWindowPart = { readonly kind: ContextWindowSegmentKind; readonly tokens: number };

/**
 * The last request's parts in ring order: cache read, cache write, new input,
 * output. A provider without a cache split gets one `input` part.
 */
function contextWindowRequestParts(
  breakdown: ContextWindowRequestBreakdown,
): ReadonlyArray<ContextWindowPart> {
  return breakdown.cacheReadTokens === null
    ? [
        { kind: "input", tokens: breakdown.inputTokens },
        { kind: "output", tokens: breakdown.outputTokens ?? 0 },
      ]
    : [
        { kind: "cacheRead", tokens: breakdown.cacheReadTokens },
        { kind: "cacheWrite", tokens: breakdown.cacheWriteTokens ?? 0 },
        { kind: "uncached", tokens: breakdown.uncachedTokens ?? 0 },
        { kind: "output", tokens: breakdown.outputTokens ?? 0 },
      ];
}

/** Drops zero parts and scales the rest so their fractions sum to `share`. */
function scaleContextWindowParts(
  parts: ReadonlyArray<ContextWindowPart>,
  share: number,
): ReadonlyArray<ContextWindowSegment> {
  const partsTotal = parts.reduce((sum, part) => sum + part.tokens, 0);
  if (partsTotal <= 0) {
    return [];
  }
  return parts
    .filter((part) => part.tokens > 0)
    .map((part) => ({
      kind: part.kind,
      tokens: part.tokens,
      fraction: (part.tokens / partsTotal) * share,
    }));
}

/**
 * Splits the used share of the window into the last request's parts, in ring
 * order. The parts are scaled so they sum to the used share, because a
 * provider's `usedTokens` can differ slightly from input + output. Empty when
 * the window size is unknown.
 */
export function deriveContextWindowSegments(
  usage: BreakdownSource & Pick<ContextWindowSnapshot, "usedTokens" | "maxTokens">,
): ReadonlyArray<ContextWindowSegment> {
  const maxTokens = usage.maxTokens ?? null;
  if (maxTokens === null || maxTokens <= 0) {
    return [];
  }
  const usedFraction = Math.min(1, Math.max(0, usage.usedTokens / maxTokens));
  const breakdown = deriveContextWindowRequestBreakdown(usage);
  const parts: ReadonlyArray<ContextWindowPart> = breakdown
    ? contextWindowRequestParts(breakdown)
    : [{ kind: "input", tokens: usage.usedTokens }];
  return scaleContextWindowParts(parts, usedFraction);
}

/**
 * The last request's composition on its own scale, fractions summing to 1, for
 * the full-width request bar. Unlike `deriveContextWindowSegments` it needs no
 * window total, so a provider that reports none still gets the bar. Empty when
 * the provider reports no input.
 */
export function deriveContextWindowRequestSegments(
  usage: BreakdownSource,
): ReadonlyArray<ContextWindowSegment> {
  const breakdown = deriveContextWindowRequestBreakdown(usage);
  return breakdown ? scaleContextWindowParts(contextWindowRequestParts(breakdown), 1) : [];
}
