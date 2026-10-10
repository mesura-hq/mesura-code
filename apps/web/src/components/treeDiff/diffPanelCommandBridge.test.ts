import { describe, expect, it } from "vite-plus/test";

import {
  allocateDiffModeMenuRequestId,
  claimDiffModeMenuRequest,
  mountedDiffPanelDefaultsToTreeDiff,
  recordMountedDiffPanelDefault,
} from "./diffPanelCommandBridge";

describe("diff panel command bridge", () => {
  it("serves each mode menu request once and never serves zero", () => {
    expect(claimDiffModeMenuRequest(0)).toBe(false);
    const first = allocateDiffModeMenuRequestId();
    const second = allocateDiffModeMenuRequestId();
    expect(second).toBeGreaterThan(first);

    expect(claimDiffModeMenuRequest(first)).toBe(true);
    expect(claimDiffModeMenuRequest(first)).toBe(false);
    expect(claimDiffModeMenuRequest(0)).toBe(false);
    expect(claimDiffModeMenuRequest(second)).toBe(true);
    // An older id reaching a remounted panel late opens nothing.
    expect(claimDiffModeMenuRequest(first)).toBe(false);
  });

  it("reports the mounted panel's default until that panel withdraws it", () => {
    expect(mountedDiffPanelDefaultsToTreeDiff("bridge-thread")).toBeUndefined();
    const withdrawOld = recordMountedDiffPanelDefault("bridge-thread", true);
    const withdrawNew = recordMountedDiffPanelDefault("bridge-thread", false);
    // A replaced panel withdrawing late leaves its successor's value in place.
    withdrawOld();
    expect(mountedDiffPanelDefaultsToTreeDiff("bridge-thread")).toBe(false);
    withdrawNew();
    expect(mountedDiffPanelDefaultsToTreeDiff("bridge-thread")).toBeUndefined();
  });
});
