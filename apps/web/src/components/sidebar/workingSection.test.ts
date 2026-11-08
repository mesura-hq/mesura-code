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

type Thread = ReturnType<typeof thread>;

/** One observation: every thread, the ids that work, and the section's rows in this order. */
function observe(
  order: ReturnType<typeof createWorkingSectionOrder>,
  threads: ReadonlyArray<Thread>,
  working: ReadonlyArray<string>,
  shown: ReadonlyArray<Thread> = threads.filter((candidate) => working.includes(candidate.id)),
) {
  return ids(order.observe(threads, (candidate) => working.includes(candidate.id))(shown));
}

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

    expect(observe(order, [earlier, recent], ["earlier-start", "recent-start"])).toEqual([
      "recent-start",
      "earlier-start",
    ]);
  });

  it("keeps a working thread's place while it works, whatever runs it starts", () => {
    const order = createWorkingSectionOrder();
    const first = thread("first", { message: "2026-10-26T10:00:00.000Z", run: null });
    const second = thread("second", { message: "2026-10-26T11:00:00.000Z", run: null });
    expect(observe(order, [first, second], ["first", "second"])).toEqual(["second", "first"]);

    const firstProgress = thread("first", {
      message: "2026-10-26T10:00:00.000Z",
      run: "2026-10-26T12:00:00.000Z",
    });

    expect(observe(order, [firstProgress, second], ["first", "second"])).toEqual([
      "second",
      "first",
    ]);
  });

  it("puts a thread that stopped and started again at the top", () => {
    const order = createWorkingSectionOrder();
    const first = thread("first", { message: "2026-10-26T10:00:00.000Z", run: null });
    const second = thread("second", { message: "2026-10-26T11:00:00.000Z", run: null });
    observe(order, [first, second], ["first", "second"]);
    observe(order, [first, second], ["second"]);

    const firstAgain = thread("first", {
      message: "2026-10-26T10:00:00.000Z",
      run: "2026-10-26T12:00:00.000Z",
    });

    expect(observe(order, [firstAgain, second], ["first", "second"])).toEqual(["first", "second"]);
  });

  it("records the start of a thread shown alone, so a later run does not move it", () => {
    const order = createWorkingSectionOrder();
    const alone = thread("alone", { message: "2026-10-26T10:00:00.000Z", run: null });
    const elsewhere = thread("elsewhere", { message: "2026-10-26T11:00:00.000Z", run: null });
    // The project filter shows only `alone`; `elsewhere` is not working yet.
    observe(order, [alone, elsewhere], ["alone"], [alone]);

    const aloneProgress = thread("alone", {
      message: "2026-10-26T10:00:00.000Z",
      run: "2026-10-26T12:00:00.000Z",
    });

    expect(observe(order, [aloneProgress, elsewhere], ["alone", "elsewhere"])).toEqual([
      "elsewhere",
      "alone",
    ]);
  });

  it("sees a thread stop and start again while the project filter hides it", () => {
    const order = createWorkingSectionOrder();
    const hidden = thread("hidden", { message: "2026-10-26T10:00:00.000Z", run: null });
    const shown = thread("shown", { message: "2026-10-26T11:00:00.000Z", run: null });
    observe(order, [hidden, shown], ["hidden", "shown"]);
    // Filtered to `shown`: `hidden` stops, then starts a new run, out of sight.
    observe(order, [hidden, shown], ["shown"], [shown]);
    const hiddenAgain = thread("hidden", {
      message: "2026-10-26T10:00:00.000Z",
      run: "2026-10-26T12:00:00.000Z",
    });
    observe(order, [hiddenAgain, shown], ["hidden", "shown"], [shown]);

    expect(observe(order, [hiddenAgain, shown], ["hidden", "shown"])).toEqual(["hidden", "shown"]);
  });
});
