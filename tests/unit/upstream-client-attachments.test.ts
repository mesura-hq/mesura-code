// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The client half of the upstream attachment work ADR-003 adopted partly for its breadth. Reads
 * source, because a merge resolution that dropped an implementation would leave the tree building
 * and every other suite green.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

// Both message and question attachments use the shared validation helper.
// Pin its implementation here; executable web tests cover the rejection.
it("tells a user when an attachment is too large instead of failing silently", () => {
  assert.include(
    read("apps/web/src/components/chat/composerAttachmentFiles.ts"),
    "fileAttachmentTooLargeMessage",
    "upstream's over-size attachment message is missing, so an oversized file fails without explanation",
  );
});

// Upstream moved this table from `apps/web/src/types.ts` into the shared package when it added
// mobile video playback, so this asserts the shared module.
it("recognises video attachments so they can be played rather than downloaded", () => {
  const video = read("packages/shared/src/video.ts");
  assert.include(
    video,
    "VIDEO_MIME_TYPE_BY_EXTENSION",
    "upstream's video media-type table is missing, so a video attachment is not recognised as one",
  );
});
