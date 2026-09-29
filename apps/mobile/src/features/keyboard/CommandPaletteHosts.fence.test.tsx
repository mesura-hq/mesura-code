// @vitest-environment happy-dom
/**
 * Entry point: CommandPalette, the modal HardwareKeyboardCommandProvider
 * mounts while the palette is open. Its item list, its search filter, its
 * close-then-run sequence and every item's navigation are real; the catalog
 * hooks and native chrome are test boundaries.
 *
 * Phase 6 fence, criterion 2 (the palette half), and the guards for the
 * palette's existing actions.
 */
import type { PropsWithChildren, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  navigation: { navigate: vi.fn(), goBack: vi.fn(), setOptions: vi.fn() },
  onClose: vi.fn(),
}));

vi.mock(
  "react-native",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).reactNativeDom,
);
vi.mock(
  "../../components/AppSymbol",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).appSymbolDom,
);
vi.mock(
  "../../components/AppText",
  async () => (await import("../hosts/reactNativeDomTestDoubles")).appTextDom,
);
vi.mock("../../components/RowPressable", async () => ({
  RowPressable: (await import("../hosts/reactNativeDomTestDoubles")).reactNativeDom.Pressable,
}));
vi.mock("../../components/GlassSurface", () => ({
  GlassSurface: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: (props: PropsWithChildren) => <div>{props.children}</div>,
}));
vi.mock("../../native/T3KeyboardCommands", () => ({
  T3KeyboardCommands: (props: PropsWithChildren) => <div>{props.children}</div>,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => fixture.navigation }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => [],
  useThreadShell: () => null,
}));
vi.mock("../../state/queries", () => ({
  useThreadSearch: () => ({ matches: [], isPending: false }),
}));
vi.mock("../../state/workspace", () => ({ useWorkspaceState: () => ({ environments: [] }) }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ selectThread: vi.fn() }),
}));
vi.mock("../threads/thread-search-match", () => ({ ThreadSearchMatchExcerpt: () => null }));

import { CommandPalette } from "./CommandPalette";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function openPalette() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<CommandPalette pathname="/" onClose={fixture.onClose} onCommand={vi.fn()} />),
  );
}

/** A row reads its title, then the ⌘1–⌘9 jump shortcut on the first nine rows. */
function paletteRow(title: string): HTMLButtonElement {
  const row = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (candidate) => {
      const text = candidate.textContent?.trim() ?? "";
      return text.startsWith(title) && /^(⌘\d)?$/.test(text.slice(title.length));
    },
  );
  if (!row) throw new Error(`no palette row titled "${title}"`);
  return row;
}

async function search(query: string) {
  const input = container!.querySelector<HTMLInputElement>(
    'input[aria-label="Search commands, projects, and threads"]',
  )!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  fixture.navigation.navigate.mockClear();
  fixture.onClose.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("criterion 2: the command palette has a Hosts entry", () => {
  it("command palette Hosts entry opens the Hosts screen", async () => {
    await openPalette();
    await search("hosts");

    await act(async () => paletteRow("Hosts").click());

    expect(fixture.onClose).toHaveBeenCalledTimes(1);
    expect(fixture.navigation.navigate).toHaveBeenCalledWith("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsHosts" },
    });
  });
});

describe("guard: the command palette keeps its actions", () => {
  it("command palette guard: every existing action is still listed", async () => {
    await openPalette();

    for (const title of [
      "New thread in…",
      "Add project",
      "Open settings",
      "Appearance",
      "Manage environments",
      "Usage",
      "Archived threads",
    ]) {
      expect(paletteRow(title)).toBeTruthy();
    }
  });

  it("command palette guard: Usage still opens the Usage screen", async () => {
    await openPalette();

    await act(async () => paletteRow("Usage").click());

    expect(fixture.navigation.navigate).toHaveBeenCalledWith("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsUsage" },
    });
  });
});
