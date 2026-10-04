import type {
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import {
  type ContextWindowSegment,
  type ContextWindowSnapshot,
  deriveLatestContextWindowSnapshot,
} from "@t3tools/client-runtime/context-window";

/**
 * The composer's snapshot, or `null` when the subscribed detail is missing or
 * still belongs to the previous thread: the selection can lag the composer by
 * a render while the user switches threads.
 */
export function selectThreadContextWindowSnapshot(input: {
  readonly detail: {
    readonly id: ThreadId;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  } | null;
  readonly threadId: ThreadId;
}): ContextWindowSnapshot | null {
  if (!input.detail || input.detail.id !== input.threadId) {
    return null;
  }
  return deriveLatestContextWindowSnapshot(input.detail.activities);
}

/**
 * Same rule as the web pill: a provider that says it reports no window hides
 * the indicator, an unknown provider (`null`, not in the catalog yet) does not.
 * Voice input takes over the toolbar, so the indicator steps aside with it.
 */
export function shouldShowContextWindowIndicator(input: {
  readonly snapshot: ContextWindowSnapshot | null;
  readonly threadId: ThreadId | null;
  readonly providerReportsContextWindow: boolean | null;
  readonly isVoiceInputPresented: boolean;
}): boolean {
  return (
    input.snapshot !== null &&
    input.threadId !== null &&
    input.providerReportsContextWindow !== false &&
    !input.isVoiceInputPresented
  );
}

/**
 * The sheet's compact action needs a started session that is not mid-turn.
 * It reads the session status directly: the composer's `showStopAction` also
 * depends on the draft, so a typed draft during a running turn would clear it.
 */
export function isContextWindowCompactDisabled(input: {
  readonly hasCompactableConversation: boolean;
  readonly sessionStatus: OrchestrationSessionStatus | null;
}): boolean {
  return (
    !input.hasCompactableConversation ||
    input.sessionStatus === null ||
    input.sessionStatus === "running" ||
    input.sessionStatus === "starting"
  );
}

export interface ContextWindowBarPart {
  readonly key: string;
  readonly kind: ContextWindowSegment["kind"] | null;
  /** Share of the bar's free width; use as `flexGrow` with `flexBasis: 0`. */
  readonly grow: number;
}

/**
 * Bar parts as flex weights instead of percent widths, so the gaps between
 * parts come out of the free width rather than pushing the last part out of
 * the clipped bar. `window` adds an unfilled remainder (`kind: null`) so the
 * filled parts keep their share of the whole window; `request` has none.
 */
export function layoutContextWindowBarParts(
  segments: ReadonlyArray<ContextWindowSegment>,
  scale: "window" | "request",
): ReadonlyArray<ContextWindowBarPart> {
  const parts: ContextWindowBarPart[] = segments
    .filter((segment) => segment.fraction > 0)
    .map((segment) => ({ key: segment.kind, kind: segment.kind, grow: segment.fraction }));
  const filled = parts.reduce((sum, part) => sum + part.grow, 0);
  if (filled <= 0) {
    return [];
  }
  if (scale === "window" && filled < 1) {
    parts.push({ key: "remainder", kind: null, grow: 1 - filled });
  }
  return parts;
}
