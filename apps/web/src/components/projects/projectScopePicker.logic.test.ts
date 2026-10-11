import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { findJumpTargetItem } from "../CommandPalette.logic";

import { buildProjectScopeItems, type ProjectScopeGroup } from "./projectScopePicker.logic";

function group(overrides: {
  projectKey: string;
  displayName: string;
  workspaceRoot?: string;
  memberTitles?: ReadonlyArray<{ title: string; workspaceRoot: string }>;
}): ProjectScopeGroup {
  const workspaceRoot = overrides.workspaceRoot ?? `/home/dev/repos/${overrides.displayName}`;
  return {
    projectKey: overrides.projectKey,
    displayName: overrides.displayName,
    workspaceRoot,
    memberProjects: overrides.memberTitles ?? [{ title: overrides.displayName, workspaceRoot }],
  };
}

const scoped: Array<string | null> = [];
const build = (groups: ReadonlyArray<ProjectScopeGroup>) =>
  buildProjectScopeItems({
    groups,
    renderIcon: () => null,
    onScope: (projectScopeKey) => scoped.push(projectScopeKey),
  });

describe("buildProjectScopeItems", () => {
  it("lists the projects in the order given, with All projects last", () => {
    const items = build([
      group({ projectKey: "k-a", displayName: "client-agent" }),
      group({ projectKey: "k-b", displayName: "mesura-code" }),
    ]);

    expect(items.map((item) => item.value)).toEqual([
      "project-scope:k-a",
      "project-scope:k-b",
      "project-scope:all",
    ]);
  });

  it("numbers the first nine rows so row N is reachable with mod+N", () => {
    const items = build(
      Array.from({ length: 12 }, (_unused, index) =>
        group({ projectKey: `k-${index}`, displayName: `project-${index}` }),
      ),
    );

    expect(items.slice(0, 9).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
    ]);
  });

  it("leaves rows past the ninth without a shortcut rather than inventing one", () => {
    const items = build(
      Array.from({ length: 12 }, (_unused, index) =>
        group({ projectKey: `k-${index}`, displayName: `project-${index}` }),
      ),
    );

    expect(items.slice(9).every((item) => item.shortcutCommand === undefined)).toBe(true);
  });

  it("keeps a row's badge and its chord paired once the list is filtered", () => {
    // Rows are numbered before the search narrows them, so a filtered list can
    // show non-contiguous numbers: that is accepted, and it matches how the
    // command palette itself numbers. What must never break is the pairing —
    // the chord a row advertises has to be the chord that selects THAT row.
    // Renumbering after filtering would look tidier and would break nothing
    // here, but it would diverge from the palette; if you change one, change both.
    const items = build(
      Array.from({ length: 12 }, (_unused, index) =>
        group({ projectKey: `k-${index}`, displayName: `project-${index}` }),
      ),
    );
    const visible = items.filter(
      (item) => item.value === "project-scope:k-4" || item.value === "project-scope:k-7",
    );

    expect(visible.map((item) => item.shortcutCommand)).toEqual(["thread.jump.5", "thread.jump.8"]);
    expect(
      findJumpTargetItem({
        event: { key: "5", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        items: visible,
        platform: "Linux",
      })?.value,
    ).toBe("project-scope:k-4");
  });

  it("scopes to a project's logical key when its row runs", async () => {
    scoped.length = 0;
    const items = build([group({ projectKey: "k-a", displayName: "client-agent" })]);

    await items[0]!.run();

    expect(scoped).toEqual(["k-a"]);
  });

  it("clears the filter when the All projects row runs", async () => {
    scoped.length = 0;
    const items = build([group({ projectKey: "k-a", displayName: "client-agent" })]);

    await items[items.length - 1]!.run();

    expect(scoped).toEqual([null]);
  });

  it("searches every member project's title and path, not just the group's name", () => {
    const items = build([
      group({
        projectKey: "k-a",
        displayName: "mesura-code",
        memberTitles: [
          { title: "mesura-code", workspaceRoot: "/home/dev/repos/mesura-code" },
          { title: "mesura-code", workspaceRoot: "/mnt/wsl/mesura-code" },
        ],
      }),
    ]);

    expect(items[0]!.searchTerms).toContain("/mnt/wsl/mesura-code");
  });
});
