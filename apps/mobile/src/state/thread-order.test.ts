import { DEFAULT_SIDEBAR_THREAD_SORT_ORDER } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMobileThreadSortOrder } from "./thread-order";

describe("resolveMobileThreadSortOrder", () => {
  it("uses the shared recent-order default until the device selects another mode", () => {
    expect(resolveMobileThreadSortOrder({})).toBe(DEFAULT_SIDEBAR_THREAD_SORT_ORDER);
    expect(resolveMobileThreadSortOrder({ threadSortOrder: "updated_at" })).toBe("updated_at");
    expect(resolveMobileThreadSortOrder({ threadSortOrder: "created_at" })).toBe("created_at");
  });
});
