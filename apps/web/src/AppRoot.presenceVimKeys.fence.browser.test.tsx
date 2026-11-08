// Phone push phase 4: a Vim key the key engine consumes still counts as developer input. The
// installs follow `main.tsx`'s order (page input observer, then key engine). This is a file of its
// own because the key engine installs once per module.
import { expect, it, vi } from "vite-plus/test";

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

import { configureKeyEngine, installKeyEngine } from "./keys/keyEngine";
import { installPageInputObserver } from "./pushNotifications/pageInput";
import { mountPresenceApp, onPage } from "./test/presenceFenceApp";
import { reportedStates } from "./test/presenceFenceMocks";

// As in main.tsx.
installPageInputObserver();
installKeyEngine();

// regression: phase 4 review P1-2 — the presence listener sat on `document`,
// below the key engine's `window` listener, which consumes Vim keys with
// `stopImmediatePropagation`; a developer typing Vim commands read as inactive.
it("presence report regression: a Vim key the key engine consumes still reports active", async () => {
  configureKeyEngine({ enabled: true });
  await using _app = await mountPresenceApp();
  let reachedDocument = false;
  const noteReach = () => {
    reachedDocument = true;
  };
  document.addEventListener("keydown", noteReach);
  try {
    await onPage(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }),
      );
    });

    expect(reachedDocument, "the key engine consumed the key").toBe(false);
    expect(reportedStates()).toEqual([true]);
  } finally {
    document.removeEventListener("keydown", noteReach);
    configureKeyEngine({ enabled: false });
  }
});
