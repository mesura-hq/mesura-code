import type { SymmetriaDictationPhase } from "@symmetria/broker-contract";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { buildCenterOutWaveform, shouldAnimateDictationWaveform } from "./dictationPresentation";

const BAR_COUNT = 24;
const BAR_IDS = Array.from({ length: BAR_COUNT }, (_, index) => `dictation-wave-bar-${index}`);

export const CenterOutWaveform = memo(function CenterOutWaveform(props: {
  sessionId: string;
  phase: SymmetriaDictationPhase;
  audioLevel: number | null;
  active: boolean;
  reducedMotion: boolean;
  className?: string;
}) {
  const [history, setHistory] = useState<ReadonlyArray<number>>([]);
  const [tick, setTick] = useState(0);
  const previousSessionId = useRef(props.sessionId);

  useEffect(() => {
    if (previousSessionId.current === props.sessionId) return;
    previousSessionId.current = props.sessionId;
    setHistory([]);
    setTick(0);
  }, [props.sessionId]);

  useEffect(() => {
    if (!props.active || props.phase !== "recording") return;
    const amplitude = Math.max(0, Math.min(1, ((props.audioLevel ?? 0) - 0.025) * 12));
    setHistory((current) => [amplitude, ...current].slice(0, Math.ceil(BAR_COUNT / 2)));
  }, [props.active, props.audioLevel, props.phase]);

  useEffect(() => {
    if (!shouldAnimateDictationWaveform(props)) return;
    const timer = window.setInterval(() => setTick((current) => current + 1), 120);
    return () => window.clearInterval(timer);
  }, [props.active, props.phase, props.reducedMotion]);

  const heights = useMemo(
    () =>
      buildCenterOutWaveform({
        barCount: BAR_COUNT,
        history,
        phase: props.phase,
        tick,
      }),
    [history, props.phase, tick],
  );

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-6 min-w-0 flex-1 items-center justify-center gap-[3px]",
        props.className,
      )}
    >
      {heights.map((height, index) => (
        <span
          key={BAR_IDS[index]}
          className={cn(
            "w-[3px] rounded-full bg-primary/80 transition-[height,opacity] duration-100 ease-out",
            props.phase === "paused" && "opacity-45",
            props.phase === "confirming" && "opacity-35",
          )}
          style={{ height: `${Math.max(2, height * 22)}px` }}
        />
      ))}
    </div>
  );
});
