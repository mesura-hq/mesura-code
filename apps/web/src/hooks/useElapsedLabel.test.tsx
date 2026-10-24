// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useElapsedLabel } from "./useElapsedLabel";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const seconds = (elapsedMs: number) => `${Math.floor(elapsedMs / 1000)}s`;
const minutes = (elapsedMs: number) => `${Math.floor(elapsedMs / 60_000)}m`;

it("ticks every reader in one commit, and leaves a reader whose label is unchanged alone", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const renders = { a: 0, b: 0, slow: 0 };
  const startedMs = Date.now();
  const countRender = (name: keyof typeof renders) => {
    renders[name] += 1;
  };
  function Label({ name, format }: { name: keyof typeof renders; format: (ms: number) => string }) {
    countRender(name);
    return <span>{useElapsedLabel(startedMs, format)}</span>;
  }
  act(() =>
    root.render(
      <>
        <Label name="a" format={seconds} />
        <Label name="b" format={seconds} />
        <Label name="slow" format={minutes} />
      </>,
    ),
  );
  renders.a = renders.b = renders.slow = 0;

  for (let second = 0; second < 3; second += 1) act(() => vi.advanceTimersByTime(1_000));
  expect(container.textContent).toBe("3s3s0m");
  expect(renders.a).toBe(3);
  expect(renders.b).toBe(3);
  expect(renders.slow, "a minute label does not render each second").toBe(0);
  act(() => root.unmount());
});
