import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { closeFileManager, openFileManager, runFileManagerToggle } from "./fileManagerToggle";
import { useFileManagerStore } from "./fileManagerStore";

const thread = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t-1") };

describe("runFileManagerToggle", () => {
  beforeEach(() => {
    useFileManagerStore.getState().setOpen(false);
  });

  it("does nothing without a thread on the route", () => {
    runFileManagerToggle(null);
    expect(useFileManagerStore.getState().open).toBe(false);
  });

  it("opens the layer, and closes it again, with a thread on the route", () => {
    runFileManagerToggle(thread);
    expect(useFileManagerStore.getState().open).toBe(true);
    runFileManagerToggle(thread);
    expect(useFileManagerStore.getState().open).toBe(false);
  });
});

describe("openFileManager and closeFileManager", () => {
  beforeEach(() => {
    useFileManagerStore.getState().setOpen(false);
  });

  it("opens only with a thread on the route, as the chord does", () => {
    openFileManager(null);
    expect(useFileManagerStore.getState().open).toBe(false);
    openFileManager(thread);
    openFileManager(thread);
    expect(useFileManagerStore.getState().open).toBe(true);
    closeFileManager();
    expect(useFileManagerStore.getState().open).toBe(false);
  });
});
