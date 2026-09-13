import { describe, expect, it } from "vite-plus/test";

import {
  initialProjectFileWatchState,
  nextProjectFileWatchAction,
} from "./projectFileWatchRefresh";

const changed = (revision: string) =>
  ({ type: "changed", relativePath: "notes.md", revision }) as const;
const removed = { type: "removed", relativePath: "notes.md" } as const;

describe("nextProjectFileWatchAction", () => {
  it("treats the first changed event as a baseline and does not refresh", () => {
    // Subscribing always yields the current revision. Reading again on it would
    // mean every file open costs two reads of the same bytes.
    const result = nextProjectFileWatchAction(initialProjectFileWatchState, changed("a"), true);

    expect(result.refresh).toBe(false);
    expect(result.state.handledRevision).toBe("a");
  });

  it("refreshes when the revision moves", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );
    const result = nextProjectFileWatchAction(afterBaseline.state, changed("b"), true);

    expect(result.refresh).toBe(true);
    expect(result.state.handledRevision).toBe("b");
  });

  it("ignores a repeat of the revision it already handled", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );
    const result = nextProjectFileWatchAction(afterBaseline.state, changed("a"), true);

    expect(result.refresh).toBe(false);
    expect(result.state.handledRevision).toBe("a");
  });

  it("holds a change that arrives while a save is pending, then applies it", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );

    // Disabled: the user is mid-save, so re-reading now would show them the
    // file without the characters they just typed.
    const whileSaving = nextProjectFileWatchAction(afterBaseline.state, changed("b"), false);
    expect(whileSaving.refresh).toBe(false);
    expect(whileSaving.state.pending).toEqual({ type: "changed", revision: "b" });
    expect(whileSaving.state.handledRevision).toBe("a");

    const afterSave = nextProjectFileWatchAction(whileSaving.state, null, true);
    expect(afterSave.refresh).toBe(true);
    expect(afterSave.state.handledRevision).toBe("b");
    expect(afterSave.state.pending).toBeNull();
  });

  it("keeps only the newest revision while several arrive during a save", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );
    const first = nextProjectFileWatchAction(afterBaseline.state, changed("b"), false);
    const second = nextProjectFileWatchAction(first.state, changed("c"), false);

    expect(second.state.pending).toEqual({ type: "changed", revision: "c" });

    const afterSave = nextProjectFileWatchAction(second.state, null, true);
    expect(afterSave.refresh).toBe(true);
    expect(afterSave.state.handledRevision).toBe("c");
  });

  it("does nothing when enabled flips true with nothing pending", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );
    const result = nextProjectFileWatchAction(afterBaseline.state, null, true);

    expect(result.refresh).toBe(false);
    expect(result.state).toEqual(afterBaseline.state);
  });

  it("refreshes on removal so the panel shows the read error", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );
    const result = nextProjectFileWatchAction(afterBaseline.state, removed, true);

    expect(result.refresh).toBe(true);
    expect(result.state.handledRevision).toBeNull();
  });

  it("defers a removal that lands during a save, then applies it", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );

    // Reading now would put "file not found" on screen over what the user is
    // still typing, and the save in flight is about to recreate the file.
    const whileSaving = nextProjectFileWatchAction(afterBaseline.state, removed, false);
    expect(whileSaving.refresh).toBe(false);
    expect(whileSaving.state.pending).toEqual({ type: "removed" });
    expect(whileSaving.state.handledRevision).toBe("a");

    const afterSave = nextProjectFileWatchAction(whileSaving.state, null, true);
    expect(afterSave.refresh).toBe(true);
    expect(afterSave.state.handledRevision).toBeNull();
    expect(afterSave.state.pending).toBeNull();
  });

  it("refreshes when a removed file comes back", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );
    const afterRemoval = nextProjectFileWatchAction(afterBaseline.state, removed, true);

    // The trap: a removal leaves no handled revision, which looks exactly like
    // a subscription that has said nothing yet. Treating the file's return as a
    // baseline would leave the panel showing the read error forever.
    const afterReturn = nextProjectFileWatchAction(afterRemoval.state, changed("b"), true);

    expect(afterReturn.refresh).toBe(true);
    expect(afterReturn.state.handledRevision).toBe("b");
  });

  it("refreshes after a reconnect whose baseline revision moved while away", () => {
    const afterBaseline = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("a"),
      true,
    );

    // A reconnect resubscribes, so a fresh baseline arrives. It is only a
    // baseline to the server; to this client it is the first news that the
    // file changed while the socket was down.
    const result = nextProjectFileWatchAction(afterBaseline.state, changed("z"), true);

    expect(result.refresh).toBe(true);
    expect(result.state.handledRevision).toBe("z");
  });
});

describe("returning to a file that changed while it was in the background", () => {
  const changed = (revision: string) =>
    ({ type: "changed", relativePath: "src/a.ts", revision }) as const;

  it("re-reads when the new subscription's baseline is not the revision last handled", () => {
    // Nothing watches a file the user is not looking at, so this baseline is
    // the only notice that an agent rewrote it in the meantime.
    const action = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("rev-2"),
      true,
      "rev-1",
    );

    expect(action.refresh).toBe(true);
    expect(action.state.handledRevision).toBe("rev-2");
  });

  it("stays quiet when the baseline is the revision it already had", () => {
    const action = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("rev-1"),
      true,
      "rev-1",
    );

    expect(action.refresh).toBe(false);
    expect(action.state.baselineTaken).toBe(true);
  });

  it("stays quiet on a file it has never watched", () => {
    // The panel read this file to show it, so its baseline says nothing new.
    const action = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("rev-1"),
      true,
      null,
    );

    expect(action.refresh).toBe(false);
  });

  it("defers a changed-while-away baseline that lands during a save", () => {
    const action = nextProjectFileWatchAction(
      initialProjectFileWatchState,
      changed("rev-2"),
      false,
      "rev-1",
    );

    expect(action.refresh).toBe(false);
    expect(action.state.pending).toEqual({ type: "changed", revision: "rev-2" });

    // And it is applied once the save confirms.
    const applied = nextProjectFileWatchAction(action.state, null, true);
    expect(applied.refresh).toBe(true);
    expect(applied.state.handledRevision).toBe("rev-2");
  });
});
