import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
    updateEverythingButton: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
// The pill only renders in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("./useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: mocks.hasUpdates,
    summary: "Update Codex and Claude",
    lines: [],
    restarts: [],
    skipped: [],
  }),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../hooks/useSettings")>();
  return {
    ...original,
    useClientSettings: ((selector: (settings: { updateEverythingButton: boolean }) => unknown) =>
      selector({
        updateEverythingButton: mocks.updateEverythingButton,
      })) as typeof original.useClientSettings,
  };
});

function nightlyUpdate(releaseNotes: DesktopUpdateState["releaseNotes"]): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes,
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

const RELEASE_NOTES: DesktopUpdateState["releaseNotes"] = [
  { version: "0.0.50-nightly.2", items: ["Faster sidebar."], totalItems: 1 },
];

function setup(
  update: DesktopUpdateState | null,
  { hasUpdates = false, updateEverythingButton = false } = {},
) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
  mocks.updateEverythingButton = updateEverythingButton;
}

function publish(update: DesktopUpdateState | null) {
  return act(() => {
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Nightly update release notes"]');

describe("SidebarUpdatePill release notes", () => {
  it("closes when the release notes stop applying", async () => {
    setup(nightlyUpdate(RELEASE_NOTES));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    await publish(nightlyUpdate([]));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("opens when release notes arrive while the trigger has keyboard focus", async () => {
    setup(nightlyUpdate([]));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    expect(releaseNotes()).toBeNull();

    await publish(nightlyUpdate(RELEASE_NOTES));
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());
  });
});

describe("SidebarUpdatePill update everything", () => {
  it("does not offer provider updates while the button setting is off", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    await expect.element(screen.getByRole("button", { name: /Check for updates/ })).toBeVisible();
    expect(document.querySelector('[aria-label="Update Codex and Claude"]')).toBeNull();
  });

  it("offers them once the setting is on", async () => {
    setup(null, { hasUpdates: true, updateEverythingButton: true });
    await using screen = await render(<SidebarUpdatePill />);
    await expect
      .element(screen.getByRole("button", { name: "Update Codex and Claude" }))
      .toBeVisible();
  });
});
