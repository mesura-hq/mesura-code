// @effect-diagnostics nodeBuiltinImport:off - reads the repository tree as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * ADR-003 adopted upstream's attachment stack partly for its browser hardening, so this asserts it
 * arrived: the content disposition (download, not render), the sandbox policy, and the media type
 * allow-list (html or xml served opaque). It reads source, because a merge resolution that dropped
 * the implementation would leave the tree building and every other suite green.
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
