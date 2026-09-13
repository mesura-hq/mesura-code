// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * File comments are drawn as Monaco view zones, and three of the things that
 * make them work are facts about Monaco rather than properties of this code.
 * Each one was written the obvious way first, shipped, and was found only by
 * driving a browser — every unit test passed and every screenshot looked right
 * in all three cases.
 *
 * - **Monaco stops emitting `onMouseMove` once a button is down.** It routes
 *   those moves into its own drag handling, and it offers no drag event of its
 *   own. A gutter selection built on `onMouseMove` therefore never grows: the
 *   range collapses to the line the drag started on, while the highlight still
 *   looks alive. The gesture has to follow the pointer through the window and
 *   ask the editor what is under it.
 * - **Monaco paints `.view-lines` above the view-zone layer.** A form inside a
 *   zone renders, lays out and reads correctly while every real mouse click
 *   lands on the syntax token behind it. The zone has to raise itself.
 * - **A submitted comment's line range lives in the composer too.** Moving the
 *   anchor updates the zone; unless the composer is told, its chip keeps
 *   quoting the line the comment was made on.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

const commentsSource = () => read("apps/web/src/components/files/monaco/monacoFileComments.tsx");

it("tracks a gutter drag through the window, not through Monaco's mouse move", () => {
  const source = commentsSource();

  assert.notInclude(
    source,
    "editor.onMouseMove(",
    "the gutter drag is back on Monaco's mouse move, which stops firing while a button is held, so a multi-line selection collapses to its first line",
  );
  assert.include(
    source,
    "getTargetAtClientPoint(",
    "the drag no longer hit-tests the pointer against the editor, so it cannot know which line it is over",
  );
  assert.match(
    source,
    /addEventListener\("pointermove", extend\)/,
    "the drag no longer follows the pointer on the window",
  );
});

it("raises the comment zone above the text Monaco paints over it", () => {
  const css = read("apps/web/src/components/files/monaco/monacoFileSurface.css");
  const zoneRule = css.slice(css.indexOf(".mesura-file-comment-zone {"));

  assert.include(
    zoneRule.slice(0, 700),
    "z-index: 1",
    "the comment zone no longer raises itself, so Monaco's text layer covers its buttons and a real click lands on the editor",
  );
  assert.include(zoneRule.slice(0, 700), "pointer-events: auto");
});

it("never writes to the composer store from inside a state updater", () => {
  const source = commentsSource();

  // React runs updaters during render, so a store write there updates another
  // component mid-render. It warns rather than failing, which is easy to ignore.
  for (const match of source.matchAll(/setEntries\(\(current\) =>/g)) {
    const updater = source.slice(match.index, match.index + 700);
    assert.notInclude(
      updater,
      "addReviewComment(",
      "a composer write moved back inside a setEntries updater, which runs during render",
    );
    assert.notInclude(updater, "removeReviewComment(", "same, for the removal path");
  }
});

it("tells the composer when a submitted comment's lines move", () => {
  const source = commentsSource();

  // Bounded by the effect itself. A looser slice reaches the submit path's own
  // call and passes whatever this effect does — which is how the first version
  // of this guard failed to notice the re-send being deleted.
  const start = source.indexOf("onDidChangeContent(");
  assert.notStrictEqual(start, -1, "the surface no longer follows content changes");
  const end = source.indexOf("subscription.dispose()", start);
  assert.notStrictEqual(end, -1, "the content-change effect no longer disposes its listener");

  assert.include(
    source.slice(start, end),
    "addReviewComment(",
    "an anchor that moves no longer re-sends the comment, so the composer chip keeps quoting the line it was made on",
  );
});
