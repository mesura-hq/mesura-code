/**
 * Entry point: AppRoot inside the desktop shell, mounted as
 * `AppRoot.presence.fence.browser.test.tsx` mounts it. The shell is the
 * preload script's `window.desktopBridge`, set here before any app module
 * loads, because `env.ts` reads it once at load.
 *
 * Phone push phase 4, from the plan: the desktop shell reports presence too,
 * because the developer at the laptop is the main case to silence the phone
 * for. The shell never subscribes to push (phase 2), and that must not turn
 * its presence report off. Its primary environment is its own local server,
 * so the report has to reach a connected remote host too.
 */
import { expect, it, vi } from "vite-plus/test";

vi.hoisted(() => {
  Object.defineProperty(window, "desktopBridge", {
    value: { getLocalEnvironmentBootstraps: () => [] },
    configurable: true,
    writable: true,
  });
});

const fenceMocks = vi.hoisted(() => () => import("./test/presenceFenceMocks"));
vi.mock("./state/pushNotifications", async (original) =>
  (await fenceMocks()).mockPushNotificationsState(original),
);
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/primaryEnvironment", async (original) =>
  (await fenceMocks()).mockPrimaryEnvironment(original),
);
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./browser/BrowserProfileReporter", () => ({ BrowserProfileReporter: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));

import { isElectron } from "./env";
import { act } from "../test/render";
import { advance, mountPresenceApp, onPage } from "./test/presenceFenceApp";
import {
  giveInput,
  hostHoldsPushesAt,
  presenceFence,
  type PresenceFenceEnvironment,
  reportedStates,
  setEnvironments,
} from "./test/presenceFenceMocks";

const LAPTOP = "laptop-local";
const VIGILIA_HOME = "vigilia-home";

/** The laptop's own server is the primary; vigilia-home, the host that pushes, is remote. */
function desktopWithRemoteHost(
  remote: Partial<PresenceFenceEnvironment> = {},
): ReadonlyArray<PresenceFenceEnvironment> {
  return [
    { environmentId: LAPTOP, takesPresence: true, granted: true },
    { environmentId: VIGILIA_HOME, takesPresence: true, granted: true, ...remote },
  ];
}

function statesFor(environmentId: string): Array<unknown> {
  return presenceFence.reports
    .filter((report) => report.environmentId === environmentId)
    .map((report) => (report.input as { active: boolean }).active);
}

it("presence report spec: the desktop shell reports active like the web app", async () => {
  expect(isElectron, "the app loaded inside the desktop shell").toBe(true);
  await using _app = await mountPresenceApp();

  await onPage(() => giveInput("pointer"));

  expect(reportedStates()).toEqual([true]);
});

// regression: phase 4 review P1-3 — the reporter told only the primary
// environment, the laptop's own server, so vigilia-home kept pushing to the
// phone while the developer worked in its desktop connection.
it("presence report regression: the desktop reports to a connected remote host as well as its local primary", async () => {
  await using _app = await mountPresenceApp({ environments: desktopWithRemoteHost() });

  await onPage(() => giveInput("pointer"));
  const start = presenceFence.reports[0]!.at;
  expect(statesFor(LAPTOP)).toEqual([true]);
  expect(statesFor(VIGILIA_HOME)).toEqual([true]);
  expect(hostHoldsPushesAt(start + 60_000, VIGILIA_HOME)).toBe(true);

  await advance(2 * 60_000);
  expect(statesFor(VIGILIA_HOME), "two minutes idle").toEqual([true, false]);
  expect(presenceFence.openReports, "one open report per host").toBe(2);
});

it("presence report regression: a host that does not take presence reports, or a connection without the push scope, is never told", async () => {
  {
    await using _app = await mountPresenceApp({
      environments: desktopWithRemoteHost({ takesPresence: false }),
    });
    await onPage(() => giveInput("pointer"));
    expect(statesFor(LAPTOP)).toEqual([true]);
    expect(statesFor(VIGILIA_HOME), "an older server").toEqual([]);
  }
  {
    await using _app = await mountPresenceApp({
      environments: desktopWithRemoteHost({ granted: false }),
    });
    await onPage(() => giveInput("pointer"));
    expect(statesFor(LAPTOP)).toEqual([true]);
    expect(statesFor(VIGILIA_HOME), "no settings:write").toEqual([]);
  }
});

// regression: phase 4 rework — a host is told the developer is active as soon
// as it connects, without waiting for the next input or renewal.
it("presence report regression: a host that connects or reconnects while the developer is active is told active at once", async () => {
  await using _app = await mountPresenceApp({
    environments: desktopWithRemoteHost().slice(0, 1),
  });
  await onPage(() => giveInput("pointer"));
  await advance(10_000);
  expect(statesFor(VIGILIA_HOME), "not connected yet").toEqual([]);

  await act(async () => setEnvironments(desktopWithRemoteHost()));
  expect(statesFor(VIGILIA_HOME), "on connecting").toEqual([true]);
  expect(statesFor(LAPTOP), "the primary is not told again").toEqual([true]);

  await act(async () => setEnvironments(desktopWithRemoteHost().slice(0, 1)));
  expect(presenceFence.openReports, "the disconnected host's report ended").toBe(1);
  await advance(10_000);
  await act(async () => setEnvironments(desktopWithRemoteHost()));
  expect(statesFor(VIGILIA_HOME), "on reconnecting").toEqual([true, true]);
  expect(presenceFence.openReports).toBe(2);
});

it("presence report regression: a host that connects after the developer went inactive is told nothing", async () => {
  await using _app = await mountPresenceApp({
    environments: desktopWithRemoteHost().slice(0, 1),
  });
  await onPage(() => giveInput("pointer"));
  await advance(2 * 60_000);
  expect(statesFor(LAPTOP)).toEqual([true, false]);

  await act(async () => setEnvironments(desktopWithRemoteHost()));
  expect(statesFor(VIGILIA_HOME), "a host reads no report as inactive").toEqual([]);
});
