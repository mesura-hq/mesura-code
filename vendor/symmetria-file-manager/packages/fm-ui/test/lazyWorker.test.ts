import { afterEach, describe, expect, it, vi } from "vitest";

import { lazyWorker } from "../src/lazyWorker.ts";

/**
 * The one worker-lifecycle helper the three panes share.
 *
 * It exists because the same twelve lines had been written a fourth time —
 * highlighting, tags, waveforms — and review caught the fourth going in. The
 * properties below are what each of those copies was independently trying to
 * get right, which is exactly why they belong in one tested place.
 */

class FakeWorker {
  terminated = false;
  terminate() {
    this.terminated = true;
  }
}

function define(value: unknown): void {
  Object.defineProperty(globalThis, "Worker", { value, configurable: true, writable: true });
}

afterEach(() => {
  define(FakeWorker);
});

describe("starting one", () => {
  it("does not build anything until it is asked", () => {
    // Lazy on purpose: a session that previews no code, no audio and no
    // artwork must never pay to start any of the three.
    define(FakeWorker);
    const build = vi.fn(() => new FakeWorker());

    lazyWorker(build);

    expect(build).not.toHaveBeenCalled();
  });

  it("builds it once and hands back the same one after that", () => {
    // These panes run on nearly every cursor settle. A worker per file costs
    // more than the work inside it.
    define(FakeWorker);
    const build = vi.fn(() => new FakeWorker());
    const lazy = lazyWorker(build);

    const first = lazy.get();
    const second = lazy.get();

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });
});

describe("where there are no workers", () => {
  it("answers null instead of throwing", () => {
    // The panel is embeddable and a host may simply not provide `Worker`.
    // Every consumer treats null as "do the cheap thing", never as an error.
    define(undefined);
    const lazy = lazyWorker(() => new FakeWorker());

    expect(lazy.get()).toBeNull();
  });

  it("does not call the builder at all", () => {
    define(undefined);
    const build = vi.fn(() => new FakeWorker());

    lazyWorker(build).get();

    expect(build).not.toHaveBeenCalled();
  });
});

describe("forgetting one", () => {
  it("terminates the worker rather than leaking it", () => {
    define(FakeWorker);
    const built: FakeWorker[] = [];
    const lazy = lazyWorker(() => {
      const worker = new FakeWorker();
      built.push(worker);
      return worker;
    });

    lazy.get();
    lazy.forget();

    expect(built[0]?.terminated).toBe(true);
  });

  it("builds a fresh one next time", () => {
    // This is what makes a test not inherit another test's worker, which is
    // the whole reason the method is exported.
    define(FakeWorker);
    const lazy = lazyWorker(() => new FakeWorker());

    const first = lazy.get();
    lazy.forget();

    expect(lazy.get()).not.toBe(first);
  });

  it("is safe to call when nothing was ever started", () => {
    define(FakeWorker);

    expect(() => lazyWorker(() => new FakeWorker()).forget()).not.toThrow();
  });
});
