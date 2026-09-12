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
 * Undo survives a switch to another file and back, because the undo stack
 * belongs to the Monaco text model and a cache keeps one model per file. Two
 * things have to hold for that, and both were got wrong first:
 *
 * - The cache disposes the models, so nothing else may.
 * - The cache has to outlive the surface, and the surface is unmounted more
 *   often than it looks. Reading a file the client has not seen takes a round
 *   trip, and the panel used to draw its spinner *instead of* the editor for
 *   that moment. Every switch to a new file therefore tore the editor down, so
 *   no amount of care inside the editor could have kept the undo stack.
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

  // Bounded by the block that applies the edit, rather than by a character
  // count: a comment added between the undo stop and the edit once pushed the
  // stop out of a fixed window and failed this for no reason.
  const blockStart = surface.lastIndexOf("applyingExternalEditRef.current = true;", edit);
  assert.notStrictEqual(blockStart, -1, "the external edit is no longer flagged as external");
  const blockEnd = surface.indexOf("} finally {", edit);
  assert.notStrictEqual(blockEnd, -1, "the external-edit flag is no longer cleared in a finally");

  assert.include(
    surface.slice(blockStart, edit),
    "model.pushStackElement();",
    "no undo stop before the external edit, so it merges into the user's open typing group and one undo reverts both",
  );
  assert.include(
    surface.slice(edit, blockEnd),
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

it("takes the open file's model from the cache instead of building one per switch", () => {
  const surface = surfaceSource();

  assert.include(
    surface,
    "models.acquire(",
    "the surface builds its own model again, so switching files drops the undo stack the cache exists to keep",
  );
  assert.include(
    surface,
    "models.saveViewState(",
    "the outgoing file's caret and scroll are not saved",
  );
  assert.include(
    surface,
    "models.release(",
    "the outgoing file is never released, so nothing is ever evictable",
  );
});

it("leaves every model for the cache to dispose", () => {
  const surface = surfaceSource();

  const create = surface.indexOf("monaco.editor.create(");
  const cleanupEnd = surface.indexOf("}, []);", create);
  const editorCleanup = surface.slice(create, cleanupEnd);

  // Disposing here as well pulls the model out from under the cache, which
  // still holds it and will hand it back on the next visit to that file.
  assert.notInclude(
    editorCleanup,
    "getModel()?.dispose()",
    "the editor disposes its model again; the cache owns every model and disposes them all on unmount",
  );
  // Disposal of the cache itself belongs to the panel, which owns it. That is
  // asserted separately, against the panel.
  assert.include(
    editorCleanup,
    "saveViewState",
    "the surface no longer puts the open file's caret and scroll away before the editor goes, so returning to that file lands at the top",
  );
});

it("keeps the editor mounted while the next file is read", () => {
  const panel = panelSource();

  // The spinner drawn in place of the editor is what unmounted it on every
  // switch. It may only replace the editor when there is no file to show.
  assert.include(
    panel,
    "file.data === null && editorFile === null",
    "the reading spinner can replace the editor again, which unmounts it on every file switch and takes the undo stack with it",
  );
  assert.include(
    panel,
    "relativePath && (file.data || editorFile)",
    "the editor is only rendered when the query has data, so it cannot outlast a read",
  );
});

it("owns the models above the surface that uses them", () => {
  const panel = panelSource();
  const surface = surfaceSource();

  assert.include(
    panel,
    "createMonacoFileModels()",
    "the panel no longer owns the model cache; owned by the surface, it dies every time the surface is unmounted",
  );
  assert.include(panel, "models.disposeAll()", "nothing disposes the cached models");
  assert.notInclude(
    surface,
    "createMonacoFileModels",
    "the surface builds its own cache again, which makes the cache exactly as short-lived as the component it exists to outlive",
  );
});
