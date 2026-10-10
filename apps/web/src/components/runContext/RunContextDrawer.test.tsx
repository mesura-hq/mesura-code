// @vitest-environment happy-dom
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { dispatchPickerAction } from "../../lib/pickerActionBus";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";
import { RunContextDrawer } from "./RunContextDrawer";
import { useRunContextController } from "./useRunContextController";

const hosts: EnvironmentOption[] = [
  {
    environmentId: "arch" as EnvironmentId,
    projectId: "project-arch" as ProjectId,
    label: "Arch",
    isPrimary: true,
    machine: "laptop",
  },
  {
    environmentId: "vigilia-home" as EnvironmentId,
    projectId: "project-vigilia" as ProjectId,
    label: "Vigilia Home",
    isPrimary: false,
    machine: "server",
  },
];

const calls = {
  environmentChanges: [] as EnvironmentId[],
  envModeChanges: [] as Array<{ mode: EnvMode; focusComposer: boolean | undefined }>,
  composerFocusRequests: 0,
};

interface HarnessProps {
  threadStarted: boolean;
  hosts: readonly EnvironmentOption[];
}

/** The real controller and drawer, with the draft state a ChatView would own. */
function Harness(props: HarnessProps) {
  const [environmentId, setEnvironmentId] = useState(props.hosts[0]!.environmentId);
  const [envMode, setEnvMode] = useState<EnvMode>("local");
  const runContext = useRunContextController({
    environmentId,
    availableEnvironments: props.hosts,
    envLocked: props.threadStarted,
    isDraft: !props.threadStarted,
    envModeLocked: props.threadStarted,
    showGitControls: true,
    autoEnvironmentLabel: undefined,
    onEnvironmentChange: (next) => {
      calls.environmentChanges.push(next);
      setEnvironmentId(next);
    },
    effectiveEnvMode: envMode,
    activeWorktreePath: null,
    onEnvModeChange: (mode, options) => {
      calls.envModeChanges.push({ mode, focusComposer: options?.focusComposer });
      setEnvMode(mode);
    },
    onComposerFocusRequest: () => {
      calls.composerFocusRequests += 1;
    },
  });
  return runContext.drawerOpen ? (
    <RunContextDrawer
      {...runContext.drawerProps}
      branchLabel="dev"
      branchPanel={runContext.activeTab === "branch" ? <input aria-label="Search refs" /> : null}
    />
  ) : null;
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.environmentChanges = [];
  calls.envModeChanges = [];
  calls.composerFocusRequests = 0;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(options: Partial<HarnessProps> = {}) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Harness threadStarted={options.threadStarted ?? false} hosts={options.hosts ?? hosts} />,
    );
  });
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

async function dispatch(action: Parameters<typeof dispatchPickerAction>[0]) {
  await act(async () => dispatchPickerAction(action));
}

const drawer = () => container.querySelector("[data-run-context-drawer]");
const activeTab = () =>
  container
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute("data-run-context-tab");
const focusedOption = () =>
  document.activeElement?.getAttribute("role") === "radio"
    ? document.activeElement.textContent
    : null;

it("chooses host and workspace in one pass and closes on Enter", async () => {
  await mount();
  await dispatch("runContext.toggle");
  expect(activeTab()).toBe("host");
  expect(focusedOption()).toContain("Arch");

  await press("ArrowDown");
  expect(calls.environmentChanges).toEqual(["vigilia-home"]);
  expect(focusedOption()).toContain("Vigilia Home");

  await press("Tab");
  expect(activeTab()).toBe("workspace");
  await press("ArrowDown");
  // The drawer keeps the keyboard, so the change must not pull focus away.
  expect(calls.envModeChanges).toEqual([{ mode: "worktree", focusComposer: false }]);

  await press("Enter");
  expect(drawer()).toBeNull();
  expect(calls.composerFocusRequests).toBe(1);
});

it("lists only real hosts and the two workspace choices", async () => {
  await mount();
  await dispatch("runContext.toggle");
  const hostOptions = [...container.querySelectorAll('[role="radio"]')].map(
    (option) => option.textContent,
  );
  expect(hostOptions).toHaveLength(2);
  expect(hostOptions.join(" ")).not.toContain("Auto");

  await press("Tab");
  const workspaceOptions = [...container.querySelectorAll('[role="radio"]')].map(
    (option) => option.textContent,
  );
  expect(workspaceOptions).toHaveLength(2);
  expect(workspaceOptions[0]).toContain("Current checkout");
  expect(workspaceOptions[1]).toContain("New worktree");
});

it("wraps Tab from the branch search back to the host tab", async () => {
  await mount();
  await dispatch("runContext.toggle");
  await press("Tab");
  await press("Tab");
  expect(activeTab()).toBe("branch");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search refs");

  await press("Tab");
  expect(activeTab()).toBe("host");
});

it("opens a started thread on its branch, with host and workspace locked", async () => {
  await mount({ threadStarted: true });
  await dispatch("runContext.toggle");
  expect(activeTab()).toBe("branch");
  const lockedTabs = [...container.querySelectorAll('[role="tab"]:disabled')].map((tab) =>
    tab.getAttribute("data-run-context-tab"),
  );
  expect(lockedTabs).toEqual(["host", "workspace"]);

  await dispatch("runContext.cycleMachine");
  await dispatch("runContext.toggleWorkspace");
  expect(calls.environmentChanges).toEqual([]);
  expect(calls.envModeChanges).toEqual([]);
});

it("cycles the host and flips the workspace with the drawer closed", async () => {
  await mount();
  await dispatch("runContext.cycleMachine");
  await dispatch("runContext.cycleMachine");
  expect(calls.environmentChanges).toEqual(["vigilia-home", "arch"]);

  await dispatch("runContext.toggleWorkspace");
  // With the drawer closed, the composer takes the keyboard back.
  expect(calls.envModeChanges).toEqual([{ mode: "worktree", focusComposer: true }]);
  expect(drawer()).toBeNull();
});

it("closes on Escape and gives the keyboard back to the composer", async () => {
  await mount();
  await dispatch("runContext.toggle");
  await press("Escape");
  expect(drawer()).toBeNull();
  expect(calls.composerFocusRequests).toBe(1);
});

it("opens straight on Branch with the keyboard in its search field", async () => {
  await mount();
  await dispatch("branch");
  expect(activeTab()).toBe("branch");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search refs");
  // The keyboard is inside, so Escape reaches the drawer.
  await press("Escape");
  expect(drawer()).toBeNull();
});

it("moves an open drawer to the requested tab and closes on a second request", async () => {
  await mount();
  await dispatch("runContext.toggle");
  expect(activeTab()).toBe("host");
  await dispatch("branch");
  expect(activeTab()).toBe("branch");
  await dispatch("branch");
  expect(drawer()).toBeNull();
});

it("keeps a locked Host tab with a single machine", async () => {
  await mount({ hosts: [hosts[0]!] });
  await dispatch("runContext.toggle");
  const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => [
    tab.getAttribute("data-run-context-tab"),
    (tab as HTMLButtonElement).disabled,
  ]);
  expect(tabs).toEqual([
    ["host", true],
    ["workspace", false],
    ["branch", false],
  ]);
  expect(activeTab()).toBe("workspace");
});

it("leaves unreachable machines out of the list and the cycle", async () => {
  const office: EnvironmentOption = {
    environmentId: "office" as EnvironmentId,
    projectId: "project-office" as ProjectId,
    label: "Office",
    isPrimary: false,
    machine: "desktop",
    reachable: false,
  };
  await mount({ hosts: [...hosts, office] });
  await dispatch("runContext.toggle");
  const hostOptions = [...container.querySelectorAll('[role="radio"]')].map(
    (option) => option.textContent,
  );
  expect(hostOptions.join(" ")).not.toContain("Office");

  await press("Escape");
  await dispatch("runContext.cycleMachine");
  await dispatch("runContext.cycleMachine");
  expect(calls.environmentChanges).toEqual(["vigilia-home", "arch"]);
});

it("names an unreachable current machine but never offers or cycles back to it", async () => {
  const offlineArch: EnvironmentOption = { ...hosts[0]!, reachable: false };
  await mount({ hosts: [offlineArch, hosts[1]!] });
  await dispatch("runContext.toggle");
  // The tab still says where the draft points.
  expect(container.querySelector('[data-run-context-tab="host"]')?.textContent).toContain("Arch");
  const hostOptions = [...container.querySelectorAll('[role="radio"]')].map(
    (option) => option.textContent,
  );
  expect(hostOptions).toHaveLength(1);
  expect(hostOptions[0]).toContain("Vigilia Home");

  await press("Escape");
  await dispatch("runContext.cycleMachine");
  await dispatch("runContext.cycleMachine");
  // The first press leaves the offline machine; the second has nowhere else
  // reachable to go, so it never returns to it.
  expect(calls.environmentChanges).toEqual(["vigilia-home"]);
});
