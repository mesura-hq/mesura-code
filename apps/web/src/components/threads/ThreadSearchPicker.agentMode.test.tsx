// @vitest-environment happy-dom
/**
 * Entry point: AppRoot → CommandPalette. A memory router renders the real
 * CommandPalette around the routed outlet, and every picker is reached the way
 * a user reaches it: Ctrl+Alt+K (`threadSearch.toggle`) opens ThreadSearchPicker
 * through the palette's keyboard route. The fixture replaces data sources only:
 * environments, entity shells, the lexical search query, the shared
 * `orchestrationEnvironment.agentThreadSearch` atom family (same shape and
 * cancellation semantics, hand-settled results), and the RPC command boundary.
 *
 * Phase 4 acceptance criteria 1–5 of the agent thread search plan. Criterion 6
 * is pinned by `ThreadSearchPicker.guards.test.tsx`.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toastManager } from "../ui/toast";

vi.mock("~/state/entities", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockEntities(await original()),
);
vi.mock("~/state/environments", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockEnvironments(await original()),
);
vi.mock("~/state/queries", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockQueries(await original()),
);
vi.mock("~/state/orchestration", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockOrchestration(await original()),
);
vi.mock("~/state/use-atom-command", async () =>
  (await import("./threadSearchPicker.testFixtures")).mockUseAtomCommand(),
);
vi.mock("~/hooks/useSettings", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockSettings(await original()),
);

import {
  agentMatch,
  commandFailure,
  commandSuccess,
  deliverThreadShell,
  FULL_COVERAGE,
  HQ_PROJECT_ID,
  LAPTOP_ENVIRONMENT_ID,
  MESURA_PROJECT_ID,
  resetThreadSearchFixture,
  setEnvironmentConnectionPhase,
  threadSearchFixture,
  threadShell,
  UNARCHIVE_COMMAND_LABEL,
  VIGILIA_ENVIRONMENT_ID,
  type AgentSearchCall,
} from "./threadSearchPicker.testFixtures";
import {
  activeSearchMode,
  AGENT_MODE_NAME,
  alertDialog,
  buttonIn,
  click,
  currentPath,
  EXACT_MODE_NAME,
  focusIsInPickerTextField,
  isHighlighted,
  modeControl,
  mountApp,
  openThreadSearch,
  optionRows,
  paletteElement,
  paletteMode,
  pickerTextField,
  pressKey,
  resolveAgentSearch,
  settle,
  submitDescription,
  threadSearchPicker,
  typeInto,
  type MountedApp,
} from "./threadSearchPicker.testMount";

const DESCRIPTION = "the chat where the file tree lagged when I held the arrow keys";

const HOSTS_DOCK_MATCH = agentMatch({
  environmentId: VIGILIA_ENVIRONMENT_ID,
  environmentLabel: "Vigilia",
  threadId: "thread-hosts-dock-plan",
  projectId: HQ_PROJECT_ID,
  projectTitle: "Mesura HQ",
  threadTitle: "Hosts dock plan",
  reason: "Planned how the dock lists each host",
});

const ARROW_LAG_MATCH = agentMatch({
  environmentId: LAPTOP_ENVIRONMENT_ID,
  environmentLabel: "Laptop",
  threadId: "thread-arrow-lag",
  projectId: MESURA_PROJECT_ID,
  projectTitle: "Mesura Code",
  threadTitle: "File tree arrow-key lag",
  reason: "Measured the delay while holding an arrow key in the tree",
});

const ARCHIVED_LAG_MATCH = agentMatch({
  environmentId: LAPTOP_ENVIRONMENT_ID,
  environmentLabel: "Laptop",
  threadId: "thread-archived-lag",
  projectId: MESURA_PROJECT_ID,
  projectTitle: "Mesura Code",
  threadTitle: "Older tree lag investigation",
  reason: "Profiled the tree's key handler before the fix",
  archivedAt: "2026-09-20T09:00:00.000Z",
});

let app: MountedApp;

beforeEach(async () => {
  resetThreadSearchFixture();
  app = await mountApp();
});

afterEach(async () => {
  await app.unmount();
  vi.restoreAllMocks();
});

async function enterAgentMode(): Promise<void> {
  await openThreadSearch();
  await pressKey(pickerTextField(), "Tab");
  expect(activeSearchMode()).toBe("agent");
}

function agentCall(index: number): AgentSearchCall {
  const call = threadSearchFixture.agentCalls[index];
  expect(
    call,
    `Expected agent search #${index + 1}; ${threadSearchFixture.agentCalls.length} were started`,
  ).toBeDefined();
  return call!;
}

async function searchAndShow(matches: ReadonlyArray<ReturnType<typeof agentMatch>>): Promise<void> {
  await enterAgentMode();
  await submitDescription(DESCRIPTION);
  await resolveAgentSearch(agentCall(0), {
    status: "matches",
    matches,
    coverage: FULL_COVERAGE,
  });
  expect(optionRows()).toHaveLength(matches.length);
}

/** Moves the highlight with the arrow keys from the text field until `index` is lit. */
async function highlightRow(index: number): Promise<void> {
  for (let press = 0; press <= index + 1; press += 1) {
    if (optionRows()[index] && isHighlighted(optionRows()[index]!)) return;
    await pressKey(pickerTextField(), "ArrowDown");
  }
  expect(isHighlighted(optionRows()[index]!)).toBe(true);
}

function unarchiveCalls() {
  return threadSearchFixture.commandCalls.filter((call) => call.label === UNARCHIVE_COMMAND_LABEL);
}

/** The active shell the shell stream upserts once the unarchive has landed. */
function unarchivedShell(match: ReturnType<typeof agentMatch>) {
  return threadShell({
    environmentId: match.environmentId,
    id: match.threadId,
    projectId: match.projectId,
    title: match.threadTitle,
  });
}

function threadPath(match: ReturnType<typeof agentMatch>): string {
  return `/${match.environmentId}/${match.threadId}`;
}

describe("agent search criterion 1: switching between exact words and agent mode", () => {
  it("agent search: Tab on the thread-search input enters agent mode and Tab returns to exact words", async () => {
    await openThreadSearch();
    expect(paletteMode()).toBe("threads");
    expect(focusIsInPickerTextField()).toBe(true);
    expect(activeSearchMode()).toBe("exact");
    expect(optionRows().map((row) => row.textContent)).toContainEqual(
      expect.stringContaining("Rename keybind chord"),
    );

    const enter = await pressKey(pickerTextField(), "Tab");
    expect(enter.defaultPrevented).toBe(true);
    expect(activeSearchMode()).toBe("agent");
    expect(paletteMode()).toBe("threads");
    expect(focusIsInPickerTextField()).toBe(true);
    expect(optionRows().map((row) => row.textContent)).not.toContainEqual(
      expect.stringContaining("Rename keybind chord"),
    );

    const leave = await pressKey(pickerTextField(), "Tab");
    expect(leave.defaultPrevented).toBe(true);
    expect(activeSearchMode()).toBe("exact");
    expect(focusIsInPickerTextField()).toBe(true);
    expect(optionRows().map((row) => row.textContent)).toContainEqual(
      expect.stringContaining("Rename keybind chord"),
    );
  });

  it("agent search: the visible mode control switches both ways and hands focus back to the text field", async () => {
    await openThreadSearch();
    const agentSegment = modeControl(AGENT_MODE_NAME);
    expect(agentSegment, "Expected a visible agent-mode control").not.toBeNull();

    await click(agentSegment!);
    expect(activeSearchMode()).toBe("agent");
    expect(focusIsInPickerTextField()).toBe(true);

    const exactSegment = modeControl(EXACT_MODE_NAME);
    expect(exactSegment, "Expected a visible exact-words control").not.toBeNull();
    await click(exactSegment!);
    expect(activeSearchMode()).toBe("exact");
    expect(focusIsInPickerTextField()).toBe(true);
    expect(paletteMode()).toBe("threads");
  });

  it("agent search: Tab while the mode control owns focus moves focus normally instead of switching modes", async () => {
    await openThreadSearch();
    const agentSegment = modeControl(AGENT_MODE_NAME);
    expect(agentSegment, "Expected a visible agent-mode control").not.toBeNull();
    agentSegment!.focus();
    expect(document.activeElement).toBe(agentSegment);

    const tab = await pressKey(agentSegment!, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(activeSearchMode()).toBe("exact");
  });
});

describe("agent search criterion 2: describe, see progress, refine, and get ranked links", () => {
  it("agent search: a submitted description shows progress, then ranked links with reasons and project and environment labels", async () => {
    await enterAgentMode();
    await submitDescription(DESCRIPTION);

    expect(threadSearchFixture.agentCalls).toHaveLength(1);
    const call = agentCall(0);
    expect(call.input.description).toContain(DESCRIPTION);
    expect(
      call.input.environments.map((environment) => [environment.environmentId, environment.label]),
    ).toEqual(
      expect.arrayContaining([
        [LAPTOP_ENVIRONMENT_ID, "Laptop"],
        [VIGILIA_ENVIRONMENT_ID, "Vigilia"],
      ]),
    );
    expect(call.input.modelEnvironmentId).toBe(LAPTOP_ENVIRONMENT_ID);

    const picker = threadSearchPicker()!;
    expect(picker.textContent).toContain(DESCRIPTION);
    const progress = picker.querySelector('[role="status"]');
    expect(progress, `Expected a progress status; rendered: ${picker.textContent}`).not.toBeNull();
    expect(progress!.textContent).toMatch(/search/i);

    await resolveAgentSearch(call, {
      status: "matches",
      matches: [HOSTS_DOCK_MATCH, ARROW_LAG_MATCH],
      coverage: FULL_COVERAGE,
    });

    const rows = optionRows();
    expect(rows).toHaveLength(2);
    for (const [row, match] of [
      [rows[0]!, HOSTS_DOCK_MATCH],
      [rows[1]!, ARROW_LAG_MATCH],
    ] as const) {
      expect(row.textContent).toContain(match.threadTitle);
      expect(row.textContent).toContain(match.reason);
      expect(row.textContent).toContain(match.projectTitle);
      expect(row.textContent).toContain(match.environmentLabel);
    }
    expect(
      [...threadSearchPicker()!.querySelectorAll('[role="status"]')].some((status) =>
        /searching/i.test(status.textContent ?? ""),
      ),
    ).toBe(false);
  });

  it("agent search: clicking a ranked result opens that thread in its own environment", async () => {
    await searchAndShow([HOSTS_DOCK_MATCH, ARROW_LAG_MATCH]);

    await click(optionRows()[1]!);

    expect(currentPath(app)).toBe(threadPath(ARROW_LAG_MATCH));
    expect(paletteElement()).toBeNull();
  });

  it("agent search: a refinement reruns the search and replaces a search still running", async () => {
    await searchAndShow([HOSTS_DOCK_MATCH, ARROW_LAG_MATCH]);

    await submitDescription("it was on the laptop, in September");
    expect(threadSearchFixture.agentCalls).toHaveLength(2);
    expect(agentCall(1).input.description).toContain("it was on the laptop, in September");
    expect(threadSearchPicker()!.querySelector('[role="status"]')?.textContent ?? "").toMatch(
      /search/i,
    );

    await submitDescription("the one with the measured delay");
    expect(threadSearchFixture.agentCalls).toHaveLength(3);
    expect(agentCall(1).interrupted).toBe(true);
    expect(agentCall(2).input.description).toContain("the one with the measured delay");

    await resolveAgentSearch(agentCall(2), {
      status: "matches",
      matches: [ARROW_LAG_MATCH],
      coverage: FULL_COVERAGE,
    });
    const rows = optionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain(ARROW_LAG_MATCH.threadTitle);
  });
});

describe("agent search criterion 3: keyboard selection, Escape, failure, empty, and focus", () => {
  it("agent search: arrow keys move the highlight through ranked results and Enter opens the highlighted one", async () => {
    await searchAndShow([HOSTS_DOCK_MATCH, ARROW_LAG_MATCH]);
    expect(focusIsInPickerTextField()).toBe(true);

    await highlightRow(1);
    expect(isHighlighted(optionRows()[0]!)).toBe(false);
    await pressKey(pickerTextField(), "Enter");

    expect(currentPath(app)).toBe(threadPath(ARROW_LAG_MATCH));
    expect(paletteElement()).toBeNull();
    expect(threadSearchFixture.agentCalls).toHaveLength(1);
  });

  it("agent search: Escape in agent mode returns to exact words, and a second Escape returns to the command palette", async () => {
    await searchAndShow([HOSTS_DOCK_MATCH]);

    await pressKey(pickerTextField(), "Escape");
    expect(paletteMode()).toBe("threads");
    expect(activeSearchMode()).toBe("exact");
    expect(focusIsInPickerTextField()).toBe(true);

    await pressKey(pickerTextField(), "Escape");
    expect(paletteMode()).toBe("command");
  });

  it("agent search: a failed search stays visible with its description and keeps focus for a retry", async () => {
    await enterAgentMode();
    await submitDescription(DESCRIPTION);
    await resolveAgentSearch(agentCall(0), {
      status: "failed",
      failure: "model",
      coverage: FULL_COVERAGE,
    });

    const picker = threadSearchPicker()!;
    const alert = picker.querySelector('[role="alert"]');
    expect(alert, `Expected a failure alert; rendered: ${picker.textContent}`).not.toBeNull();
    expect(alert!.textContent).toMatch(/fail|could not|couldn't|error/i);
    expect(picker.textContent).toContain(DESCRIPTION);
    expect(optionRows()).toHaveLength(0);
    expect(focusIsInPickerTextField()).toBe(true);

    await submitDescription(DESCRIPTION);
    expect(threadSearchFixture.agentCalls).toHaveLength(2);
    await resolveAgentSearch(agentCall(1), {
      status: "failed",
      failure: "retrieval",
      coverage: FULL_COVERAGE,
    });
    expect(threadSearchPicker()!.querySelector('[role="alert"]')?.textContent ?? "").toMatch(
      /fail|could not|couldn't|error/i,
    );
    expect(focusIsInPickerTextField()).toBe(true);
  });

  it("agent search: no confident match says so and names the environments it could not reach", async () => {
    await enterAgentMode();
    await submitDescription(DESCRIPTION);
    await resolveAgentSearch(agentCall(0), {
      status: "noConfidentMatch",
      coverage: {
        ...FULL_COVERAGE,
        unavailableEnvironments: [{ environmentId: VIGILIA_ENVIRONMENT_ID, label: "Vigilia" }],
      },
    });

    const picker = threadSearchPicker()!;
    expect(optionRows()).toHaveLength(0);
    expect(picker.textContent).toMatch(/no confident match/i);
    const coverageNotice = [...picker.querySelectorAll<HTMLElement>("*")].find(
      (element) =>
        element.children.length === 0 &&
        /Vigilia/.test(element.textContent ?? "") &&
        /unavailable|not reached|could not reach|couldn't reach|disconnected|offline|not searched/i.test(
          element.parentElement?.textContent ?? "",
        ),
    );
    expect(
      coverageNotice,
      `Expected the unreachable environment named; rendered: ${picker.textContent}`,
    ).toBeDefined();
    expect(focusIsInPickerTextField()).toBe(true);
  });
});

describe("agent search criterion 4: archived results unarchive before opening", () => {
  it("agent search: an archived result asks before unarchiving and opens only after the unarchive succeeds", async () => {
    let finishUnarchive: (() => void) | undefined;
    threadSearchFixture.commandReplies.set(
      UNARCHIVE_COMMAND_LABEL,
      () =>
        new Promise((resolve) => {
          finishUnarchive = () => resolve(commandSuccess());
        }),
    );
    await searchAndShow([ARCHIVED_LAG_MATCH]);
    expect(optionRows()[0]!.textContent).toMatch(/archived/i);

    await click(optionRows()[0]!);
    const dialog = alertDialog();
    expect(dialog, "Expected an unarchive confirmation").not.toBeNull();
    expect(dialog!.textContent).toContain(ARCHIVED_LAG_MATCH.threadTitle);
    expect(dialog!.textContent).toMatch(/unarchive/i);
    expect(unarchiveCalls()).toHaveLength(0);
    expect(currentPath(app)).toBe("/");

    await click(buttonIn(dialog!, /unarchive/i));
    expect(unarchiveCalls()).toEqual([
      {
        label: UNARCHIVE_COMMAND_LABEL,
        value: {
          environmentId: ARCHIVED_LAG_MATCH.environmentId,
          input: { threadId: ARCHIVED_LAG_MATCH.threadId },
        },
      },
    ]);
    expect(currentPath(app)).toBe("/");

    expect(finishUnarchive).toBeDefined();
    finishUnarchive!();
    await settle();
    // The command succeeded, but the thread's active shell has not reached the
    // client yet; the real thread route would read it as missing and redirect.
    expect(currentPath(app)).toBe("/");
    expect(alertDialog()).not.toBeNull();

    await act(async () => deliverThreadShell(unarchivedShell(ARCHIVED_LAG_MATCH)));
    await settle();
    expect(currentPath(app)).toBe(threadPath(ARCHIVED_LAG_MATCH));
    expect(alertDialog()).toBeNull();

    await openThreadSearch();
    expect(optionRows()[0]?.textContent).not.toMatch(/archived/i);
    await click(optionRows()[0]!);
    expect(alertDialog()).toBeNull();
    expect(unarchiveCalls()).toHaveLength(1);
  });

  it("agent search: an unarchived thread whose environment drops before its shell arrives shows a recoverable wait and opens after reconnecting", async () => {
    await searchAndShow([ARCHIVED_LAG_MATCH]);
    await click(optionRows()[0]!);
    await click(buttonIn(alertDialog()!, /unarchive/i));
    expect(unarchiveCalls()).toHaveLength(1);

    await act(async () =>
      setEnvironmentConnectionPhase(ARCHIVED_LAG_MATCH.environmentId, "disconnected"),
    );
    await settle();
    const dialog = alertDialog();
    expect(dialog, "Expected the confirmation to stay open while disconnected").not.toBeNull();
    expect(dialog!.querySelector('[role="alert"]')?.textContent ?? "").toMatch(/disconnected/i);
    expect(dialog!.textContent).toContain(ARCHIVED_LAG_MATCH.environmentLabel);
    expect(currentPath(app)).toBe("/");

    await act(async () => {
      setEnvironmentConnectionPhase(ARCHIVED_LAG_MATCH.environmentId, "connected");
      deliverThreadShell(unarchivedShell(ARCHIVED_LAG_MATCH));
    });
    await settle();
    expect(currentPath(app)).toBe(threadPath(ARCHIVED_LAG_MATCH));
    expect(unarchiveCalls()).toHaveLength(1);
  });

  it("agent search: a failed unarchive keeps the confirmation open with the error and does not navigate", async () => {
    threadSearchFixture.commandReplies.set(UNARCHIVE_COMMAND_LABEL, async () =>
      commandFailure("Thread is locked by another client"),
    );
    await searchAndShow([ARCHIVED_LAG_MATCH]);

    await highlightRow(0);
    await pressKey(pickerTextField(), "Enter");
    const dialog = alertDialog();
    expect(dialog, "Expected an unarchive confirmation from the keyboard path").not.toBeNull();

    await click(buttonIn(dialog!, /unarchive/i));
    expect(unarchiveCalls()).toHaveLength(1);
    expect(currentPath(app)).toBe("/");
    const stillOpen = alertDialog();
    expect(stillOpen, "Expected the confirmation to stay open after a failure").not.toBeNull();
    expect(stillOpen!.textContent).toMatch(
      /Thread is locked by another client|fail|could not|couldn't/i,
    );
  });

  it("agent search: cancelling the unarchive confirmation dispatches nothing and returns focus to the picker", async () => {
    await searchAndShow([ARCHIVED_LAG_MATCH]);

    await click(optionRows()[0]!);
    const dialog = alertDialog();
    expect(dialog, "Expected an unarchive confirmation").not.toBeNull();
    await click(buttonIn(dialog!, /cancel/i));

    expect(alertDialog()).toBeNull();
    expect(unarchiveCalls()).toHaveLength(0);
    expect(currentPath(app)).toBe("/");
    expect(paletteMode()).toBe("threads");
    expect(threadSearchPicker()!.contains(document.activeElement)).toBe(true);
  });

  it("does not restart while the unarchive confirmation is open", async () => {
    await searchAndShow([ARCHIVED_LAG_MATCH]);
    await click(optionRows()[0]!);
    const dialog = alertDialog()!;
    await pressKey(buttonIn(dialog, /cancel/i), "r", { altKey: true });
    expect(alertDialog()).not.toBeNull();
    expect(optionRows()[0]?.textContent).toContain(ARCHIVED_LAG_MATCH.threadTitle);
    expect(unarchiveCalls()).toHaveLength(0);
  });
});

describe("agent search: persistent popup session", () => {
  it("reopens an unsent description in agent mode", async () => {
    await enterAgentMode();
    await typeInto(pickerTextField(), "an unfinished description");
    await openThreadSearch();
    await openThreadSearch();
    expect(activeSearchMode()).toBe("agent");
    expect(pickerTextField().value).toBe("an unfinished description");
  });

  it("collapses a long activity log when ranked threads arrive", async () => {
    await enterAgentMode();
    await submitDescription(DESCRIPTION);
    await act(async () => {
      for (let index = 0; index < 20; index += 1) {
        agentCall(0).input.onProgress?.({
          kind: "inspect",
          text: `Checking candidate thread ${index}`,
        });
      }
    });
    await resolveAgentSearch(agentCall(0), {
      status: "matches",
      matches: [ARROW_LAG_MATCH],
      coverage: FULL_COVERAGE,
    });

    const activity = threadSearchPicker()?.querySelector("details");
    expect(activity?.open).toBe(false);
    expect(activity?.textContent).toContain("Checking candidate thread 19");
    expect(optionRows()[0]?.textContent).toContain(ARROW_LAG_MATCH.threadTitle);
  });

  it("shows observed search activity in the conversation", async () => {
    await enterAgentMode();
    await submitDescription(DESCRIPTION);
    await act(async () => {
      agentCall(0).input.onProgress?.({
        kind: "inspect",
        text: "Checking “File tree arrow-key lag” in Mesura Code",
      });
    });
    expect(threadSearchPicker()?.textContent).toContain(
      "Checking “File tree arrow-key lag” in Mesura Code",
    );
  });

  it("keeps searching while closed and resumes with results", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    await enterAgentMode();
    await submitDescription(DESCRIPTION);
    const call = agentCall(0);
    expect(call.interrupted).toBe(false);

    await openThreadSearch();
    await settle();

    expect(paletteElement()).toBeNull();
    expect(call.interrupted).toBe(false);
    await resolveAgentSearch(call, {
      status: "matches",
      matches: [ARROW_LAG_MATCH],
      coverage: FULL_COVERAGE,
    });
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "1 likely thread found" }),
    );
    const toast = addToast.mock.calls.at(-1)?.[0];
    if (!toast) throw new Error("Expected a completed search notification");
    const viewSearch = (toast.actionProps as { onClick: () => void }).onClick;
    await act(async () => viewSearch());
    expect(activeSearchMode()).toBe("agent");
    expect(optionRows()).toHaveLength(1);
    expect(optionRows()[0]?.textContent).toContain(ARROW_LAG_MATCH.threadTitle);
    await act(async () => viewSearch());
    expect(activeSearchMode()).toBe("agent");
    expect(threadSearchFixture.commandCalls).toEqual([]);
  });

  it("keeps searching through the command palette and Alt+R cancels the session", async () => {
    await enterAgentMode();
    await submitDescription(DESCRIPTION);
    const call = agentCall(0);

    await pressKey(pickerTextField(), "Escape");
    await pressKey(pickerTextField(), "Escape");
    await settle();

    expect(paletteMode()).toBe("command");
    expect(call.interrupted).toBe(false);
    await openThreadSearch();
    expect(activeSearchMode()).toBe("agent");
    await pressKey(pickerTextField(), "r", { altKey: true });
    expect(call.interrupted).toBe(true);
    expect(pickerTextField().getAttribute("placeholder")).toContain("Describe the thread");
    expect(focusIsInPickerTextField()).toBe(true);
    expect(threadSearchFixture.commandCalls).toEqual([]);
  });
});

describe("agent search regressions from phase 4 verification and review", () => {
  it("agent search: Escape with the unarchive confirmation open closes only the confirmation", async () => {
    await searchAndShow([ARCHIVED_LAG_MATCH]);
    await click(optionRows()[0]!);
    expect(alertDialog(), "Expected an unarchive confirmation").not.toBeNull();

    await pressKey(document.activeElement ?? document.body, "Escape");

    expect(alertDialog()).toBeNull();
    expect(paletteMode()).toBe("threads");
    expect(activeSearchMode()).toBe("agent");
    expect(optionRows()).toHaveLength(1);
    expect(unarchiveCalls()).toHaveLength(0);
    expect(threadSearchPicker()!.contains(document.activeElement)).toBe(true);
  });

  it("agent search: cancelling while an unarchived thread's shell is awaited stops it from opening later", async () => {
    await searchAndShow([ARCHIVED_LAG_MATCH]);
    await click(optionRows()[0]!);
    await click(buttonIn(alertDialog()!, /unarchive/i));
    expect(unarchiveCalls()).toHaveLength(1);
    expect(alertDialog()!.textContent).toMatch(/opening/i);

    await click(buttonIn(alertDialog()!, /cancel/i));
    expect(alertDialog()).toBeNull();

    await act(async () => deliverThreadShell(unarchivedShell(ARCHIVED_LAG_MATCH)));
    await settle();
    expect(currentPath(app)).toBe("/");
    expect(paletteMode()).toBe("threads");
  });

  it("agent search: ranked results keep both the work-limit and unread-evidence notices", async () => {
    await enterAgentMode();
    await submitDescription(DESCRIPTION);
    await resolveAgentSearch(agentCall(0), {
      status: "matches",
      matches: [ARROW_LAG_MATCH],
      coverage: { unavailableEnvironments: [], budgetExhausted: true, unreadEvidence: true },
    });

    expect(optionRows()).toHaveLength(1);
    const details = threadSearchPicker()!.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toMatch(/partial/i);
    await click(details!.querySelector<HTMLElement>("summary")!);
    expect(details?.open).toBe(true);
    expect(details?.textContent).toMatch(/stopped at its work limit/i);
    expect(details?.textContent).toMatch(/found but not reviewed/i);
  });
});
