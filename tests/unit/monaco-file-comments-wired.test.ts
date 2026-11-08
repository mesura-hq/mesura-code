// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * Three Monaco facts that unit tests and screenshots missed: Monaco stops emitting `onMouseMove`
 * once a button is down, so a gutter drag follows the window pointer; it paints `.view-lines` above
 * view zones, so a zone raises itself to take clicks; and a moved anchor must update the composer
 * chip too, or the chip quotes the old line.
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
