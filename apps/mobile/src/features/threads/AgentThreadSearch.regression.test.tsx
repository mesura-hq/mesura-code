// @vitest-environment happy-dom
// Application entry points: HomeRouteScreen on a phone-width Android window and
// AdaptiveWorkspaceLayout around it on a tablet-width window (the
// ThreadNavigationSidebar search), under the app's atom registry with
// ConfirmDialogHost at the root. The iOS cases mount the shared AgentThreadSearch
// surface alone: iOS keeps its native exact-word search and has no visible entry
// to agent mode, yet the shared component must still work there. See
// agentThreadSearch.testMount.tsx for the harness and the mocked boundaries.
//
// Regressions for phase 5 of agent thread search: behavior the fence covered
// only indirectly.
import "./agentThreadSearch.testMocks";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  agentMatch,
  agentSearchFixture,
  archivedUploadShell,
  ARCHIVED_UPLOAD_TITLE,
  deliverThreadShell,
  FULL_COVERAGE,
  HOSTS_DOCK_TITLE,
  HQ_PROJECT_ID,
  HQ_PROJECT_TITLE,
  LAPTOP_ENVIRONMENT_ID,
  LAPTOP_LABEL,
  MESURA_PROJECT_ID,
  MESURA_PROJECT_TITLE,
  PANE_FOCUS_TITLE,
  resetAgentSearchFixture,
  UNARCHIVE_COMMAND_LABEL,
  VIGILIA_ENVIRONMENT_ID,
  VIGILIA_LABEL,
} from "./agentThreadSearch.testMocks";
import {
  agentResult,
  enterAgentMode,
  latestAgentCall,
  mountAgentThreadSearch,
  mountHome,
  mountSidebar,
  openedThreads,
  press,
  pressPromptButton,
  promptText,
  resolveAgentSearch,
  resultDescription,
  settle,
  sidebarElement,
  submitAgentDescription,
  type MountedApp,
} from "./agentThreadSearch.testMount";

const DESCRIPTION = "the thread about sidebar host statistics";

const hostsDockMatch = agentMatch({
  environmentId: VIGILIA_ENVIRONMENT_ID,
  environmentLabel: VIGILIA_LABEL,
  threadId: "mobile-thread-hosts-dock",
  projectId: HQ_PROJECT_ID,
  projectTitle: HQ_PROJECT_TITLE,
  threadTitle: HOSTS_DOCK_TITLE,
  reason: "Compares CPU and memory panels for every host",
});

const paneFocusMatch = agentMatch({
  environmentId: LAPTOP_ENVIRONMENT_ID,
  environmentLabel: LAPTOP_LABEL,
  threadId: "mobile-thread-pane-focus",
  projectId: MESURA_PROJECT_ID,
  projectTitle: MESURA_PROJECT_TITLE,
  threadTitle: PANE_FOCUS_TITLE,
  reason: "Mentions a sidebar outline around the focused pane",
});

const archivedUploadMatch = agentMatch({
  environmentId: VIGILIA_ENVIRONMENT_ID,
  environmentLabel: VIGILIA_LABEL,
  threadId: "mobile-thread-archived-upload",
  projectId: HQ_PROJECT_ID,
  projectTitle: HQ_PROJECT_TITLE,
  threadTitle: ARCHIVED_UPLOAD_TITLE,
  reason: "Decided to stream large files over the tailnet",
  archivedAt: "2026-09-21T00:00:00.000Z",
});

const SURFACES = [
  { name: "home", mount: mountHome, root: (): ParentNode => document.body },
  { name: "sidebar", mount: mountSidebar, root: (): ParentNode => sidebarElement() },
] as const;

let app: MountedApp | undefined;

beforeEach(() => {
  resetAgentSearchFixture();
});

afterEach(async () => {
  await app?.unmount();
  app = undefined;
});

describe.each(SURFACES)("P5 mobile agent search regressions on $name", (surface) => {
  it(`P5 REGRESSION mobile agent search reopens the same active result on each press on ${surface.name}`, async () => {
    app = await surface.mount();
    await enterAgentMode(surface.root());
    await submitAgentDescription(surface.root(), DESCRIPTION);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches: [hostsDockMatch],
      coverage: FULL_COVERAGE,
    });
    const hosts = { environmentId: VIGILIA_ENVIRONMENT_ID, threadId: "mobile-thread-hosts-dock" };

    await press(agentResult(HOSTS_DOCK_TITLE, surface.root()));
    expect(openedThreads()).toEqual([hosts]);

    // A later shell update for the same thread is not a new selection.
    deliverThreadShell({
      ...agentSearchFixture.threads.find((thread) => thread.id === hosts.threadId)!,
      updatedAt: "2026-09-29T13:00:00.000Z",
    });
    await settle();
    expect(openedThreads()).toEqual([hosts]);

    // Coming back to the results and choosing the same thread opens it again.
    await press(agentResult(HOSTS_DOCK_TITLE, surface.root()));
    expect(openedThreads()).toEqual([hosts, hosts]);
  });
});

describe("P5 shared agent search surface on iOS", () => {
  beforeEach(() => {
    agentSearchFixture.platform = "ios";
  });

  async function searchOnIos(
    matches: ReadonlyArray<typeof hostsDockMatch>,
    onOpenThread: (thread: EnvironmentThreadShell) => void,
  ) {
    app = await mountAgentThreadSearch({ onOpenThread });
    await submitAgentDescription(document.body, DESCRIPTION);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches,
      coverage: FULL_COVERAGE,
    });
  }

  it("P5 REGRESSION iOS shared agent search submits, ranks, and opens an active result", async () => {
    const onOpenThread = vi.fn<(thread: EnvironmentThreadShell) => void>();
    await searchOnIos([hostsDockMatch, paneFocusMatch], onOpenThread);

    expect(latestAgentCall().input.description).toBe(DESCRIPTION);
    const hosts = agentResult(HOSTS_DOCK_TITLE);
    const pane = agentResult(PANE_FOCUS_TITLE);
    expect(resultDescription(hosts)).toContain(hostsDockMatch.reason);
    expect(resultDescription(hosts)).toContain(`${HQ_PROJECT_TITLE} · ${VIGILIA_LABEL}`);
    expect(hosts.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await press(pane);
    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(onOpenThread.mock.calls[0]![0]).toMatchObject({
      environmentId: LAPTOP_ENVIRONMENT_ID,
      id: "mobile-thread-pane-focus",
    });
  });

  it("P5 REGRESSION iOS shared agent search confirms an archived result through the native alert", async () => {
    const onOpenThread = vi.fn<(thread: EnvironmentThreadShell) => void>();
    await searchOnIos([archivedUploadMatch], onOpenThread);

    await press(agentResult(ARCHIVED_UPLOAD_TITLE));
    // iOS asks through the platform alert, not the Android dialog host.
    expect(agentSearchFixture.alerts).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(promptText()).toContain(ARCHIVED_UPLOAD_TITLE);
    expect(agentSearchFixture.commandCalls).toEqual([]);

    await pressPromptButton(/unarchive/i);
    expect(agentSearchFixture.commandCalls).toEqual([
      {
        label: UNARCHIVE_COMMAND_LABEL,
        value: {
          environmentId: VIGILIA_ENVIRONMENT_ID,
          input: { threadId: archivedUploadMatch.threadId },
        },
      },
    ]);
    expect(onOpenThread).not.toHaveBeenCalled();

    await act(async () => deliverThreadShell(archivedUploadShell(null)));
    await settle();
    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(onOpenThread.mock.calls[0]![0]).toMatchObject({
      environmentId: VIGILIA_ENVIRONMENT_ID,
      id: "mobile-thread-archived-upload",
      archivedAt: null,
    });
  });
});
