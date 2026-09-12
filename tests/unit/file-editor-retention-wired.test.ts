// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The file panel keeps one editor for as long as it is mounted, so a file's
 * undo stack survives a switch to another file and back. Three pieces of
 * wiring make that work, and each one failed at least once while it was built.
 * All three are asserted at the call site because a behavioural test passes in
 * every one of these cases: the retention record is correct and the caller is
 * wrong.
 *
 * - The surface is keyed by path alone. It used to be keyed by path AND
 *   resolved theme, which remounted it on every theme change and destroyed the
 *   undo stack with it, while the typed text stayed on screen because the query
 *   cache still held it. The result looked retained and was not.
 * - The editor is built once per panel, not once per file. Building it in a
 *   memo keyed on the file path is the original defect: Pierre keeps its
 *   persisted-document cache inside the editor instance, so a new editor per
 *   file threw the cache away every time.
 * - The retained identity is withheld when the file changed underneath. Without
 *   that gate the panel hands back a document describing text the file no
 *   longer has, so an agent's rewrite stays invisible.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

const panelSource = () => read("apps/web/src/components/files/FilePreviewPanel.tsx");

it("keys the editable file surface by path alone, never by theme", () => {
  const panel = panelSource();
  const mount = panel.slice(panel.indexOf("<EditableFileSurface"));
  const mountProps = mount.slice(0, 400);

  assert.include(
    mountProps,
    "key={relativePath}",
    "the editable file surface is no longer keyed by path alone, so a remount can drop the file's undo stack",
  );
  assert.notInclude(
    mountProps,
    "resolvedTheme}`}",
    "the resolved theme is back in the surface key, which remounts the editor on every theme change and loses undo history",
  );
});

it("builds one editor per mounted panel, not one per file", () => {
  const panel = panelSource();

  assert.include(
    panel,
    "const [editor] = useState(",
    "the Pierre editor is no longer created once per panel, so its persisted-document cache cannot span a file switch",
  );
  assert.notInclude(
    panel,
    "const editor = useMemo(",
    "the Pierre editor is built in a memo again; if its dependencies include the file path the undo stack dies on every switch",
  );
});

it("withholds the retained identity when the file changed underneath", () => {
  const panel = panelSource();

  assert.include(
    panel,
    "retention.canReuse(relativePath, contents)",
    "the panel no longer gates the retained identity on canReuse, so a file rewritten on disk can render from a stale retained document",
  );
});

it("keeps the retained file shape compatible with the upstream cache-key helper", () => {
  const retention = read("apps/web/src/components/files/fileEditorRetention.ts");

  // `EditorFileIdentity` in fileContentRevision.ts is upstream's, and this fork
  // merges that file every week. Widening the retained key to `string | undefined`
  // forces a matching edit there under `exactOptionalPropertyTypes`, which is a
  // recurring conflict bought for nothing — callers omit the field instead.
  assert.notInclude(
    retention,
    "cacheKey?: string | undefined",
    "the retained cache key was widened again, which forces an edit to the upstream fileContentRevision.ts on every merge",
  );
});
