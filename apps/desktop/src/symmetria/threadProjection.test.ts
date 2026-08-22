import { SymmetriaStreamItem } from "@symmetria/broker-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { projectReadModel, type ProjectableReadModel } from "./threadProjection.ts";

const decodeStreamItem = Schema.decodeUnknownResult(SymmetriaStreamItem);

const READ_MODEL: ProjectableReadModel = {
  snapshotSequence: 412,
  projects: [
    { id: "prj_vigilia", title: "vigilia" },
    { id: "prj_kosmos", title: "kosmos-app" },
  ],
  threads: [
    {
      id: "thr_running",
      projectId: "prj_vigilia",
      title: "Wire the bar to the broker",
      branch: "symmetria/shell-bar",
      worktreePath: "/home/jc/projects/vigilia",
      latestTurn: {
        turnId: "trn_1",
        state: "running",
        requestedAt: "2026-08-22T09:00:00.000Z",
        startedAt: "2026-08-22T09:00:01.000Z",
        completedAt: null,
      },
      session: { status: "running", activeTurnId: "trn_1" },
      createdAt: "2026-08-22T08:00:00.000Z",
      updatedAt: "2026-08-22T09:00:01.000Z",
      archivedAt: null,
      settledAt: null,
      snoozedUntil: null,
      pinnedAt: null,
      deletedAt: null,
    },
    {
      id: "thr_idle",
      projectId: "prj_kosmos",
      title: "Offline voice outbox",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      session: null,
      createdAt: "2026-08-21T08:00:00.000Z",
      updatedAt: "2026-08-21T09:00:00.000Z",
      archivedAt: null,
      settledAt: null,
      snoozedUntil: null,
      pinnedAt: null,
      deletedAt: null,
    },
  ],
};

describe("projectReadModel", () => {
  it("produces a snapshot the contract's own decoder accepts", () => {
    // The decoder is the arbiter, not a hand-written shape assertion. A
    // producer that satisfies a local expectation and not the contract is
    // exactly the failure this projection exists to make impossible.
    const decoded = decodeStreamItem(projectReadModel(READ_MODEL));
    if (Result.isFailure(decoded)) {
      throw new Error(`snapshot did not decode: ${JSON.stringify(decoded.failure)}`);
    }
    expect(decoded.success.type).toBe("snapshot");
  });

  it("carries the upstream sequence as the snapshot revision", () => {
    // Borrowed rather than counted locally: `snapshotSequence` is already the
    // position the fork's own read model reflects, and a second numbering
    // would make a consumer's gap detection mean something else.
    expect(projectReadModel(READ_MODEL).revision).toBe(412);
  });

  it("gives every project a non-empty name taken from the source", () => {
    expect(projectReadModel(READ_MODEL).projects).toEqual([
      { projectId: "prj_vigilia", name: "vigilia" },
      { projectId: "prj_kosmos", name: "kosmos-app" },
    ]);
  });

  it("says a running session is running", () => {
    const [running] = projectReadModel(READ_MODEL).threads;
    expect(running?.session).toEqual({ status: "running", activeTurnId: "trn_1" });
  });

  it("reports a thread with no session as null rather than inventing one", () => {
    const idle = projectReadModel(READ_MODEL).threads[1];
    expect(idle?.session).toBeNull();
    expect(idle?.latestTurn).toBeNull();
  });

  it("renames the thread identity the way the contract addresses it", () => {
    const [first] = projectReadModel(READ_MODEL).threads;
    expect(first?.threadId).toBe("thr_running");
    expect(first).not.toHaveProperty("id");
  });

  it("publishes no surfaces and no drafts", () => {
    // Both are in the contract and neither is produced here. Empty rather than
    // absent, because the snapshot requires them and a consumer reading an
    // empty list learns the true thing: nobody is publishing them.
    const snapshot = projectReadModel(READ_MODEL);
    expect(snapshot.surfaces).toEqual([]);
    expect(snapshot.drafts).toEqual([]);
  });

  it("drops a thread whose title upstream left blank", () => {
    // `title` is required and non-blank on the wire, and upstream's own type
    // says it cannot be blank — but upstream's check is dropped on emission
    // and this producer is the last place that can refuse one. Dropping the
    // row beats failing the whole snapshot: one thread missing from the bar
    // costs less than every thread missing.
    const withBlank: ProjectableReadModel = {
      ...READ_MODEL,
      threads: [{ ...READ_MODEL.threads[0]!, title: "   " }],
    };
    const snapshot = projectReadModel(withBlank);
    expect(snapshot.threads).toEqual([]);
    expect(Result.isFailure(decodeStreamItem(snapshot))).toBe(false);
  });

  it("drops a project whose name upstream left blank, for the same reason", () => {
    const withBlank: ProjectableReadModel = {
      ...READ_MODEL,
      projects: [{ id: "prj_x", title: "" }],
    };
    expect(projectReadModel(withBlank).projects).toEqual([]);
  });

  it("carries none of the transcript, the activity feed or the project configuration", () => {
    // The allowlist is the contract's, and Effect's key dropping is the guard
    // rather than the mechanism. This asserts the guard actually holds against
    // an input that carries every forbidden key.
    const noisy = {
      ...READ_MODEL,
      projects: [{ id: "prj_vigilia", title: "vigilia", workspaceRoot: "/home/jc", scripts: [{}] }],
      threads: [
        {
          ...READ_MODEL.threads[0]!,
          messages: [{ text: "secret" }],
          activities: [{ payload: { anything: true } }],
          proposedPlans: [{ markdown: "plan" }],
          checkpoints: [{ id: "chk_1" }],
        },
      ],
    } as unknown as ProjectableReadModel;
    const serialised = JSON.stringify(projectReadModel(noisy));
    for (const forbidden of [
      "messages",
      "activities",
      "proposedPlans",
      "checkpoints",
      "workspaceRoot",
      "scripts",
      "secret",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
