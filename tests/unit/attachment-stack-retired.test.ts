// @effect-diagnostics nodeBuiltinImport:off - reads the repository tree as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * ADR-003 retired this fork's own attachment stack in favour of upstream's.
 * These pin the shape of that retirement, because the two ways it goes wrong
 * are both silent.
 *
 * The first is under-reverting: a file of the fork's stack survives, and the
 * fork carries two upload paths again with nothing failing.
 *
 * The second is over-reverting, which is worse. `attachmentStore.ts` and
 * `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` predate the fork's stack — they are
 * upstream's, and image attachments depend on them. Deleting them along with
 * the fork's own code takes image attachments out, and the suites would not
 * necessarily notice.
 *
 * These live in `tests/unit`, which upstream never touches, so they cost
 * nothing at the next merge.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

const exists = (relativePath: string) =>
  NodeFS.existsSync(NodePath.join(repositoryRoot, relativePath));

// Every production file the fork's stack owned. Naming them individually rather
// than globbing on "attachment" keeps this from matching upstream's own files,
// which predate the fork's stack and must survive.
const RETIRED_STACK_FILES = [
  "apps/server/src/attachmentUploadHttp.ts",
  "apps/server/src/attachmentUploadStore.ts",
  "apps/server/src/attachmentUploadRoute.test.ts",
  "apps/server/src/attachmentUploadCleanup.ts",
  "apps/server/src/provider/attachmentDelivery.ts",
  "apps/web/src/lib/attachmentUpload.ts",
  "apps/web/src/components/chat/composerAttachments.ts",
  "apps/web/src/components/chat/ComposerAttachmentList.tsx",
  // Two paths the fork's stack owned are deliberately absent from this list:
  // apps/mobile/src/lib/attachmentUpload.ts and composerAttachmentFiles.ts.
  // Upstream independently chose the same filenames for its own mobile
  // attachment work, and the 2026-W35 merge brought their versions in
  // byte-identically. Asserting on those paths would now fail on upstream's
  // code rather than on a resurrected fork file.
  "apps/mobile/src/state/attachment-upload-progress.ts",
  "packages/client-runtime/src/state/attachmentUploadHttp.ts",
];

it("removes every file of the fork's own attachment stack", () => {
  const surviving = RETIRED_STACK_FILES.filter(exists);
  assert.deepEqual(
    surviving,
    [],
    "the fork's retired upload stack is still present, so this fork carries two upload paths",
  );
});

it("keeps upstream's attachment store, which image attachments need", () => {
  // Predates the fork's stack. Reverting it would take image attachments with it.
  assert.isTrue(
    exists("apps/server/src/attachmentStore.ts"),
    "attachmentStore.ts was deleted, not reverted — image attachments depend on it",
  );
});

it("drops the fork's file ceiling and keeps upstream's image ceiling", () => {
  const contracts = read("packages/contracts/src/orchestration.ts");
  // Upstream owns this constant now, at 50 MB. What must not come back is the
  // fork's own 2 GB ceiling, which only made sense with the resumable
  // transport ADR-003 retired.
  assert.notInclude(
    contracts,
    "PROVIDER_SEND_TURN_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024",
    "the fork's 2 GB file ceiling came back; upstream's stack sets its own limit",
  );
  assert.include(
    contracts,
    "PROVIDER_SEND_TURN_MAX_IMAGE_BYTES",
    "upstream's image ceiling was removed along with the fork's file ceiling",
  );
});
