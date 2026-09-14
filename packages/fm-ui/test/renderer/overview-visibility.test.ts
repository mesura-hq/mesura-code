/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useOverview } from "../../src/overview/useOverview.ts";
import { installBridge } from "./support.ts";

it("releases only overview watches while hidden and revalidates on visibility", async () => {
  const log = installBridge();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("visible");
  const hook = renderHook(() => useOverview("/home/jc", false));
  try {
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const owned = log.watched.filter((id) => id.startsWith("overview:"));
    expect(owned.length).toBeGreaterThan(0);
    act(() => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(log.unwatched).toEqual(expect.arrayContaining(owned)));
    expect(hook.result.current.paused).toBe(true);
    log.addEntry("/home/jc/projects", "while-hidden.txt");
    act(() => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(hook.result.current.folders.get("/home/jc/projects")?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "while-hidden.txt" })]),
      ),
    );
    expect(log.unwatched.every((id) => id.startsWith("overview:"))).toBe(true);
  } finally {
    hook.unmount();
    visibility.mockRestore();
  }
});
