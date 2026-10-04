import type { ContextWindowSegment, ContextWindowSegmentKind } from "~/lib/contextWindow";

/** Ring, bar and legend colours, one per segment kind. */
const CONTEXT_WINDOW_SEGMENT_COLORS: Readonly<Record<ContextWindowSegmentKind, string>> = {
  cacheRead: "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)",
  cacheWrite: "var(--color-sky-500)",
  uncached: "var(--color-amber-500)",
  input: "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)",
  output: "var(--color-violet-500)",
};

const RING_RADIUS = 9.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Gap between neighbouring arcs, in SVG units, so adjacent colours stay distinct. */
const RING_SEGMENT_GAP = 0.9;

/**
 * The composer ring, filled clockwise from the top with one arc per segment.
 * Arcs are drawn to true scale: a segment smaller than the gap is not drawn.
 */
export function ContextWindowSegmentedRing(props: {
  segments: ReadonlyArray<ContextWindowSegment>;
}) {
  let offset = 0;
  const arcs = props.segments.map((segment) => {
    const length = segment.fraction * RING_CIRCUMFERENCE;
    const start = offset;
    offset += length;
    const gap = props.segments.length > 1 ? RING_SEGMENT_GAP : 0;
    return { segment, start, visibleLength: Math.max(0, length - gap) };
  });

  return (
    <svg
      viewBox="0 0 24 24"
      className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
        strokeWidth="3"
      />
      {arcs
        .filter((arc) => arc.visibleLength > 0)
        .map((arc) => (
          <circle
            key={arc.segment.kind}
            cx="12"
            cy="12"
            r={RING_RADIUS}
            fill="none"
            stroke={CONTEXT_WINDOW_SEGMENT_COLORS[arc.segment.kind]}
            strokeWidth="3"
            strokeDasharray={`${arc.visibleLength} ${RING_CIRCUMFERENCE}`}
            strokeDashoffset={-arc.start}
          />
        ))}
    </svg>
  );
}

/**
 * A horizontal bar of the same segments. `scale` is "window" for the share of
 * the whole context window, or "request" to stretch the segments to full width
 * so the last request's composition is readable even when the window is
 * mostly empty.
 */
export function ContextWindowSegmentedBar(props: {
  segments: ReadonlyArray<ContextWindowSegment>;
  scale: "window" | "request";
  className?: string;
}) {
  const total =
    props.scale === "request"
      ? props.segments.reduce((sum, segment) => sum + segment.fraction, 0)
      : 1;
  if (total <= 0) {
    return null;
  }
  return (
    <div
      className={`flex w-full gap-px overflow-hidden rounded-full bg-muted/60 ${props.className ?? "h-1.5"}`}
    >
      {props.segments.map((segment) => (
        <div
          key={segment.kind}
          className="h-full"
          style={{
            width: `${(segment.fraction / total) * 100}%`,
            backgroundColor: CONTEXT_WINDOW_SEGMENT_COLORS[segment.kind],
          }}
        />
      ))}
    </div>
  );
}

export function ContextWindowSegmentDot(props: { kind: ContextWindowSegmentKind }) {
  return (
    <span
      aria-hidden="true"
      className="mr-1 inline-block size-1.5 shrink-0 rounded-full align-middle"
      style={{ backgroundColor: CONTEXT_WINDOW_SEGMENT_COLORS[props.kind] }}
    />
  );
}
