import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { resolveShortcutCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { useThreadJumpTargets, type ThreadJumpTargets } from "./threadJumpTargets";

// The shipped jump bindings are desktop-only; this is the desktop app.
vi.mock("../../env", () => ({ isElectron: true }));

/**
 * A sidebar list as the browser lays it out: a 300px viewport with 20px rows,
 * each row showing the label the hook gives it, and a focusable stand-in for
 * the preview panel. `onRender` hands the test what the sidebar's key handler
 * reads.
 */
function JumpList(props: {
  readonly rowKeys: readonly string[];
  readonly active: boolean;
  readonly onRender: (targets: ThreadJumpTargets) => void;
}) {
  const targets = useThreadJumpTargets({
    active: props.active,
    orderedThreadKeys: props.rowKeys,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    terminalOpen: false,
  });
  props.onRender(targets);
  return (
    <>
      <div data-slot="scroll-area-viewport" style={{ height: 300, overflowY: "auto" }}>
        {props.rowKeys.map((key) => (
          <div key={key} data-mesura-thread-key={key} style={{ height: 20 }}>
            <span>{key}</span>
            <kbd>{targets.labelByThreadKey.get(key) ?? ""}</kbd>
          </div>
        ))}
      </div>
      <button type="button" data-preview-panel-mode="docked">
        preview
      </button>
    </>
  );
}

const rows = (count: number, prefix = "thread") =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

async function mountJumpList(rowKeys: readonly string[], active = true) {
  const latest: { targets: ThreadJumpTargets | null } = { targets: null };
  const element = (keys: readonly string[], isActive: boolean) => (
    <JumpList
      rowKeys={keys}
      active={isActive}
      onRender={(targets) => {
        latest.targets = targets;
      }}
    />
  );
  // A plain list with no links: nothing here needs a router.
  const screen = await render(element(rowKeys, active), { router: false });
  return {
    screen,
    rerender: (keys: readonly string[], isActive = active) =>
      screen.rerender(element(keys, isActive)),
    /** Each row's key and the label it shows, top to bottom. */
    labels: () =>
      [...screen.container.querySelectorAll<HTMLElement>("[data-mesura-thread-key]")].map(
        (row) =>
          [row.dataset.mesuraThreadKey, row.querySelector("kbd")?.textContent ?? ""] as const,
      ),
    /** The thread a Ctrl+<digit> press opens, through the same lookup the sidebar uses. */
    opens: (digit: string) => {
      const command = resolveShortcutCommand(
        {
          key: digit,
          code: `Digit${digit}`,
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        },
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux", context: { isDesktop: true, previewFocus: isPreviewFocused() } },
      );
      return command === null ? null : (latest.targets?.threadKeyForJump(command) ?? null);
    },
  };
}

/** Every row that shows a label opens on the key its label names. */
function expectEachLabelOpensItsRow(list: Awaited<ReturnType<typeof mountJumpList>>) {
  for (const [rowKey, label] of list.labels()) {
    if (label === "") continue;
    expect(list.opens(label.at(-1)!), `${label} opens the row that shows it`).toBe(rowKey);
  }
}

describe("thread jump targets", () => {
  it("numbers ten rows on screen Ctrl+1 to Ctrl+0, and each key opens the row that shows it", async () => {
    const list = await mountJumpList(rows(12));
    await using _screen = list.screen;

    expect(list.labels()).toEqual([
      ["thread-1", "Ctrl+1"],
      ["thread-2", "Ctrl+2"],
      ["thread-3", "Ctrl+3"],
      ["thread-4", "Ctrl+4"],
      ["thread-5", "Ctrl+5"],
      ["thread-6", "Ctrl+6"],
      ["thread-7", "Ctrl+7"],
      ["thread-8", "Ctrl+8"],
      ["thread-9", "Ctrl+9"],
      ["thread-10", "Ctrl+0"],
      ["thread-11", ""],
      ["thread-12", ""],
    ]);
    expectEachLabelOpensItsRow(list);
    expect(list.opens("0")).toBe("thread-10");
  });

  it("moves the labels and the jumps with the rows when they reorder while the hints show", async () => {
    const list = await mountJumpList(["a", "b", "c", "d"]);
    await using _screen = list.screen;
    expect(list.labels()).toEqual([
      ["a", "Ctrl+1"],
      ["b", "Ctrl+2"],
      ["c", "Ctrl+3"],
      ["d", "Ctrl+4"],
    ]);

    // An agent starts working on `c` and the sort moves it to the top.
    await list.rerender(["c", "a", "b", "d"]);
    expect(list.labels()).toEqual([
      ["c", "Ctrl+1"],
      ["a", "Ctrl+2"],
      ["b", "Ctrl+3"],
      ["d", "Ctrl+4"],
    ]);
    expectEachLabelOpensItsRow(list);
    expect(list.opens("1")).toBe("c");

    // A thread appears, another leaves.
    await list.rerender(["new", "c", "b", "d"]);
    expect(list.labels()).toEqual([
      ["new", "Ctrl+1"],
      ["c", "Ctrl+2"],
      ["b", "Ctrl+3"],
      ["d", "Ctrl+4"],
    ]);
    expectEachLabelOpensItsRow(list);
    expect(list.opens("4")).toBe("d");
    expect(list.opens("5")).toBeNull();
  });

  it("gives Ctrl+0 to the preview while it has focus: the tenth row shows no key and opens on none", async () => {
    const list = await mountJumpList(rows(10));
    await using _screen = list.screen;
    expect(list.labels().at(-1)).toEqual(["thread-10", "Ctrl+0"]);

    await act(() => list.screen.container.querySelector("button")!.focus());
    expect(list.labels().at(-1)).toEqual(["thread-10", ""]);
    expect(list.labels()[0]).toEqual(["thread-1", "Ctrl+1"]);
    expect(list.opens("0")).toBeNull();
    expect(list.opens("1")).toBe("thread-1");

    await act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(list.labels().at(-1)).toEqual(["thread-10", "Ctrl+0"]);
    expect(list.opens("0")).toBe("thread-10");
  });

  it("opens the row on screen at the key's position when the hints are not shown", async () => {
    const list = await mountJumpList(rows(3), false);
    await using _screen = list.screen;
    expect(list.labels().every(([, label]) => label === "")).toBe(true);

    await list.rerender(["thread-3", "thread-1", "thread-2"], false);
    expect(list.opens("1")).toBe("thread-3");
    expect(list.opens("3")).toBe("thread-2");
    expect(list.opens("4")).toBeNull();
  });
});
