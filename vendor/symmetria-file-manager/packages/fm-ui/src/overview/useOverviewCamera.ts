import type { Point } from "@symmetria/fm-core/overview/viewport";
import { useCallback, useEffect, useRef } from "react";
/** One animation owns the camera; new targets replace its remaining motion. */
export function useCameraAnimation(
  read: () => Point,
  write: (point: Point) => void,
  reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
) {
  const frame = useRef<number | null>(null);
  const latest = useRef({ read, write, reduced });
  latest.current = { read, write, reduced };
  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const animate = useCallback(
    (target: Point) => {
      cancel();
      const { read, write, reduced } = latest.current;
      if (reduced) {
        write(target);
        return;
      }
      const start = read(),
        began = Date.now();
      const tick = () => {
        const progress = Math.min(1, (Date.now() - began) / 150);
        const eased = 1 - (1 - progress) ** 3;
        latest.current.write({
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
        });
        frame.current = progress < 1 ? requestAnimationFrame(tick) : null;
      };
      frame.current = requestAnimationFrame(tick);
    },
    [cancel],
  );
  return Object.assign(animate, { cancel });
}
