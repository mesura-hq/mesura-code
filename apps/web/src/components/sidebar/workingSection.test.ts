import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createWorkingSectionOrder } from "./workingSection";

const environmentId = EnvironmentId.make("working-order");

function thread(
  id: string,
  times: { readonly message: string | null; readonly run: string | null },
) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-10-01T00:00:00.000Z",
    latestUserAuthoredMessageAt: times.message,
    latestRun:
      times.run === null
        ? null
        : {
            runId: RunId.make(`${id}-run`),
            status: "running" as const,
            requestedAt: times.run,
            startedAt: times.run,
            completedAt: null,
            assistantMessageId: null,
          },
  };
}

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map(({ id }) => id);

describe("working section order", () => {
  it("places a run the agent started itself by its start, not by an older message", () => {
    const order = createWorkingSectionOrder();
    const earlier = thread("earlier-start", {
      message: "2026-10-26T10:00:00.000Z",
      run: "2026-10-26T10:00:00.000Z",
    });
    // A woken coordinator: its last message is older, its new run is the newest start.
    const recent = thread("recent-start", {
      message: "2026-10-26T08:00:00.000Z",
      run: "2026-10-26T11:00:00.000Z",
    });

    expect(ids(order([earlier, recent], []))).toEqual(["recent-start", "earlier-start"]);
  });

  it("keeps a working thread's place while it works, whatever runs it starts", () => {
    const order = createWorkingSectionOrder();
    const first = thread("first", { message: "2026-10-26T10:00:00.000Z", run: null });
    const second = thread("second", { message: "2026-10-26T11:00:00.000Z", run: null });
    expect(ids(order([first, second], []))).toEqual(["second", "first"]);

    const firstProgress = thread("first", {
      message: "2026-10-26T10:00:00.000Z",
      run: "2026-10-26T12:00:00.000Z",
    });

    expect(ids(order([firstProgress, second], []))).toEqual(["second", "first"]);
  });

  it("puts a thread that left and started again at the top", () => {
    const order = createWorkingSectionOrder();
    const first = thread("first", { message: "2026-10-26T10:00:00.000Z", run: null });
    const second = thread("second", { message: "2026-10-26T11:00:00.000Z", run: null });
    order([first, second], []);
    order([second], [first]);

    const firstAgain = thread("first", {
      message: "2026-10-26T10:00:00.000Z",
      run: "2026-10-26T12:00:00.000Z",
    });

    expect(ids(order([firstAgain, second], []))).toEqual(["first", "second"]);
  });
});
