// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The client half of the attachment work this fork adopted in place of its own.
 * ADR-003 justified the switch partly on breadth — upstream's stack does things
 * the retired one never did — so those capabilities are worth asserting rather
 * than assuming a merge carried them.
 *
 * Reads the sources rather than driving a browser: what these pin is that the
 * merge kept upstream's implementations, and a resolution that dropped one
 * would leave the tree building and every other suite green.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

it("tells a user when an attachment is too large instead of failing silently", () => {
  assert.include(
    read("apps/web/src/components/chat/ChatComposer.tsx"),
    "fileAttachmentTooLargeMessage",
    "upstream's over-size attachment message is missing, so an oversized file fails without explanation",
  );
});

it("recognises video attachments so they can be played rather than downloaded", () => {
  const types = read("apps/web/src/types.ts");
  assert.include(
    types,
    "VIDEO_MIME_TYPE_BY_EXTENSION",
    "upstream's video media-type table is missing, so a video attachment is not recognised as one",
  );
});

it("accepts files shared into the mobile app from other apps", () => {
  assert.include(
    read("apps/mobile/src/features/sharing/incoming-share-model.ts"),
    "sharedFile",
    "upstream's incoming shared-file handling is missing, so the mobile share sheet cannot deliver files",
  );
});
