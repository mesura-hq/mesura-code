import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { throttledAtom } from "./throttledAtom";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function watch(intervalMs: number) {
  const registry = AtomRegistry.make();
  const source = Atom.make(0);
  const throttled = throttledAtom(source, intervalMs);
  const seen: number[] = [];
  const unsubscribe = registry.subscribe(throttled, (value) => seen.push(value), {
    immediate: true,
  });
  return { set: (value: number) => registry.set(source, value), seen, unsubscribe };
}

it("publishes a change after a quiet interval at once", () => {
  const { set, seen, unsubscribe } = watch(1_000);
  vi.advanceTimersByTime(5_000);
  set(1);
  expect(seen).toEqual([0, 1]);
  unsubscribe();
});

it("publishes a burst's latest value once per interval", () => {
  const { set, seen, unsubscribe } = watch(1_000);
  vi.advanceTimersByTime(5_000);
  set(1);
  set(2);
  set(3);
  expect(seen, "the first at once, the rest held").toEqual([0, 1]);
  vi.advanceTimersByTime(1_000);
  expect(seen, "then the latest, once").toEqual([0, 1, 3]);
  vi.advanceTimersByTime(5_000);
  expect(seen, "an unchanged source tells nobody").toEqual([0, 1, 3]);
  unsubscribe();
});
