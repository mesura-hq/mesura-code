import { describe, expect, it } from "vite-plus/test";

import { buildFeedPayload, hasFeedChanged, type FeedThread } from "./threadFeed";

const thread = (overrides: Partial<FeedThread> = {}): FeedThread => ({
  id: "thr_a",
  projectId: "prj_vigilia",
  title: "Wire the bar",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  session: null,
  createdAt: "2026-08-22T08:00:00.000Z",
  updatedAt: "2026-08-22T08:00:00.000Z",
  archivedAt: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

describe("buildFeedPayload", () => {
  it("forwards none of the transcript, however the caller passes it", () => {
    // The main process narrows again, and that pass is the authority. This one
    // exists because what crosses the IPC boundary is what a crash dump can
    // show, and there is no reason for a message about the bar to carry a
    // conversation.
    const noisy = {
      ...thread(),
      messages: [{ text: "a secret" }],
      activities: [{ payload: { anything: true } }],
      checkpoints: [{ id: "chk_1" }],
    } as unknown as FeedThread;

    const serialised = JSON.stringify(
      buildFeedPayload({ generation: "g1", projects: [], threads: [noisy] }),
    );

    for (const forbidden of ["messages", "activities", "checkpoints", "a secret"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("forwards none of the project configuration", () => {
    const noisy = {
      id: "prj_vigilia",
      title: "vigilia",
      workspaceRoot: "/home/jc/projects/vigilia",
      scripts: [{ name: "dev", command: "pnpm dev" }],
      faviconPath: "assets/logo.svg",
    } as unknown as { id: string; title: string };

    const serialised = JSON.stringify(
      buildFeedPayload({ generation: "g1", projects: [noisy], threads: [] }),
    );

    for (const forbidden of ["workspaceRoot", "scripts", "faviconPath", "pnpm dev"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("drops a deleted thread rather than forwarding a tombstone", () => {
    const payload = buildFeedPayload({
      generation: "g1",
      projects: [],
      threads: [thread(), thread({ id: "thr_gone", deletedAt: "2026-08-22T09:00:00.000Z" })],
    });

    expect(payload.readModel.threads.map((entry) => entry.id)).toEqual(["thr_a"]);
  });

  it("normalises an absent optional to null so the wire shape is stable", () => {
    // `snoozedUntil` and `pinnedAt` are optional upstream and required on the
    // wire. Normalising here means the main process's change detection compares
    // like with like — an absent key and a null one would otherwise serialise
    // differently and read as a change that is not one.
    const payload = buildFeedPayload({ generation: "g1", projects: [], threads: [thread()] });

    expect(payload.readModel.threads[0]).toHaveProperty("snoozedUntil", null);
    expect(payload.readModel.threads[0]).toHaveProperty("pinnedAt", null);
  });

  it("carries the generation through untouched", () => {
    expect(buildFeedPayload({ generation: "g-7", projects: [], threads: [] }).generation).toBe(
      "g-7",
    );
  });
});

describe("hasFeedChanged", () => {
  it("is false when the read model serialises identically", () => {
    const payload = buildFeedPayload({ generation: "g1", projects: [], threads: [thread()] });
    expect(hasFeedChanged(JSON.stringify(payload.readModel), payload)).toBe(false);
  });

  it("is true on the first payload, when there is nothing to compare against", () => {
    const payload = buildFeedPayload({ generation: "g1", projects: [], threads: [thread()] });
    expect(hasFeedChanged(null, payload)).toBe(true);
  });

  it("ignores the generation, which is not part of the read model", () => {
    // A remount changes the generation and nothing else. The main process
    // needs to hear about that — it is a discontinuity — so the comparison
    // deliberately excludes it and the caller sends on either signal.
    const first = buildFeedPayload({ generation: "g1", projects: [], threads: [thread()] });
    const second = buildFeedPayload({ generation: "g2", projects: [], threads: [thread()] });

    expect(hasFeedChanged(JSON.stringify(first.readModel), second)).toBe(false);
  });

  it("is true when a thread's title moves", () => {
    const first = buildFeedPayload({ generation: "g1", projects: [], threads: [thread()] });
    const second = buildFeedPayload({
      generation: "g1",
      projects: [],
      threads: [thread({ title: "Renamed" })],
    });

    expect(hasFeedChanged(JSON.stringify(first.readModel), second)).toBe(true);
  });
});
