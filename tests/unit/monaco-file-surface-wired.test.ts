// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * One Monaco editor serves every file, and a cache that outlives the surface owns one model (and its
 * undo stack) per file. Each assertion marks a break no running test caught: a React key on the mount,
 * an editor per file, an ungated or echoed external change, an external change merged into the typing
 * undo group, and a textarea-based blur (Monaco 0.56 focuses a `native-edit-context` div).
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

it("does not own the editor models it uses, so a route change cannot take them", () => {
  const source = panelSource();

  // The undo stack lives in the Monaco model, and this panel unmounts for
  // three ordinary things: the spinner while a file is read, opening Settings,
  // and switching to a thread in another project. A panel that built the cache
  // would destroy the stack on exactly the actions it exists to survive.
  assert.include(source, "useProjectEditorModels(environmentId, cwd)");
  assert.notInclude(source, "createMonacoFileModels");
  assert.notInclude(source, "disposeAll");
  assert.notInclude(source, "new FileEditorRetention()");
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

it("keeps the models further from the surface than the surface can reach", () => {
  const panel = panelSource();
  const surface = surfaceSource();

  // The panel unmounts on route changes (Settings, a thread in another project), so whoever holds
  // the cache must outlive whoever draws the editor. Assert the call, not the identifier: a
  // surviving import beside a call that builds its own cache would pass a looser assertion.
  assert.include(
    panel,
    "useProjectEditorModels(environmentId, cwd)",
    "the panel builds its own cache again, which dies on every route change",
  );
  assert.notInclude(
    surface,
    "createMonacoFileModels",
    "the surface builds its own cache again, which makes the cache exactly as short-lived as the component it exists to outlive",
  );
});
