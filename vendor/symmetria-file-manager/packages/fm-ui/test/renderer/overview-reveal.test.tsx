/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useTabs } from "../../src/useTabs.ts";
import { installBridge } from "./support.ts";

afterEach(cleanup);
async function opened() {
  const log = installBridge();
  const hook = renderHook(() => useTabs("/home/jc"));
  await waitFor(() => expect(hook.result.current.pane.entries.length).toBeGreaterThan(0));
  return { ...hook, log };
}
it("preserves the valid same-parent pane when a reveal target is missing", async () => {
  const { result } = await opened();
  act(() => {
    result.current.moveTo(1);
    result.current.toggleMark();
  });
  const before = result.current.pane;
  act(() => result.current.reveal("/home/jc/deleted.txt"));
  await waitFor(() => expect(result.current.error).toContain("Entry no longer exists"));
  expect(result.current.pane).toEqual(before);
});
it("preserves the valid same-parent pane when the parent cannot be read", async () => {
  const { result } = await opened();
  const before = result.current.pane;
  Object.assign(window.symmetriaFm ?? {}, {
    list: async () => ({ ok: false, error: { code: "scan_failed", message: "permission denied" } }),
  });
  act(() => result.current.reveal("/home/jc/notes.txt"));
  await waitFor(() => expect(result.current.error).toBe("permission denied"));
  expect(result.current.pane).toEqual(before);
});
it("discards an old response when reveal prepares a new navigation generation", async () => {
  const { result, log } = await opened();
  const releaseOld = log.holdNextList("/home/jc", ["stale.txt"]);
  act(() => result.current.reveal("/home/jc/stale.txt"));
  await act(async () => {
    result.current.reveal("/home/jc/projects/beta.md");
    releaseOld();
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(result.current.pane.entries[result.current.pane.cursorIndex]?.name).toBe("beta.md"),
  );
  expect(result.current.pane.path).toBe("/home/jc/projects");
  expect(result.current.error).toBeNull();
});
it("does not apply a pending reveal after intervening navigation", async () => {
  const { result, log } = await opened();
  const release = log.holdNextList("/home/jc", ["stale.txt"]);
  act(() => result.current.reveal("/home/jc/stale.txt"));
  await act(async () => {
    result.current.navigate("/home/jc/projects");
    release();
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current.pane.entries[0]?.name).toBe("alpha"));
  expect(result.current.pane.path).toBe("/home/jc/projects");
});
it("retains a failed reveal message through a later directory watch refresh", async () => {
  const { result, log } = await opened();
  act(() => result.current.reveal("/home/jc/deleted.txt"));
  await waitFor(() => expect(result.current.error).toContain("Entry no longer exists"));
  const subscription = log.watched.find((id) => id.endsWith(":/home/jc"));
  if (!subscription) throw new Error("missing watch");
  await act(async () => {
    log.emitChange(subscription);
    await Promise.resolve();
  });
  expect(result.current.error).toContain("Entry no longer exists");
  act(() => result.current.navigate("/home/jc/projects"));
  await waitFor(() => expect(result.current.error).toBeNull());
});
it("does not let the old parent watch discard a newly prepared reveal", async () => {
  const { result, log } = await opened();
  const subscription = log.watched.find((id) => id.endsWith(":/home/jc"));
  if (!subscription) throw new Error("missing watch");
  await act(async () => {
    result.current.reveal("/home/jc/projects/beta.md");
    log.emitChange(subscription);
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(result.current.pane.entries[result.current.pane.cursorIndex]?.name).toBe("beta.md"),
  );
});
