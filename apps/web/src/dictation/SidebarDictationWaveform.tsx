import { useEffect, useRef } from "react";

import { observeIntersection } from "~/lib/observeIntersection";

import { useDictationSessionStore } from "./dictationSessionStore";
import "./sidebarDictationWaveform.css";

const BAR_POSITIONS = [-2, -1, 0, 1, 2];
const SAMPLE_INTERVAL_MS = 100;

export function SidebarDictationWaveform({ recording }: { readonly recording: boolean }) {
  const waveformRef = useRef<HTMLSpanElement>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize DOM bars with microphone samples and browser visibility.
  useEffect(() => {
    const waveform = waveformRef.current;
    if (!waveform) return;
    const bars = Array.from(waveform.children) as HTMLElement[];
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let history = [0, 0, 0];
    let sessionId: string | undefined;
    let phase = 0;

    const sample = () => {
      const session = useDictationSessionStore.getState().session;
      if (recording) {
        if (session?.sessionId !== sessionId) {
          history = [0, 0, 0];
          sessionId = session?.sessionId;
        }
        history = [Math.max(0, Math.min(1, session?.level ?? 0)), ...history.slice(0, 2)];
      }
      for (const [index, bar] of bars.entries()) {
        const distance = Math.abs(BAR_POSITIONS[index]!);
        const positionFactor = 1 - distance * 0.25;
        const wavePosition = (distance / 2) * Math.PI - phase;
        const primaryWave = 0.5 + 0.5 * Math.sin(wavePosition);
        const amplitude = recording
          ? history[distance]!
          : 0.7 * Math.max(0, primaryWave + 0.12 * Math.sin(wavePosition * 2));
        bar.style.transform = `scaleY(${(2 + amplitude * 12 * positionFactor) / 14})`;
        bar.style.opacity = recording ? "1" : String(0.75 + 0.25 * primaryWave);
      }
      phase += 0.3;
    };
    const synchronize = () => {
      const session = useDictationSessionStore.getState().session;
      const paused = recording && (session === null || session.runningSince === null);
      const active = visible && !document.hidden && !motion.matches && !paused;
      if (waveform.dataset.active !== String(active)) waveform.dataset.active = String(active);
      if (active && timer === undefined) {
        sample();
        timer = setInterval(sample, SAMPLE_INTERVAL_MS);
      } else if (!active && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const unobserve = observeIntersection(waveform, (entry) => {
      visible = entry.isIntersecting;
      synchronize();
    });
    const unsubscribe = recording ? useDictationSessionStore.subscribe(synchronize) : undefined;
    motion.addEventListener("change", synchronize);
    document.addEventListener("visibilitychange", synchronize);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      unobserve();
      unsubscribe?.();
      motion.removeEventListener("change", synchronize);
      document.removeEventListener("visibilitychange", synchronize);
    };
  }, [recording]);

  return (
    <span aria-hidden data-sidebar-dictation-waveform="" ref={waveformRef}>
      {BAR_POSITIONS.map((position) => (
        <span key={position} style={{ transform: `scaleY(${0.7 - Math.abs(position) * 0.2})` }} />
      ))}
    </span>
  );
}
