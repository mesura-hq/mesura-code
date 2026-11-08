import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentOption } from "../BranchToolbar.logic";
import {
  isRunContextHostReachable,
  resolveCycledEnvironmentId,
  resolveRunContextHosts,
  resolveRunContextTabRequest,
  resolveDigitOptionIndex,
  resolveInitialRunContextTab,
  resolveNavigableRunContextTabs,
  resolveToggledEnvMode,
  stepOptionSelection,
  stepRunContextTab,
  type RunContextTabAvailabilityMap,
} from "./runContextDrawer.logic";

const arch = "arch" as EnvironmentId;
const vigilia = "vigilia-home" as EnvironmentId;
const office = "office" as EnvironmentId;

const draftAvailability: RunContextTabAvailabilityMap = {
  host: { visible: true, editable: true },
  workspace: { visible: true, editable: true },
  branch: { visible: true, editable: true },
};

const startedThreadAvailability: RunContextTabAvailabilityMap = {
  host: { visible: true, editable: false },
  workspace: { visible: true, editable: false },
  branch: { visible: true, editable: true },
};

describe("resolveNavigableRunContextTabs", () => {
  it("keeps the dependency order for a draft", () => {
    expect(resolveNavigableRunContextTabs(draftAvailability)).toEqual([
      "host",
      "workspace",
      "branch",
    ]);
  });

  it("skips read-only tabs once the thread has started", () => {
    expect(resolveNavigableRunContextTabs(startedThreadAvailability)).toEqual(["branch"]);
  });
});

describe("resolveInitialRunContextTab", () => {
  it("opens on the requested tab when the keyboard can land on it", () => {
    expect(resolveInitialRunContextTab(["host", "workspace", "branch"], "branch")).toBe("branch");
  });

  it("falls back to the first editable tab when the requested tab is read-only", () => {
    expect(resolveInitialRunContextTab(["branch"], "host")).toBe("branch");
  });

  it("reports that nothing can change", () => {
    expect(resolveInitialRunContextTab([], null)).toBeNull();
  });
});

describe("stepRunContextTab", () => {
  const tabs = ["host", "workspace", "branch"] as const;

  it("stops at the ends for arrow keys", () => {
    expect(
      stepRunContextTab({ navigableTabs: tabs, currentTab: "host", delta: -1, wrap: false }),
    ).toBe("host");
    expect(
      stepRunContextTab({ navigableTabs: tabs, currentTab: "branch", delta: 1, wrap: false }),
    ).toBe("branch");
  });

  it("wraps for Tab", () => {
    expect(
      stepRunContextTab({ navigableTabs: tabs, currentTab: "branch", delta: 1, wrap: true }),
    ).toBe("host");
    expect(
      stepRunContextTab({ navigableTabs: tabs, currentTab: "host", delta: -1, wrap: true }),
    ).toBe("branch");
  });
});

describe("resolveCycledEnvironmentId", () => {
  const environmentIds = [arch, vigilia, office];

  it("moves to the next machine and wraps", () => {
    expect(
      resolveCycledEnvironmentId({
        environmentIds,
        currentEnvironmentId: arch,
        automatic: false,
        delta: 1,
      }),
    ).toBe(vigilia);
    expect(
      resolveCycledEnvironmentId({
        environmentIds,
        currentEnvironmentId: office,
        automatic: false,
        delta: 1,
      }),
    ).toBe(arch);
  });

  it("starts at the first machine from automatic routing", () => {
    expect(
      resolveCycledEnvironmentId({
        environmentIds,
        currentEnvironmentId: vigilia,
        automatic: true,
        delta: 1,
      }),
    ).toBe(arch);
  });

  it("returns null with no machines", () => {
    expect(
      resolveCycledEnvironmentId({
        environmentIds: [],
        currentEnvironmentId: arch,
        automatic: false,
        delta: 1,
      }),
    ).toBeNull();
  });
});

describe("resolveToggledEnvMode", () => {
  it("flips between the current checkout and a new worktree", () => {
    expect(resolveToggledEnvMode("local")).toBe("worktree");
    expect(resolveToggledEnvMode("worktree")).toBe("local");
  });
});

describe("stepOptionSelection", () => {
  const values = ["local", "worktree", "previous"];

  it("moves one chip and stops at the ends", () => {
    expect(stepOptionSelection({ values, selected: "local", delta: 1 })).toBe("worktree");
    expect(stepOptionSelection({ values, selected: "previous", delta: 1 })).toBe("previous");
    expect(stepOptionSelection({ values, selected: "local", delta: -1 })).toBe("local");
  });

  it("enters the list from the matching end when nothing is selected", () => {
    expect(stepOptionSelection({ values, selected: null, delta: 1 })).toBe("local");
    expect(stepOptionSelection({ values, selected: null, delta: -1 })).toBe("previous");
  });
});

describe("resolveDigitOptionIndex", () => {
  it("maps 1–9 to a zero-based index and ignores other keys", () => {
    expect(resolveDigitOptionIndex("1")).toBe(0);
    expect(resolveDigitOptionIndex("9")).toBe(8);
    expect(resolveDigitOptionIndex("0")).toBeNull();
    expect(resolveDigitOptionIndex("a")).toBeNull();
  });
});

describe("isRunContextHostReachable", () => {
  it("keeps connected and first-attempt hosts only", () => {
    expect(isRunContextHostReachable("connected")).toBe(true);
    expect(isRunContextHostReachable("connecting")).toBe(true);
    // A stopped server sits in reconnecting forever while the client retries.
    expect(isRunContextHostReachable("reconnecting")).toBe(false);
    expect(isRunContextHostReachable("offline")).toBe(false);
    expect(isRunContextHostReachable("error")).toBe(false);
    expect(isRunContextHostReachable("available")).toBe(false);
    expect(isRunContextHostReachable(undefined)).toBeUndefined();
  });
});

describe("resolveRunContextHosts", () => {
  const host = (environmentId: EnvironmentId, reachable?: boolean): EnvironmentOption => ({
    environmentId,
    projectId: `project-${environmentId}` as EnvironmentOption["projectId"],
    label: environmentId,
    isPrimary: false,
    machine: "server",
    ...(reachable === undefined ? {} : { reachable }),
  });

  it("drops every unreachable host, the current one included", () => {
    const hosts = [host(arch, true), host(vigilia, false), host(office)];
    expect(resolveRunContextHosts(hosts).map((entry) => entry.environmentId)).toEqual([
      arch,
      office,
    ]);
  });
});

describe("resolveRunContextTabRequest", () => {
  const navigableTabs = ["host", "workspace", "branch"] as const;

  it("opens a closed drawer on the requested tab", () => {
    expect(
      resolveRunContextTabRequest({
        drawerOpen: false,
        activeTab: null,
        requestedTab: "branch",
        navigableTabs,
      }),
    ).toEqual({ kind: "open", tab: "branch" });
  });

  it("switches an open drawer to another tab, and closes on the same tab", () => {
    expect(
      resolveRunContextTabRequest({
        drawerOpen: true,
        activeTab: "host",
        requestedTab: "branch",
        navigableTabs,
      }),
    ).toEqual({ kind: "switch", tab: "branch" });
    expect(
      resolveRunContextTabRequest({
        drawerOpen: true,
        activeTab: "branch",
        requestedTab: "branch",
        navigableTabs,
      }),
    ).toEqual({ kind: "close" });
  });

  it("closes an open drawer on its own toggle", () => {
    expect(
      resolveRunContextTabRequest({
        drawerOpen: true,
        activeTab: "workspace",
        requestedTab: null,
        navigableTabs,
      }),
    ).toEqual({ kind: "close" });
  });
});
