import { resolveMimeType } from "@symmetria/fm-core/mime";
import { mimeTables } from "@symmetria/fm-main/fs/mimeTables";
import { resolvePreviewDirectoryPath, resolveToken } from "@symmetria/fm-main/previewTokens";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { openMediaFile, statMediaFile, streamMediaFile } from "../assets/MediaFile.ts";
import { assetByteRange, assetResponseHeaders } from "../http.ts";
import { FILE_MANAGER_PREVIEW_ROUTE_PREFIX } from "./FileManagerHost.ts";

/**
 * Serves the files `fm-main`'s `previewTokens` granted, as same-origin URLs (Chromium's PDF
 * viewer refuses a blob URL). `<prefix><token>` serves a FILE token's file. `<prefix><token>/<rel>`
 * serves a neighbour of a DIRECTORY token's document, refused outside that directory once links
 * are followed. Any other pairing is 404. Tokens keep the standalone's 64-grant eviction policy.
 */

const notFound = () => HttpServerResponse.empty({ status: 404 });

/** The MIME type the file manager itself would give this name; text types name their charset. */
const previewMimeType = Effect.fn("previewMimeType")(function* (path: string) {
  const pathService = yield* Path.Path;
  const tables = yield* Effect.promise(() => mimeTables());
  const mime = resolveMimeType(tables, pathService.basename(path)) ?? "application/octet-stream";
  return mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime;
});

/**
 * Copied from the standalone's `app/src/main/fileResponse.ts`. The file manager frames HTML
 * previews with `allow-same-origin`, so this CSP stops an untrusted page from fetching remote
 * resources. It rides on every status the route answers for such a document, not the 200 alone.
 */
const FRAMED_DOCUMENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const DOCUMENT_POLICY =
  "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; media-src 'self'; form-action 'none'; base-uri 'none'";

function documentPolicy(contentType: string): Record<string, string> {
  const bare = contentType.split(";")[0]?.trim() ?? contentType;
  return FRAMED_DOCUMENT_TYPES.has(bare) ? { "Content-Security-Policy": DOCUMENT_POLICY } : {};
}

/**
 * The file a request names, or none: a file token alone, or a directory
 * token with a contained relative path.
 */
const grantedFile = Effect.fn("grantedFile")(function* (pathname: string) {
  if (!pathname.startsWith(FILE_MANAGER_PREVIEW_ROUTE_PREFIX)) return null;
  const rest = pathname.slice(FILE_MANAGER_PREVIEW_ROUTE_PREFIX.length);
  const slash = rest.indexOf("/");
  const token = slash === -1 ? rest : rest.slice(0, slash);
  if (token === "") return null;

  if (slash === -1) {
    const path = resolveToken(token);
    if (path === null) return null;
    // A granted path may be a symbolic link; the opener below accepts only a
    // real path, so the link is followed here, once.
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => null));
  }

  // Raw, not decoded here: `resolveWithinRoot` under `resolvePreviewDirectoryPath`
  // decodes the relative path itself and answers null for a malformed
  // sequence. Decoding twice made a neighbour named `100%.png` unreachable.
  return yield* Effect.promise(() => resolvePreviewDirectoryPath(token, rest.slice(slash + 1)));
});

/**
 * A twin of `assetFileResponse` in upstream's `http.ts`, kept apart because that file moves
 * often; mirror its byte-serving changes here. It differs on purpose: ranges on every type
 * (`<audio>` seeks by range), `no-store` with no validators, and the file manager's MIME table.
 */
export const previewResponse = Effect.fn("previewResponse")(function* (
  pathname: string,
  method: "GET" | "HEAD",
  headers: { readonly range?: string | undefined },
) {
  const path = yield* grantedFile(pathname);
  if (path === null) return notFound();

  // NOT scoped here, on purpose: the body streams after this effect returns, so the descriptor
  // lives in the request's scope. Wrapping the open in `Effect.scoped` closed it before the
  // first read ("fd out of range: -1").
  const file = yield* openMediaFile(path).pipe(Effect.orElseSucceed(() => null));
  if (file === null) return notFound();
  const info = yield* statMediaFile(path, file).pipe(Effect.orElseSucceed(() => null));
  if (info === null) return notFound();

  const contentType = yield* previewMimeType(path);
  const responseHeaders: Record<string, string> = {
    // Spread for `X-Content-Type-Options: nosniff` and the SVG sandbox
    // policy; its `Content-Type` and `Cache-Control` are replaced below.
    ...assetResponseHeaders(path),
    ...documentPolicy(contentType),
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // No validators yet (no ETag, no Last-Modified), so nothing may be cached.
    "Cache-Control": "private, no-store",
  };

  let status = 200;
  let offset = 0n;
  let size = info.size;
  if (method === "GET" && headers.range !== undefined) {
    const range = assetByteRange(headers.range, info.size);
    if (range?._tag === "Unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...responseHeaders, "Content-Range": `bytes */${info.size}` },
      });
    }
    if (range?._tag === "Range") {
      status = 206;
      offset = range.offset;
      size = range.bytesToRead;
      responseHeaders["Content-Range"] = range.contentRange;
    }
  }
  responseHeaders["Content-Length"] = String(size);
  if (method === "HEAD" || size === 0n) {
    return HttpServerResponse.empty({ status, headers: responseHeaders });
  }
  const body = streamMediaFile(file, offset, size);
  if (body === null)
    return HttpServerResponse.text("File is too large to preview.", { status: 413 });
  return HttpServerResponse.stream(body, { status, headers: responseHeaders });
});

/** `HEAD` reaches the `GET` route, as it does for the asset route. */
export const fileManagerPreviewRouteLayer = HttpRouter.add(
  "GET",
  `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    return yield* previewResponse(url.value.pathname, request.method === "HEAD" ? "HEAD" : "GET", {
      range: request.headers.range,
    });
  }),
);
