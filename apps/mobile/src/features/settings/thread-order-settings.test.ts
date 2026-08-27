import { describe, expect, it } from "vite-plus/test";

import { THREAD_ORDER_OPTIONS } from "./thread-order-settings";

describe("THREAD_ORDER_OPTIONS", () => {
  it("offers only last user message and creation time", () => {
    expect(THREAD_ORDER_OPTIONS).toEqual([
      { value: "updated_at", label: "Last user message" },
      { value: "created_at", label: "Created at" },
    ]);
  });
});
