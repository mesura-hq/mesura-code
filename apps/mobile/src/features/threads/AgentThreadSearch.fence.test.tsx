// @vitest-environment happy-dom
// Application entry points: HomeRouteScreen on a phone-width Android window
// (the home header search) and AdaptiveWorkspaceLayout around HomeRouteScreen
// on a tablet-width Android window (the ThreadNavigationSidebar search), each
// under the app's atom registry with ConfirmDialogHost at the root. See
// agentThreadSearch.testMount.tsx for the harness and the mocked boundaries.
//
// Fence for phase 5 of agent thread search: the mobile agent mode. The shared
// coordinator is replaced by an atom family with the real one's shape and
// cancellation semantics whose verdicts each test settles by hand; the mode
// switch, the description field, the result rows, the unarchive prompt, and
// navigation are the application's own.
import "./agentThreadSearch.testMocks";

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  agentMatch,
  agentSearchFixture,
  archivedUploadShell,
  ARCHIVED_UPLOAD_TITLE,
  commandFailure,
  commandSuccess,
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
  agentDescriptionField,
  agentResult,
  agentResults,
  enterAgentMode,
  latestAgentCall,
  leaveAgentMode,
  mountHome,
  mountSidebar,
  openedThreads,
  pressPromptButton,
  promptText,
  resolveAgentSearch,
  resultDescription,
  settle,
  sidebarElement,
  submitAgentDescription,
  textField,
  textFields,
  threadRowTitles,
  typeInto,
  visibleFeedback,
  visibleText,
  press,
  AGENT_DESCRIPTION_NAME,
  type MountedApp,
} from "./agentThreadSearch.testMount";

const DESCRIPTION = "the chat where we argued about the tablet sidebar statistics";

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

/** The two Android thread-search surfaces, each with its own search state. */
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

/** Mounts a surface, enters agent mode there, and submits `description`. */
async function startAgentSearch(
  surface: (typeof SURFACES)[number],
  description: string = DESCRIPTION,
): Promise<void> {
  app = await surface.mount();
  await enterAgentMode(surface.root());
  await submitAgentDescription(surface.root(), description);
}

describe.each(SURFACES)("P5 mobile agent search on $name", (surface) => {
  it(`P5 RED mobile agent search entry sits beside exact-word search on ${surface.name}`, async () => {
    app = await surface.mount();
    const root = surface.root();

    // Both entry points are visible at once: agent mode does not replace the field.
    expect(textFields(/^search threads$/i, root)).toHaveLength(1);
    await enterAgentMode(root);
    expect(agentDescriptionField(surface.root())).toBeDefined();

    await leaveAgentMode(surface.root());
    expect(textFields(AGENT_DESCRIPTION_NAME, surface.root())).toHaveLength(0);
    await typeInto(textField(/^search threads$/i, surface.root()), "hosts");
    expect(threadRowTitles(surface.root())).toEqual([HOSTS_DOCK_TITLE]);
    expect(agentSearchFixture.agentCalls).toHaveLength(0);
  });

  it(`P5 RED mobile agent search sends the description to every connected environment on ${surface.name}`, async () => {
    await startAgentSearch(surface);

    const call = latestAgentCall();
    expect(call.input.description).toContain(DESCRIPTION);
    expect(
      [...call.input.environments].sort((a, b) => a.environmentId.localeCompare(b.environmentId)),
    ).toEqual([
      { environmentId: LAPTOP_ENVIRONMENT_ID, label: LAPTOP_LABEL },
      { environmentId: VIGILIA_ENVIRONMENT_ID, label: VIGILIA_LABEL },
    ]);
    expect([LAPTOP_ENVIRONMENT_ID, VIGILIA_ENVIRONMENT_ID]).toContain(
      call.input.modelEnvironmentId,
    );
  });

  it(`P5 RED mobile agent search ranks results with reasons and scoped labels on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches: [hostsDockMatch, paneFocusMatch],
      coverage: FULL_COVERAGE,
    });

    const hosts = agentResult(HOSTS_DOCK_TITLE, surface.root());
    const pane = agentResult(PANE_FOCUS_TITLE, surface.root());
    expect(resultDescription(hosts)).toContain(hostsDockMatch.reason);
    expect(resultDescription(hosts)).toContain(HQ_PROJECT_TITLE);
    expect(resultDescription(hosts)).toContain(VIGILIA_LABEL);
    expect(resultDescription(pane)).toContain(paneFocusMatch.reason);
    expect(resultDescription(pane)).toContain(MESURA_PROJECT_TITLE);
    expect(resultDescription(pane)).toContain(LAPTOP_LABEL);
    // The coordinator's ranking is the display order.
    expect(hosts.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it(`P5 RED mobile agent search opens an active result in its environment on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches: [hostsDockMatch, paneFocusMatch],
      coverage: FULL_COVERAGE,
    });

    await press(agentResult(HOSTS_DOCK_TITLE, surface.root()));
    expect(openedThreads()).toEqual([
      { environmentId: VIGILIA_ENVIRONMENT_ID, threadId: "mobile-thread-hosts-dock" },
    ]);
    expect(agentSearchFixture.commandCalls).toEqual([]);
  });

  it(`P5 RED mobile agent search unarchives an archived result only after confirmation on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches: [archivedUploadMatch],
      coverage: FULL_COVERAGE,
    });

    await press(agentResult(ARCHIVED_UPLOAD_TITLE, surface.root()));
    // Asked first: nothing is unarchived or opened before the answer.
    expect(promptText()).toMatch(/unarchive/i);
    expect(promptText()).toContain(ARCHIVED_UPLOAD_TITLE);
    expect(agentSearchFixture.commandCalls).toEqual([]);
    expect(openedThreads()).toEqual([]);

    let settleUnarchive!: (result: ReturnType<typeof commandSuccess>) => void;
    agentSearchFixture.commandReplies.set(
      UNARCHIVE_COMMAND_LABEL,
      () =>
        new Promise((resolve) => {
          settleUnarchive = resolve;
        }),
    );
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
    // Still unarchiving: the thread does not open yet.
    expect(openedThreads()).toEqual([]);

    await act(async () => settleUnarchive(commandSuccess()));
    // The shell stream delivers the unarchived thread, as it does after the command.
    deliverThreadShell(archivedUploadShell(null));
    await settle();
    expect(openedThreads()).toEqual([
      { environmentId: VIGILIA_ENVIRONMENT_ID, threadId: "mobile-thread-archived-upload" },
    ]);
  });

  it(`P5 RED mobile agent search keeps a declined archived result archived on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches: [archivedUploadMatch],
      coverage: FULL_COVERAGE,
    });

    await press(agentResult(ARCHIVED_UPLOAD_TITLE, surface.root()));
    expect(promptText()).toMatch(/unarchive/i);
    await pressPromptButton(/cancel/i);
    expect(agentSearchFixture.commandCalls).toEqual([]);
    expect(openedThreads()).toEqual([]);
    expect(agentResults(ARCHIVED_UPLOAD_TITLE, surface.root())).toHaveLength(1);
  });

  it(`P5 RED mobile agent search reports a failed unarchive without opening on ${surface.name}`, async () => {
    agentSearchFixture.commandReplies.set(UNARCHIVE_COMMAND_LABEL, async () =>
      commandFailure("Environment went away"),
    );
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches: [archivedUploadMatch],
      coverage: FULL_COVERAGE,
    });

    await press(agentResult(ARCHIVED_UPLOAD_TITLE, surface.root()));
    await pressPromptButton(/unarchive/i);
    expect(agentSearchFixture.commandCalls.map((call) => call.label)).toEqual([
      UNARCHIVE_COMMAND_LABEL,
    ]);
    expect(visibleFeedback(surface.root())).toMatch(/could not unarchive|environment went away/i);
    expect(openedThreads()).toEqual([]);
  });

  it(`P5 RED mobile agent search shows progress and cancels when leaving agent mode on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    const call = latestAgentCall();
    expect(visibleText(surface.root())).toMatch(/searching/i);
    expect(call.interrupted).toBe(false);

    await leaveAgentMode(surface.root());
    expect(call.interrupted).toBe(true);
    expect(textFields(/^search threads$/i, surface.root())).toHaveLength(1);

    // Coming back shows no stale progress from the cancelled search.
    await enterAgentMode(surface.root());
    expect(visibleText(surface.root())).not.toMatch(/searching/i);
  });

  it(`P5 RED mobile agent search cancels when the surface unmounts on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    const call = latestAgentCall();
    expect(call.interrupted).toBe(false);

    await app!.unmount();
    app = undefined;
    expect(call.interrupted).toBe(true);
  });

  it(`P5 RED mobile agent search names unreachable environments in a partial result on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "matches",
      matches: [paneFocusMatch],
      coverage: {
        unavailableEnvironments: [{ environmentId: VIGILIA_ENVIRONMENT_ID, label: VIGILIA_LABEL }],
        budgetExhausted: true,
        unreadEvidence: false,
      },
    });

    expect(agentResults(PANE_FOCUS_TITLE, surface.root())).toHaveLength(1);
    const text = visibleText(surface.root());
    // The only Vigilia text on screen is the coverage note: no Vigilia result exists.
    expect(text).toContain(VIGILIA_LABEL);
    expect(text).toMatch(/limit/i);
  });

  it(`P5 RED mobile agent search shows when no thread matches confidently on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "noConfidentMatch",
      coverage: FULL_COVERAGE,
    });

    expect(visibleText(surface.root())).toMatch(/no confident match/i);
    expect(agentResults(HOSTS_DOCK_TITLE, surface.root())).toHaveLength(0);
    expect(agentResults(PANE_FOCUS_TITLE, surface.root())).toHaveLength(0);
  });

  it(`P5 RED mobile agent search tells a model failure from a retrieval failure on ${surface.name}`, async () => {
    await startAgentSearch(surface);
    await resolveAgentSearch(latestAgentCall(), {
      status: "failed",
      failure: "model",
      coverage: FULL_COVERAGE,
    });
    const modelFailure = visibleText(surface.root());
    expect(modelFailure).toMatch(/model/i);

    await submitAgentDescription(surface.root(), `${DESCRIPTION} from last week`);
    expect(agentSearchFixture.agentCalls).toHaveLength(2);
    await resolveAgentSearch(latestAgentCall(), {
      status: "failed",
      failure: "retrieval",
      coverage: FULL_COVERAGE,
    });
    const retrievalFailure = visibleText(surface.root());
    expect(retrievalFailure).not.toMatch(/model/i);
    expect(retrievalFailure).toMatch(/could not|failed/i);
  });
});
