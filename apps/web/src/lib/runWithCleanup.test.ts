import { describe, expect, it } from "vite-plus/test";
import { runWithCleanup } from "./runWithCleanup";

describe("runWithCleanup", () => {
  it("cleans a completed operation before its caller resumes", async () => {
    const events: string[] = [];
    const result = await runWithCleanup(
      async () => {
        events.push("operation");
        return 7;
      },
      () => events.push("cleanup"),
    );
    expect(result).toBe(7);
    expect(events).toEqual(["operation", "cleanup"]);
  });

  it("cleans a rejected operation and preserves its failure", async () => {
    const failure = new Error("rejected");
    let cleaned = false;
    await expect(
      runWithCleanup(
        () => Promise.reject(failure),
        () => {
          cleaned = true;
        },
      ),
    ).rejects.toBe(failure);
    expect(cleaned).toBe(true);
  });

  it("cleans when the operation throws before returning a promise", async () => {
    const failure = new Error("synchronous failure");
    let cleaned = false;
    await expect(
      runWithCleanup(
        () => {
          throw failure;
        },
        () => {
          cleaned = true;
        },
      ),
    ).rejects.toBe(failure);
    expect(cleaned).toBe(true);
  });
});
