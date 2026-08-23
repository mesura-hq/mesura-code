import { SymmetriaStreamItem } from "@symmetria/broker-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { createFeed, parseFeedPush, type FeedFrame } from "./threadFeed.ts";
import type { ProjectableReadModel } from "./threadProjection.ts";

const decodeStreamItem = Schema.decodeUnknownResult(SymmetriaStreamItem);

const thread = (id: string, title: string): ProjectableReadModel["threads"][number] => ({
  id,
  projectId: "prj_vigilia",
  title,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  session: null,
  createdAt: "2026-08-22T08:00:00.000Z",
  updatedAt: "2026-08-22T08:00:00.000Z",
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  pinnedAt: null,
  deletedAt: null,
});

const model = (...threads: ProjectableReadModel["threads"]): ProjectableReadModel => ({
  projects: [{ id: "prj_vigilia", title: "vigilia" }],
  threads,
});

const decodedFrames = (frames: ReadonlyArray<FeedFrame>): ReadonlyArray<unknown> =>
  frames.map((frame) => {
    const decoded = decodeStreamItem(JSON.parse(frame.line));
    if (Result.isFailure(decoded)) throw new Error(`frame did not decode: ${frame.line}`);
    return decoded.success;
  });

describe("createFeed", () => {
  it("numbers deltas one at a time, whatever upstream's own sequence does", () => {
    // ⚠ This corrects the previous phase. `revision` used to be upstream's
    // `snapshotSequence`, which the contract calls the position a snapshot
    // reflects — but the projector sets it from `event.sequence`, so it
    // advances on EVERY orchestration event including the transcript ones this
    // projection drops. Numbering deltas with it would make a consumer read a
    // gap on nearly every one and resnapshot each time, which is the opposite
    // of what the framing is for. The publisher owns the numbering instead.
    const feed = createFeed();
    feed.accept("gen-1", model(thread("thr_a", "A")));
    const frames = feed.accept("gen-1", model(thread("thr_a", "A"), thread("thr_b", "B")));

    const deltas = decodedFrames(frames) as ReadonlyArray<{ type: string; sequence: number }>;
    expect(deltas.every((item) => item.type === "delta")).toBe(true);
    expect(deltas.map((item) => item.sequence)).toEqual([2]);
  });

  it("puts the snapshot's revision at the last position it emitted", () => {
    // The contract's rule: a delta a consumer may apply is `revision + 1`. A
    // peer connecting after two deltas must therefore open at 2, or its first
    // live delta reads as a gap.
    const feed = createFeed();
    feed.accept("gen-1", model(thread("thr_a", "A")));
    feed.accept("gen-1", model(thread("thr_a", "A"), thread("thr_b", "B")));

    expect(feed.snapshot().revision).toBe(2);
  });

  it("emits nothing at all when the projection has not changed", () => {
    // The read model updates per streaming token, and almost all of that is
    // transcript this projection drops. Without this the socket would carry a
    // byte-identical delta per token.
    const feed = createFeed();
    feed.accept("gen-1", model(thread("thr_a", "A")));
    const again = feed.accept("gen-1", model(thread("thr_a", "A")));

    expect(again).toEqual([]);
    expect(feed.snapshot().revision).toBe(1);
  });

  it("emits one delta per changed entity, not one for the whole push", () => {
    const feed = createFeed();
    feed.accept("gen-1", model(thread("thr_a", "A"), thread("thr_b", "B")));
    const frames = feed.accept("gen-1", model(thread("thr_a", "A2"), thread("thr_b", "B2")));

    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.sequence)).toEqual([2, 3]);
  });

  it("sends a whole snapshot, not a delta, when the renderer generation changes", () => {
    // A renderer reload restarts its subscription, and its state has no
    // relationship to the previous one. Continuing the delta sequence across
    // that boundary is exactly the silent gap the contract forbids, so the
    // discontinuity is said out loud as a fresh snapshot.
    const feed = createFeed();
    feed.accept("gen-1", model(thread("thr_a", "A")));
    const frames = feed.accept("gen-2", model(thread("thr_z", "Z")));

    const items = decodedFrames(frames) as ReadonlyArray<{ type: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("snapshot");
  });

  it("sends a snapshot when a thread stops being listed, not a silent drop", () => {
    // The subtlest branch in the module, and it had no test: the contract has
    // no removal member, so an entity that simply stops appearing cannot be
    // expressed as a delta. Same generation on purpose — a generation change
    // would take the discontinuity path for the other reason and prove nothing
    // about this one. The replacement keeps the LENGTH equal too, so a check
    // written on count alone would not catch it.
    const feed = createFeed();
    feed.accept("gen-1", model(thread("thr_a", "A"), thread("thr_b", "B")));
    const frames = feed.accept("gen-1", model(thread("thr_a", "A"), thread("thr_c", "C")));

    const items = decodedFrames(frames) as ReadonlyArray<{ type: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("snapshot");
  });

  it("sends a snapshot when a project stops being listed", () => {
    const feed = createFeed();
    feed.accept("gen-1", {
      projects: [
        { id: "prj_vigilia", title: "vigilia" },
        { id: "prj_gone", title: "gone" },
      ],
      threads: [],
    });
    const frames = feed.accept("gen-1", {
      projects: [{ id: "prj_vigilia", title: "vigilia" }],
      threads: [],
    });

    const items = decodedFrames(frames) as ReadonlyArray<{ type: string }>;
    expect(items[0]?.type).toBe("snapshot");
  });

  it("opens on an empty snapshot before anything has been accepted", () => {
    const feed = createFeed();
    const opening = feed.snapshot();

    expect(opening.revision).toBe(0);
    expect(opening.threads).toEqual([]);
    expect(Result.isFailure(decodeStreamItem(opening))).toBe(false);
  });

  it("reports a project that changed as its own entity", () => {
    const feed = createFeed();
    feed.accept("gen-1", model(thread("thr_a", "A")));
    const frames = feed.accept("gen-1", {
      ...model(thread("thr_a", "A")),
      projects: [{ id: "prj_vigilia", title: "vigilia-renamed" }],
    });

    const items = decodedFrames(frames) as ReadonlyArray<{
      change: { entity: string; project?: { name: string } };
    }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.change.entity).toBe("project");
    expect(items[0]?.change.project?.name).toBe("vigilia-renamed");
  });
});

describe("parseFeedPush", () => {
  it("refuses everything that is not a well-formed push", () => {
    for (const garbage of [
      null,
      "a string",
      42,
      [],
      {},
      { generation: "g1" },
      { generation: "", readModel: { projects: [], threads: [] } },
      { generation: 7, readModel: { projects: [], threads: [] } },
      { generation: "g1", readModel: null },
      { generation: "g1", readModel: { projects: {}, threads: [] } },
      { generation: "g1", readModel: { projects: [], threads: "no" } },
      { generation: "g1", readModel: { projects: [{ title: "t" }], threads: [] } },
    ]) {
      expect(parseFeedPush(garbage)).toBeNull();
    }
  });

  it("refuses a row with an identifier but no title", () => {
    // ⚠ The exact payload review reproduced a crash with. It passed the first
    // parser, which checked only `id`, and then reached `value.trim()` inside
    // the projection — throwing inside the IPC handler's `Effect.sync`, which
    // is the one thing that handler's comment says must not happen.
    expect(
      parseFeedPush({ generation: "g1", readModel: { projects: [{ id: "p1" }], threads: [] } }),
    ).toBeNull();
    expect(
      parseFeedPush({ generation: "g1", readModel: { projects: [], threads: [{ id: "t1" }] } }),
    ).toBeNull();
  });

  it("accepts a minimal well-formed push", () => {
    const parsed = parseFeedPush({
      generation: "g1",
      readModel: { projects: [{ id: "p1", title: "P" }], threads: [] },
    });
    expect(parsed?.generation).toBe("g1");
  });
});

describe("the feed never throws on a payload the parser let through", () => {
  it("survives a row whose optional text is missing entirely", () => {
    // The parser and the projection are two independent guarantees on purpose.
    // This drives the projection with a row the parser WOULD accept but whose
    // nullable fields are absent rather than null — the second half of the
    // crash review found.
    const feed = createFeed();
    const ragged = {
      projects: [{ id: "prj_x", title: "X" }],
      threads: [{ id: "thr_x", projectId: "prj_x", title: "T" }],
    } as unknown as ProjectableReadModel;

    expect(() => feed.accept("gen-1", ragged)).not.toThrow();
    // And not throwing is only half of it: the row must be DROPPED rather than
    // published with nulls in required fields, or the snapshot the consumer
    // receives would fail its decode over one ragged row. That was the first
    // repair attempted here, and it traded a crash for an invalid payload.
    expect(Result.isFailure(decodeStreamItem(feed.snapshot()))).toBe(false);
    expect(feed.snapshot().threads).toEqual([]);
  });
});
