import { useCallback, useEffect, useRef, useState } from "react";
import { OverviewCache } from "../overview/cache.ts";
import { OVERVIEW_LIMITS } from "../overview/limits.ts";
import { EXCLUSIONS, OverviewSession, type OverviewSnapshot } from "../overview/session.ts";

const EMPTY: OverviewSnapshot = { folders: new Map(), loading: true, inspected: 0 };
export function useDirectorySnapshot(
  root: string | null,
  showHidden: boolean,
  automaticDepth: number = OVERVIEW_LIMITS.automaticDepth,
) {
  const cache = useRef(new OverviewCache());
  const key = JSON.stringify([root, showHidden, EXCLUSIONS, automaticDepth]);
  const [result, setResult] = useState({ key: "", snapshot: EMPTY, refreshing: false });
  const [paused, setPaused] = useState(document.visibilityState === "hidden");
  const active = useRef<{ stop(): void; include(path: string): void } | null>(null);
  const cached = cache.current.get(key);
  const snapshot = result.key === key ? result.snapshot : (cached?.snapshot ?? EMPTY);
  useEffect(() => {
    const visibility = () => setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  const start = useCallback(() => {
    active.current?.stop();
    active.current = null;
    if (root === null || paused) return;
    const stored = cache.current;
    const seed = stored.get(key)?.snapshot;
    const session = new OverviewSession(
      root,
      showHidden,
      (next) => {
        stored.save(key, next);
        setResult({ key, snapshot: next, refreshing: seed !== undefined && next.loading });
      },
      seed,
      automaticDepth,
    );
    active.current = {
      stop: () => session.stop(),
      include: (path: string) => session.include(path),
    };
    session.start();
  }, [root, showHidden, key, paused, automaticDepth]);
  useEffect(() => {
    start();
    return () => {
      active.current?.stop();
      active.current = null;
    };
  }, [start]);
  return {
    ...snapshot,
    automaticDepth,
    paused,
    refreshing: result.key === key ? result.refreshing : cached !== undefined,
    cache: cache.current,
    key,
    include: (path: string) => active.current?.include(path),
    refresh: start,
  };
}
