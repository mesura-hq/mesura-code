import { DEFAULT_SIDEBAR_THREAD_SORT_ORDER } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Preferences } from "../persistence/mobile-preferences";

import { resolveMobileThreadSortOrder } from "./thread-order";

/**
 * The stored value comes off disk, so every case here is one a real device can
 * present: nothing saved yet, a value written by an older bundle, and a value
 * that is no longer a valid order.
 */
describe("resolveMobileThreadSortOrder", () => {
  it("defaults when the device has saved nothing", () => {
    expect(resolveMobileThreadSortOrder(undefined)).toBe(DEFAULT_SIDEBAR_THREAD_SORT_ORDER);
    expect(resolveMobileThreadSortOrder({})).toBe(DEFAULT_SIDEBAR_THREAD_SORT_ORDER);
  });

  it("keeps a stored order the user chose", () => {
    expect(resolveMobileThreadSortOrder({ threadSortOrder: "created_at" })).toBe("created_at");
    expect(resolveMobileThreadSortOrder({ threadSortOrder: "updated_at" })).toBe("updated_at");
  });

  it("falls back when a stored value is no longer a valid order", () => {
    // A bundle that once offered a third order would leave this behind.
    const stale = { threadSortOrder: "agent_activity" } as unknown as Preferences;
    expect(resolveMobileThreadSortOrder(stale)).toBe(DEFAULT_SIDEBAR_THREAD_SORT_ORDER);
  });
});
