// @vitest-environment happy-dom
// Application entry points: HomeRouteScreen (Android and iOS home search),
// AdaptiveWorkspaceLayout around HomeRouteScreen on a tablet-width window
// (ThreadNavigationSidebar search), and ArchivedThreadsRouteScreen, each under
// the app's atom registry with ConfirmDialogHost at the root. See
// agentThreadSearch.testMount.tsx for the harness and the mocked boundaries.
//
// Guards for phase 5 of agent thread search: the behavior the mobile agent
// mode must not break — exact-word search on both surfaces and both
// platforms, opening an active thread, and the archived-thread unarchive
// command.
import "./agentThreadSearch.testMocks";

import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  agentSearchFixture,
  archivedUploadShell,
  ARCHIVED_UPLOAD_TITLE,
  commandFailure,
  HOSTS_DOCK_TITLE,
  LAPTOP_ENVIRONMENT_ID,
  MESURA_PROJECT_ID,
  PANE_FOCUS_TITLE,
  resetAgentSearchFixture,
  UNARCHIVE_COMMAND_LABEL,
  VIGILIA_ENVIRONMENT_ID,
} from "./agentThreadSearch.testMocks";
import {
  control,
  mountArchivedThreads,
  mountHome,
  mountSidebar,
  openedThreads,
  press,
  settle,
  sidebarElement,
  textField,
  threadRow,
  threadRowTitles,
  typeInto,
  type MountedApp,
} from "./agentThreadSearch.testMount";

let app: MountedApp | undefined;

beforeEach(() => {
  resetAgentSearchFixture();
});

afterEach(async () => {
  await app?.unmount();
  app = undefined;
});

/** The native search bar's text callback, as the iOS header delivers typing. */
async function typeIntoNativeSearchBar(text: string): Promise<void> {
  const options = agentSearchFixture.screenOptions.findLast(
    (entry) => entry.headerSearchBarOptions !== undefined,
  );
  expect(options, "Expected a native header search bar").toBeDefined();
  const searchBar = options!.headerSearchBarOptions as {
    onChangeText: (event: { nativeEvent: { text: string } }) => void;
  };
  await act(async () => {
    searchBar.onChangeText({ nativeEvent: { text } });
  });
  await settle();
}

it("P5 GUARD mobile home exact-word search filters threads by title and restores them when cleared", async () => {
  app = await mountHome();
  expect(threadRowTitles()).toEqual([PANE_FOCUS_TITLE, HOSTS_DOCK_TITLE]);

  await typeInto(textField(/^search threads$/i), "hosts");
  expect(threadRowTitles()).toEqual([HOSTS_DOCK_TITLE]);

  await press(control(/clear search/i));
  expect(threadRowTitles()).toEqual([PANE_FOCUS_TITLE, HOSTS_DOCK_TITLE]);
  expect(agentSearchFixture.agentCalls).toHaveLength(0);
});

it("P5 GUARD mobile home exact-word search keeps message-content matches", async () => {
  agentSearchFixture.contentMatches = [
    {
      environmentId: LAPTOP_ENVIRONMENT_ID,
      threadId: ThreadId.make("mobile-thread-pane-focus"),
      projectId: MESURA_PROJECT_ID,
      source: "user",
      snippet: "the focus ring should follow the active pane",
      messageCreatedAt: "2026-09-29T11:00:00.000Z",
    },
  ];
  app = await mountHome();

  await typeInto(textField(/^search threads$/i), "focus ring");
  expect(threadRowTitles()).toEqual([PANE_FOCUS_TITLE]);
});

it("P5 GUARD mobile home opens an active thread row with environment-scoped params", async () => {
  app = await mountHome();

  await press(threadRow(HOSTS_DOCK_TITLE));
  expect(openedThreads()).toEqual([
    { environmentId: VIGILIA_ENVIRONMENT_ID, threadId: "mobile-thread-hosts-dock" },
  ]);
});

it("P5 GUARD mobile sidebar exact-word search filters threads by title", async () => {
  app = await mountSidebar();
  const sidebar = sidebarElement();
  expect(threadRowTitles(sidebar)).toEqual([PANE_FOCUS_TITLE, HOSTS_DOCK_TITLE]);

  await typeInto(textField(/^search threads$/i, sidebar), "pane");
  expect(threadRowTitles(sidebarElement())).toEqual([PANE_FOCUS_TITLE]);
  expect(agentSearchFixture.agentCalls).toHaveLength(0);
});

it("P5 GUARD mobile sidebar opens an active thread row with environment-scoped params", async () => {
  app = await mountSidebar();

  await press(threadRow(PANE_FOCUS_TITLE, sidebarElement()));
  expect(openedThreads()).toEqual([
    { environmentId: LAPTOP_ENVIRONMENT_ID, threadId: "mobile-thread-pane-focus" },
  ]);
});

it("P5 GUARD mobile archived route unarchives a thread through the scoped unarchive command", async () => {
  const archived = archivedUploadShell("2026-09-21T00:00:00.000Z");
  agentSearchFixture.archivedThreads = [archived];
  app = await mountArchivedThreads();

  await press(control(new RegExp(`^Unarchive ${ARCHIVED_UPLOAD_TITLE}$`)));
  expect(agentSearchFixture.commandCalls).toEqual([
    {
      label: UNARCHIVE_COMMAND_LABEL,
      value: { environmentId: VIGILIA_ENVIRONMENT_ID, input: { threadId: archived.id } },
    },
  ]);
  expect(agentSearchFixture.archivedRefreshes).toContain(VIGILIA_ENVIRONMENT_ID);
});

it("P5 GUARD mobile archived route reports a failed unarchive", async () => {
  agentSearchFixture.archivedThreads = [archivedUploadShell("2026-09-21T00:00:00.000Z")];
  agentSearchFixture.commandReplies.set(UNARCHIVE_COMMAND_LABEL, async () =>
    commandFailure("Environment went away"),
  );
  app = await mountArchivedThreads();

  await press(control(new RegExp(`^Unarchive ${ARCHIVED_UPLOAD_TITLE}$`)));
  expect(agentSearchFixture.alerts).toEqual([
    expect.objectContaining({
      title: "Could not unarchive thread",
      message: "Environment went away",
    }),
  ]);
  expect(agentSearchFixture.archivedRefreshes).toEqual([]);
});

it("P5 GUARD mobile iOS home search bar still filters threads by exact words", async () => {
  agentSearchFixture.platform = "ios";
  app = await mountHome();
  expect(threadRowTitles()).toEqual([PANE_FOCUS_TITLE, HOSTS_DOCK_TITLE]);

  await typeIntoNativeSearchBar("hosts");
  expect(threadRowTitles()).toEqual([HOSTS_DOCK_TITLE]);

  await press(threadRow(HOSTS_DOCK_TITLE));
  expect(openedThreads()).toEqual([
    { environmentId: VIGILIA_ENVIRONMENT_ID, threadId: "mobile-thread-hosts-dock" },
  ]);
});

it("P5 GUARD mobile iOS sidebar search bar still filters threads by exact words", async () => {
  agentSearchFixture.platform = "ios";
  app = await mountSidebar();
  expect(threadRowTitles(sidebarElement())).toEqual([PANE_FOCUS_TITLE, HOSTS_DOCK_TITLE]);

  await typeIntoNativeSearchBar("pane");
  expect(threadRowTitles(sidebarElement())).toEqual([PANE_FOCUS_TITLE]);
});
