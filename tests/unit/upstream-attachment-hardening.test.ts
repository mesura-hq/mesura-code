// @effect-diagnostics nodeBuiltinImport:off - reads the repository tree as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * ADR-003 retired this fork's attachment stack partly because upstream's
 * defends the browser against a hostile attachment and the fork's never did.
 * That defence is the concrete thing the fork gains by switching, so it is
 * worth asserting it actually arrived rather than assuming the merge brought
 * it.
 *
 * Three pieces, each of which fails differently if it goes missing:
 *
 * - the content disposition, so a browser downloads an attachment instead of
 *   rendering it;
 * - the sandbox policy, so anything that does render cannot reach out;
 * - the media type allow-list, so an attachment claiming to be html or xml is
 *   served as an opaque download instead.
 *
 * This lives in `tests/unit`, which upstream never touches, so it costs nothing
 * at the next merge. It reads the source rather than driving a request, because
 * what it pins is that the merge kept upstream's implementation — a resolution
 * that dropped it would leave the tree building and every other suite green.
 */

const serverHttp = () =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, "apps/server/src/http.ts"), "utf8");

it("serves attachments as downloads rather than letting a browser render them", () => {
  assert.include(
    serverHttp(),
    "downloadContentDisposition",
    "upstream's download disposition helper is missing, so an attachment may render in the browser",
  );
});

it("keeps the sandbox policy upstream applies to attachment responses", () => {
  assert.include(
    serverHttp(),
    "default-src 'none'; sandbox",
    "the sandbox content-security policy on attachment responses is missing",
  );
});

it("refuses to serve an attachment under a media type a browser will render", () => {
  const source = serverHttp();
  assert.include(
    source,
    "isSafeDownloadMimeType",
    "upstream's media type allow-list is missing, so a hostile media type is passed through",
  );
  assert.include(
    source,
    "application/octet-stream",
    "the fallback media type is missing, so an unsafe type has nothing to fall back to",
  );
});
