import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 110;

/**
 * Mesura: the agent search's progress mark. It repaints only while mounted, and
 * callers mount it only while a search runs (AGENTS.md: no continuously
 * repainting animation).
 */
export function DotsSpinner() {
  const [frame, setFrame] = useState(0);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: interval timer that steps the frame while mounted, cleared on unmount
  useEffect(() => {
    const interval = window.setInterval(
      () => setFrame((current) => (current + 1) % FRAMES.length),
      FRAME_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, []);
  return (
    <span aria-hidden className="font-mono">
      {FRAMES[frame]}
    </span>
  );
}

/** The Dots mark as the field and the popup show it while a search runs. */
export function AgentSearchRunningMark() {
  return (
    <span
      role="status"
      aria-label="Agent search running"
      className="shrink-0 text-muted-foreground"
    >
      <DotsSpinner />
    </span>
  );
}
