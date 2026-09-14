import { describe, expect, it } from "vitest";

import { bindingsFor, CORE, HELP_GROUPS, MILLER_ONLY, TREE_ONLY } from "../src/keys/registry.ts";
import type { Binding, ViewKind } from "../src/keys/types.ts";

/**
 * What the table must be true of, independent of what any key does.
 *
 * These are the tests that make the registry safe to add rows to. Each one
 * fails for a specific way a new row could quietly break the cheat sheet or
 * steal a key from an existing binding.
 */

const ALL: readonly Binding[] = [...CORE, ...MILLER_ONLY, ...TREE_ONLY];
const VIEWS: readonly ViewKind[] = ["miller", "tree"];

/** Every key that is a punctuation glyph rather than a letter or a named key. */
function isSymbolGlyph(key: string): boolean {
  return key.length === 1 && !/[a-z0-9 ]/.test(key);
}

describe("registry metadata", () => {
  it("gives every binding a unique id", () => {
    const ids = ALL.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every binding the metadata the help sheet renders", () => {
    // Without this, a row added with no label appears in the cheat sheet as a
    // blank line — which is worse than being absent, because it looks like a
    // rendering fault rather than a missing field.
    for (const binding of ALL) {
      expect(binding.keycap, binding.id).not.toBe("");
      expect(binding.label, binding.id).not.toBe("");
      expect(binding.icon, binding.id).not.toBe("");
      expect(binding.keys.length, binding.id).toBeGreaterThan(0);
    }
  });

  it("puts every binding in a group the help sheet knows how to render", () => {
    // A row with an unknown group renders nowhere and vanishes silently, which
    // recreates the drift the registry exists to prevent.
    for (const binding of ALL) {
      expect(HELP_GROUPS, binding.id).toContain(binding.group);
    }
  });

  it("declares every key lowercased, because matching lowercases the event", () => {
    for (const binding of ALL) {
      for (const key of binding.keys) {
        expect(key, `${binding.id}: ${key}`).toBe(key.toLowerCase());
      }
    }
  });
});

describe("registry collisions", () => {
  it.each(VIEWS)("has no two unconditional rows on the same key and mods in %s", (view) => {
    // Only UNCONDITIONAL rows collide. Two rows can share a key when at most one
    // of them can be true at a time — Ctrl+R is `op.pickerSaveEdit` inside a save
    // picker and `miller.renderToggle` over an HTML file, and neither is
    // unconditional.
    const seen = new Map<string, string>();

    for (const binding of bindingsFor(view)) {
      if (binding.when !== undefined) continue;

      for (const key of binding.keys) {
        const slot = `${key}|${binding.mods}`;
        const previous = seen.get(slot);
        expect(previous, `${binding.id} collides with ${previous} on ${slot}`).toBeUndefined();
        seen.set(slot, binding.id);
      }
    }
  });

  it.each(VIEWS)("never lets a wildcard row shadow a real chord in %s", (view) => {
    // A `mods: "*"` row matches whatever modifiers arrive, so it would also
    // swallow a deliberate Ctrl or Shift chord on the same key. Nothing may
    // declare both.
    const bindings = bindingsFor(view);
    const wildcardKeys = new Set(bindings.filter((b) => b.mods === "*").flatMap((b) => b.keys));

    for (const binding of bindings) {
      if (binding.mods === "*") continue;
      for (const key of binding.keys) {
        expect(wildcardKeys.has(key), `${binding.id} is shadowed on ${key}`).toBe(false);
      }
    }
  });
});

describe("symbol glyphs and the Latin-American layout", () => {
  it("never declares empty modifiers on a symbol glyph", () => {
    // The regression this pins. On the Latin-American layout `/` is Shift+7 and
    // `=` is Shift+0, so those events carry Shift. A row declaring `mods: ""`
    // rejects them and the key silently does nothing — which is exactly how
    // slash-search broke in the Qt build after its registry migration.
    for (const binding of ALL) {
      const symbols = binding.keys.filter(isSymbolGlyph);
      if (symbols.length === 0) continue;

      expect(binding.mods, `${binding.id} binds ${symbols.join(",")}`).toBe("*");
    }
  });

  it("keeps precise modifiers on letters, where the modifier is the intent", () => {
    // The converse guard. `mods: "*"` on a letter would make `j` and `Ctrl+J`
    // the same command and swallow modifier combinations meant for elsewhere.
    for (const binding of ALL) {
      if (binding.mods !== "*") continue;
      for (const key of binding.keys) {
        expect(isSymbolGlyph(key), `${binding.id} wildcards the letter ${key}`).toBe(true);
      }
    }
  });
});

describe("view scoping", () => {
  it("preserves Miller bindings and limits tree to its supported operations", () => {
    expect(bindingsFor("miller")).toEqual([...CORE, ...MILLER_ONLY]);
    const tree = bindingsFor("tree");
    expect(tree.map((binding) => binding.id)).toEqual(
      expect.arrayContaining([
        "nav.down",
        "nav.up",
        "nav.activate",
        "view.toggle",
        "tree.collapseOrParent",
        "tree.expandOrActivate",
      ]),
    );
    expect(tree.every((binding) => [...CORE, ...TREE_ONLY, ...MILLER_ONLY].includes(binding))).toBe(
      true,
    );
    expect(
      tree.some((binding) =>
        ["File", "Clipboard", "Selection", "History", "Tools"].includes(binding.group),
      ),
    ).toBe(false);
    expect(tree.some((binding) => binding.id === "tree.toggleGitignore")).toBe(false);
  });

  it("ports the whole Qt table", () => {
    // The Qt registry held 54 rows: 28 shared, 20 Miller-only, 6 tree-only. A
    // count that drifts means a row was dropped in the port rather than
    // deliberately removed.
    expect(CORE).toHaveLength(28);
    // The connected overview adds one binding to the ported table.
    expect(MILLER_ONLY).toHaveLength(21);
    // Tree adds a mode close binding on Escape.
    expect(TREE_ONLY).toHaveLength(10);
  });
});

describe("the rendered-document toggle", () => {
  const row = () => CORE.concat(MILLER_ONLY).find((b) => b.id === "miller.renderToggle");

  it("exists under a name that does not claim one format", () => {
    // It was `miller.renderToggle` while HTML was the only rendered view. The id
    // and the label both reach a reader — the label verbatim, in the help
    // sheet — so a name naming one of the two formats is now wrong twice.
    expect(row()).toBeDefined();
    expect(CORE.concat(MILLER_ONLY).find((b) => b.id === "miller.htmlRender")).toBeUndefined();
  });

  it("says what it does without naming HTML", () => {
    const label = row()?.label ?? "";

    expect(label).not.toMatch(/html/i);
    expect(label.length).toBeGreaterThan(0);
  });

  it("keeps Ctrl+R and stays in the View group", () => {
    expect(row()?.keys).toContain("r");
    expect(row()?.mods).toBe("Ctrl");
    expect(row()?.group).toBe("View");
  });
});
