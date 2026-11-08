import { type RefObject, useEffect, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { WORKING_SWEEP_INTERVAL_MS } from "./workingSection";

/**
 * A working label with the band `mesura.css` sweeps across it. The band moves only while an
 * ancestor carries `data-working-sweep-tick`, which `useWorkingSweep` sets; anywhere else the
 * label sits still in its working colour.
 */
export function WorkingSweepText(props: { readonly text: string }) {
  return (
    <span data-working-sweep="">
      {props.text}
      <span aria-hidden data-working-sweep-window="">
        <span data-working-sweep-bright="">{props.text}</span>
      </span>
    </span>
  );
}

/**
 * One timer per section starts one 0.9 s crossing on every working label under `ref` every 4 s
 * by flipping an attribute, so a tick re-renders nothing. Between crossings no animation exists
 * and nothing draws: an infinite CSS loop with a still tail kept Chrome drawing 2.3 s of every
 * 4 s (prototype, 2026-10-26). Stops when `running` is false and while reduced motion is on.
 */
export function useWorkingSweep(ref: RefObject<HTMLElement | null>, running: boolean): void {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const sweeping = running && !reducedMotion;
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: owns the section's one interval timer, cleared when the band must stop
  useEffect(() => {
    const element = ref.current;
    if (element === null || !sweeping) return undefined;
    let tick = 0;
    const flip = () => {
      tick += 1;
      // Two names for one motion: changing the name is what restarts the animation.
      element.dataset.workingSweepTick = tick % 2 === 0 ? "a" : "b";
    };
    flip();
    const id = window.setInterval(flip, WORKING_SWEEP_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      delete element.dataset.workingSweepTick;
    };
  }, [ref, sweeping]);
}

/** Whether `ref` is scrolled into view and its tab is visible. */
export function useSeenOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === "visible");
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: subscribes to an IntersectionObserver and visibilitychange, removed on unmount
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const observer = new IntersectionObserver(([entry]) =>
      setOnScreen(entry?.isIntersecting ?? true),
    );
    observer.observe(element);
    const onVisibility = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ref]);
  return onScreen && tabVisible;
}
