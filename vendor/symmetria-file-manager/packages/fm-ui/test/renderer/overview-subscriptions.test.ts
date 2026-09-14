/** @vitest-environment happy-dom */
import { waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OverviewSubscriptions } from "../../src/overview/subscriptions.ts";
import { deferred } from "./deferred.ts";
import { installBridge } from "./support.ts";

it("reserves at most 512 watch slots and releases every slot", async () => {
  const log = installBridge();
  const watches = new OverviewSubscriptions(
    "overview:test",
    () => undefined,
    () => undefined,
  );
  await Promise.all(Array.from({ length: 524 }, (_, i) => watches.ensure(`/root/${i}`)));
  expect(log.watched).toHaveLength(512);
  watches.stop();
  await Promise.resolve();
  expect(log.unwatched).toHaveLength(512);
});

it("retains capacity through late setup and teardown without removing a replacement", async () => {
  const log = installBridge();
  const bridge = window.symmetriaFm;
  if (!bridge) throw new Error("Missing fixture bridge");
  const setup = deferred();
  const teardown = deferred();
  const originalWatch = bridge.watch;
  const originalUnwatch = bridge.unwatch;
  const watched = vi.spyOn(bridge, "watch").mockImplementation(async (request) => {
    const reply = await originalWatch(request);
    if (log.watched.length === 1) await setup.promise;
    return reply;
  });
  vi.spyOn(bridge, "unwatch").mockImplementation(async (request) => {
    const reply = await originalUnwatch(request);
    if (log.unwatched.length === 1) await teardown.promise;
    return reply;
  });
  const changed = vi.fn();
  const subscriptions = new OverviewSubscriptions("overview:race", changed, () => undefined);
  const first = subscriptions.ensure("/root/0");
  await waitFor(() => expect(watched).toHaveBeenCalledTimes(1));
  const others = Array.from({ length: 511 }, (_, i) => subscriptions.ensure(`/root/${i + 1}`));
  await Promise.all(others);
  subscriptions.remove("/root/0");
  const replacement = subscriptions.ensure("/root/0");
  expect(watched).toHaveBeenCalledTimes(512);
  setup.resolve();
  await waitFor(() => expect(log.unwatched).toHaveLength(1));
  expect(watched).toHaveBeenCalledTimes(512);
  teardown.resolve();
  await Promise.all([first, replacement]);
  expect(watched).toHaveBeenCalledTimes(513);
  const oldId = log.watched[0];
  const newId = log.watched[512];
  expect(newId).not.toBe(oldId);
  if (!newId || !oldId) throw new Error("Missing watch IDs");
  log.emitChange(oldId);
  log.emitChange(newId);
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith("/root/0"));
  subscriptions.stop();
  await waitFor(() => expect(log.unwatched).toHaveLength(513));
});

it("retries a failed watch once and cancels the retry on close", async () => {
  installBridge();
  const bridge = window.symmetriaFm;
  if (!bridge) throw new Error("Missing fixture bridge");
  const watch = vi.spyOn(bridge, "watch").mockResolvedValue({
    ok: false,
    error: { code: "watch_failed", message: "watch unavailable" },
  });
  const coverage = vi.fn();
  const subscriptions = new OverviewSubscriptions("overview:retry", () => undefined, coverage);
  vi.useFakeTimers();
  try {
    await subscriptions.ensure("/root");
    await vi.advanceTimersByTimeAsync(500);
    expect(watch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(coverage).toHaveBeenLastCalledWith("/root", "watch unavailable");
    await subscriptions.ensure("/root/other");
    subscriptions.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watch).toHaveBeenCalledTimes(3);
  } finally {
    subscriptions.stop();
    vi.useRealTimers();
  }
});
