import {
  COLD_CACHE_PERCENTAGE,
  type ContextWindowSegmentKind,
  type ContextWindowSnapshot,
  deriveContextWindowRequestBreakdown,
  deriveContextWindowRequestSegments,
  formatContextWindowCachedPercentage,
  formatContextWindowTokens,
} from "~/lib/contextWindow";
import { ContextWindowSegmentDot, ContextWindowSegmentedBar } from "./ContextWindowSegments";

function BreakdownRow(props: {
  label: string;
  dotKind?: ContextWindowSegmentKind;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px] leading-4">
      <span className="text-secondary-label">
        {props.dotKind ? <ContextWindowSegmentDot kind={props.dotKind} /> : null}
        {props.label}
      </span>
      <span className="font-medium tabular-nums text-secondary-label">{props.children}</span>
    </div>
  );
}

/**
 * Input, output and prompt-cache split of the latest request, shown in the
 * context window popover. The full-width bar stretches the request's parts so
 * their proportions stay readable when the window is mostly empty. Renders
 * nothing when the provider reports no input.
 */
export function ContextWindowRequestBreakdown(props: { usage: ContextWindowSnapshot }) {
  const breakdown = deriveContextWindowRequestBreakdown(props.usage);
  if (!breakdown) {
    return null;
  }
  const requestSegments = deriveContextWindowRequestSegments(props.usage);
  const isCacheCold =
    breakdown.cachedPercentage !== null && breakdown.cachedPercentage < COLD_CACHE_PERCENTAGE;
  const cacheParts: ReadonlyArray<{ kind: ContextWindowSegmentKind; text: string }> =
    breakdown.cacheReadTokens === null
      ? []
      : [
          {
            kind: "cacheRead",
            text: `${breakdown.cacheWriteTokens === null ? "cached" : "cache read"} ${formatContextWindowTokens(breakdown.cacheReadTokens)}`,
          },
          ...(breakdown.cacheWriteTokens === null
            ? []
            : [
                {
                  kind: "cacheWrite" as const,
                  text: `write ${formatContextWindowTokens(breakdown.cacheWriteTokens)}`,
                },
              ]),
          { kind: "uncached", text: `new ${formatContextWindowTokens(breakdown.uncachedTokens)}` },
        ];

  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2">
      <div className="font-medium text-muted-foreground text-[11px]">Last request</div>
      {requestSegments.length > 1 ? (
        <ContextWindowSegmentedBar segments={requestSegments} scale="request" className="h-2" />
      ) : null}
      <BreakdownRow label="Input" {...(cacheParts.length === 0 ? { dotKind: "input" } : {})}>
        {formatContextWindowTokens(breakdown.inputTokens)}
        {breakdown.cachedPercentage !== null ? (
          <>
            <span className="mx-1">·</span>
            <span style={isCacheCold ? { color: "var(--color-warning)" } : undefined}>
              {formatContextWindowCachedPercentage(breakdown.cachedPercentage)} cached
            </span>
          </>
        ) : null}
      </BreakdownRow>
      {cacheParts.length > 0 ? (
        <div className="flex justify-end gap-2 text-[10.5px] leading-4 tabular-nums text-secondary-label/80">
          {cacheParts.map((part) => (
            <span key={part.kind} className="whitespace-nowrap">
              <ContextWindowSegmentDot kind={part.kind} />
              {part.text}
            </span>
          ))}
        </div>
      ) : null}
      {breakdown.outputTokens !== null ? (
        <BreakdownRow label="Output" dotKind="output">
          {formatContextWindowTokens(breakdown.outputTokens)}
          {breakdown.reasoningTokens !== null && breakdown.reasoningTokens > 0 ? (
            <>
              <span className="mx-1">·</span>
              thinking {formatContextWindowTokens(breakdown.reasoningTokens)}
            </>
          ) : null}
        </BreakdownRow>
      ) : null}
      {isCacheCold ? (
        <div
          className="text-pretty text-[11px] leading-4"
          style={{ color: "var(--color-warning)" }}
        >
          Cache was cold: this request paid full price for most of its input.
        </div>
      ) : null}
    </div>
  );
}
