// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The file panel edits through Monaco. One editor serves every file the panel
 * opens, and these assertions hold the wiring that keeps the open file's undo
 * stack, selection and scroll position alive underneath it.
 *
 * Note what is NOT claimed here: undo does not yet survive a switch to another
 * file and back. The undo stack belongs to the Monaco text model, and the
 * surface disposes the outgoing model on a path change, so the stack goes with
 * it. A model cache per path is the next piece of work and restores that.
 *
 * Every assertion below marks something that broke at least once while it was
 * built, and not one of those breakages is reachable from a test that runs the
 * code: the editor still rendered, the text on screen was still right, and the
 * loss only showed when somebody pressed Ctrl+Z or Escape. That is why these
 * read source instead of behaviour.
 *
 * - **The mount carries no React key.** It was once keyed on path AND resolved
 *   theme, which remounted the editor on every theme toggle and destroyed the
 *   undo stack with it, while the typed text stayed on screen because the query
 *   cache still held it. It looked retained and was not.
 * - **The editor is created once, not once per file.** Building it in a hook
 *   that depends on the file path is the original defect; the editor owns the
 *   undo stack, so a new editor per file threw the stack away every time.
 * - **An incoming change is gated on `canReuse`.** Without that gate a
 *   confirmed save comes back as an external change and gets re-applied,
 *   moving the caret for nothing.
 * - **Applying an external change does not echo it back as a save.** Monaco
 *   raises the same content-change event for a programmatic edit as for a typed
 *   one, so an unguarded listener answers an agent's write by saving it back.
 *   If a second write lands inside the save debounce, that echo overwrites it.
 *   The behaviour is proved in a browser; this only holds the guard in place.
 * - **The external change is its own undo element.** `pushEditOperations` does
 *   not open one, so Monaco merges an incoming rewrite into whatever typing
 *   group is still open. One Ctrl+Z then reverts the agent's write together
 *   with the user's last keystrokes, leaving a half-typed line on screen. This
 *   was observed, not theorised.
 * - **Dismissal blurs whatever is focused, by asking the document.** Monaco
 *   0.56 runs with `editContext` on and keeps the caret in a
 *   `native-edit-context` div, not the hidden textarea older versions used.
 *   Reaching for a textarea by tag name finds nothing and blurs nothing, so
 *   Escape silently stopped working.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

const panelSource = () => read("apps/web/src/components/files/FilePreviewPanel.tsx");
const surfaceSource = () => read("apps/web/src/components/files/monaco/MonacoFileSurface.tsx");

/** The text of the `<MonacoFileSurface ... />` element, attributes included. */
function monacoSurfaceElement(source: string): string {
  const start = source.indexOf("<MonacoFileSurface");
  assert.notStrictEqual(start, -1, "FilePreviewPanel no longer mounts MonacoFileSurface");
  const end = source.indexOf("/>", start);
  assert.notStrictEqual(end, -1, "the MonacoFileSurface element is not self-closing");
  return source.slice(start, end + 2);
}

it("mounts the Monaco surface with no React key", () => {
  const element = monacoSurfaceElement(panelSource());

  assert.notMatch(
    element,
    /\bkey=/,
    "MonacoFileSurface must not take a key: a remount destroys the undo stack it exists to keep",
  );
});

it("hands the surface the retention record it needs to tell our edits from the agent's", () => {
  const element = monacoSurfaceElement(panelSource());

  assert.match(element, /\bretention=\{retention\}/);
});

it("no longer builds an editable surface out of Pierre", () => {
  const source = panelSource();

  // Pierre still renders the read-only file view and every diff in the app, so
  // the package as a whole stays. Only its editor is gone.
  assert.notInclude(source, "@pierre/diffs/editor");
  assert.include(source, "@pierre/diffs/react");
});

it("creates the editor once, with no dependency that a file switch can move", () => {
  const surface = surfaceSource();

  const created = surface.indexOf("monaco.editor.create(");
  assert.notStrictEqual(created, -1, "the surface no longer creates a Monaco editor");

  // The dependency list of the hook the create call sits in.
  const deps = /\n {2}\}, \[(.*?)\]\);/s.exec(surface.slice(created));
  assert.isNotNull(deps, "the create call is not inside a hook with a dependency list");
  assert.strictEqual(
    deps?.[1]?.trim(),
    "",
    "the editor is created by a hook with dependencies; anything in that list that moves with the open file rebuilds the editor and drops the undo stack",
  );
});

it("ignores an incoming change that is our own confirmed save", () => {
  assert.include(
    surfaceSource(),
    "retention.canReuse(relativePath, contents)",
    "the surface no longer gates incoming contents on canReuse, so a confirmed save is re-applied as if the file had changed on disk",
  );
});

it("does not save an external change straight back to disk", () => {
  const surface = surfaceSource();

  const listener = surface.indexOf("onDidChangeContent(");
  assert.notStrictEqual(listener, -1, "the surface no longer listens for content changes");

  assert.include(
    surface.slice(listener, listener + 400),
    "if (applyingExternalEditRef.current) return;",
    "the content-change listener no longer ignores programmatic edits, so applying an agent's write schedules a save of it and can clobber the next one",
  );
});

it("applies an external change as its own undo element", () => {
  const surface = surfaceSource();

  const edit = surface.indexOf("model.pushEditOperations(");
  assert.notStrictEqual(edit, -1, "the surface no longer applies external changes as an edit");

  const before = surface.slice(0, edit);
  const after = surface.slice(edit);
  assert.include(
    before.slice(-300),
    "model.pushStackElement();",
    "no undo stop before the external edit, so it merges into the user's open typing group and one undo reverts both",
  );
  assert.include(
    after.slice(0, 300),
    "model.pushStackElement();",
    "no undo stop after the external edit, so the next keystrokes merge into it",
  );
});

it("blurs whatever the document says is focused, not a textarea by tag name", () => {
  const surface = surfaceSource();

  // Monaco 0.56 keeps the caret in a `native-edit-context` div, so a
  // `querySelector("textarea")` finds nothing and Escape does not blur.
  assert.notMatch(
    surface,
    /querySelector\(\s*["']textarea["']/,
    "dismissal is reaching for a textarea again; Monaco 0.56 has no textarea to blur, so Escape does nothing",
  );
  assert.include(surface, "document.activeElement");
});
