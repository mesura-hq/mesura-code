import { act, render as renderBrowser, fakeTimers } from "../../test/render";

import { expect, it, vi } from "vite-plus/test";

import { useElapsedLabel } from "./useElapsedLabel";

const STARTED_MS = Date.UTC(2026, 9, 20);

async function setupBrowserFixture0() {
  const _timers = fakeTimers();
  vi.setSystemTime(STARTED_MS);

  return {
    async [Symbol.asyncDispose]() {
      vi.useRealTimers();
      vi.unstubAllGlobals();

      _timers[Symbol.dispose]();
    },
  };
}

const seconds = (elapsedMs: number) => `${Math.floor(elapsedMs / 1000)}s`;
const minutes = (elapsedMs: number) => `${Math.floor(elapsedMs / 60_000)}m`;

it("ticks every reader in one commit, and leaves a reader whose label is unchanged alone", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  const container = document.createElement("div");
  const root = await renderBrowser(null, { container: container, router: false });
  const renders = { a: 0, b: 0, slow: 0 };
  const startedMs = STARTED_MS;
  const countRender = (name: keyof typeof renders) => {
    renders[name] += 1;
  };
  function Label({ name, format }: { name: keyof typeof renders; format: (ms: number) => string }) {
    countRender(name);
    return <span>{useElapsedLabel(startedMs, format)}</span>;
  }
  await act(
    async () =>
      await root.rerender(
        <>
          <Label name="a" format={seconds} />
          <Label name="b" format={seconds} />
          <Label name="slow" format={minutes} />
        </>,
      ),
  );
  renders.a = renders.b = renders.slow = 0;

  for (let second = 0; second < 3; second += 1) await act(() => vi.advanceTimersByTime(1_000));
  expect(container.textContent).toBe("3s3s0m");
  expect(renders.a).toBe(3);
  expect(renders.b).toBe(3);
  expect(renders.slow, "a minute label does not render each second").toBe(0);
  await root[Symbol.asyncDispose]();
});
