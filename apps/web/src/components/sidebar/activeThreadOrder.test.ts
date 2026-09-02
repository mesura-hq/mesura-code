import { describe, expect, it } from "vite-plus/test";

import { sortActiveThreadsForSidebar } from "./activeThreadOrder";

/**
 * `#33` ordered the active sidebar list by recent messages. Upstream's v2
 * sidebar replaced that with a static anchor whose comment says activity never
 * reorders the list, which took the fork's behaviour out.
 *
 * Both are wanted, and the setting already exists to choose between them:
 * "Last user message" restores the fork's ordering, "Created at" keeps
 * upstream's anchor exactly, including its un-settle re-anchor.
 */

const thread = (input: {
  id: string;
  createdAt: string;
  updatedAt?: string;
  latestUserMessageAt?: string | null;
  unsettledAt?: string | null;
}) => ({
  id: input.id,
  createdAt: input.createdAt,
  updatedAt: input.updatedAt ?? input.createdAt,
  latestUserMessageAt: input.latestUserMessageAt ?? null,
  unsettledAt: input.unsettledAt ?? null,
});

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map((entry) => entry.id);

describe("sortActiveThreadsForSidebar", () => {
  const oldestCreated = thread({
    id: "a-oldest",
    createdAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: "2026-01-09T00:00:00.000Z", // most recently used
  });
  const middle = thread({
    id: "b-middle",
    createdAt: "2026-01-02T00:00:00.000Z",
    latestUserMessageAt: "2026-01-03T00:00:00.000Z",
  });
  const newestCreated = thread({
    id: "c-newest",
    createdAt: "2026-01-05T00:00:00.000Z",
    latestUserMessageAt: "2026-01-05T00:00:00.000Z",
  });

  it("puts the most recently messaged thread first for 'Last user message'", () => {
    expect(ids(sortActiveThreadsForSidebar([middle, newestCreated, oldestCreated], "updated_at")))
      // a-oldest was created first but messaged last, so it rises to the top.
      .toEqual(["a-oldest", "c-newest", "b-middle"]);
  });

  it("keeps upstream's creation anchor for 'Created at'", () => {
    expect(
      ids(sortActiveThreadsForSidebar([middle, newestCreated, oldestCreated], "created_at")),
    ).toEqual(["c-newest", "b-middle", "a-oldest"]);
  });

  it("keeps upstream's un-settle re-anchor for 'Created at'", () => {
    // An old thread that re-entered the active list surfaces above newer ones,
    // which is the one way upstream's static order does move.
    const wokenUp = thread({
      id: "a-oldest",
      createdAt: "2026-01-01T00:00:00.000Z",
      unsettledAt: "2026-01-09T00:00:00.000Z",
    });

    expect(
      ids(sortActiveThreadsForSidebar([middle, newestCreated, wokenUp], "created_at")),
    ).toEqual(["a-oldest", "c-newest", "b-middle"]);
  });

  it("breaks ties deterministically so the list cannot flicker", () => {
    const left = thread({ id: "aaa", createdAt: "2026-01-01T00:00:00.000Z" });
    const right = thread({ id: "bbb", createdAt: "2026-01-01T00:00:00.000Z" });

    expect(ids(sortActiveThreadsForSidebar([right, left], "created_at"))).toEqual(
      ids(sortActiveThreadsForSidebar([left, right], "created_at")),
    );
    expect(ids(sortActiveThreadsForSidebar([right, left], "updated_at"))).toEqual(
      ids(sortActiveThreadsForSidebar([left, right], "updated_at")),
    );
  });
});
