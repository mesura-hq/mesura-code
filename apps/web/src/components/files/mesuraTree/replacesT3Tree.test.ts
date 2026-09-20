// @effect-diagnostics nodeBuiltinImport:off - reads the source tree to pin a deletion.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The T3 file tree is gone, and nothing brings it back by accident.
 *
 * The files surface renders the Symmetria tree. Upstream keeps investing in its
 * own tree component; this pins the decision (intent: "Delete the T3 tree
 * entirely") so a sync that restores the file is a visible choice, not drift.
 */

const thisFile = NodeURL.fileURLToPath(import.meta.url);
const filesDirectory = NodePath.resolve(NodePath.dirname(thisFile), "..");
const webSource = NodePath.resolve(filesDirectory, "../..");

function sourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the T3 tree is deleted", () => {
  // `fileTreeExpansion.ts` is off this list from v0.0.42: upstream's new diff
  // file tree reads it, and that tree is the diff viewer's, not the files
  // surface this fork replaced.
  it.each(["FileBrowserPanel.tsx", "fileTreeDragMention.ts", "fileTreeDragMention.test.ts"])(
    "%s no longer exists",
    (name) => {
      expect(NodeFS.existsSync(NodePath.join(filesDirectory, name))).toBe(false);
    },
  );

  // Scoped to the files surface rather than to all of apps/web. v0.0.42 built
  // its diff viewer a file tree on the same widget, and the diff viewer is
  // upstream's to build: this fork replaced the file EXPLORER, not every tree.
  it("nothing under the files surface imports the Pierre tree widget", () => {
    const files = sourceFiles(filesDirectory);
    // A mis-rooted scan would still be large; a known file proves the root.
    expect(files.some((file) => file.endsWith("/files/FilePreviewPanel.tsx"))).toBe(true);
    // This file names the widget in order to look for it.
    const offenders = files.filter(
      (file) =>
        file !== thisFile && NodeFS.readFileSync(file, "utf8").includes("@pierre/trees/react"),
    );
    expect(offenders).toEqual([]);
  });

  it("the diff viewer keeps its own tree, which is upstream's", () => {
    const diffTree = NodePath.resolve(webSource, "components/diffs/DiffFileTree.tsx");
    expect(NodeFS.existsSync(diffTree)).toBe(true);
    expect(NodeFS.readFileSync(diffTree, "utf8")).toContain("@pierre/trees/react");
  });
});
