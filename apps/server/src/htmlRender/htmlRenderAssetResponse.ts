import { refreshHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";

// Published renders allow 25 MiB, plus the host bootstrap added at publication.
const MAX_STORED_RENDER_BYTES = 25 * 1024 * 1024 + 128 * 1024;

export const htmlRenderAssetResponse = Effect.fn("HtmlRender.assetResponse")(function* (
  asset: { readonly path: string; readonly download?: boolean },
  headers: Readonly<Record<string, string>>,
  method: "GET" | "HEAD",
) {
  if (asset.download || headers["Content-Type"] !== "text/html; charset=utf-8") return undefined;
  const fs = yield* FileSystem.FileSystem;
  const chunks = yield* Stream.runCollect(
    fs.stream(asset.path, { bytesToRead: MAX_STORED_RENDER_BYTES + 1 }),
  );
  if (chunks.reduce((size, chunk) => size + chunk.byteLength, 0) > MAX_STORED_RENDER_BYTES)
    return undefined;
  const decoder = new TextDecoder();
  const stored =
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
  const refreshed = refreshHtmlRenderBootstrap(stored);
  if (refreshed === undefined) return undefined;
  const body = new TextEncoder().encode(refreshed);
  const responseHeaders = { ...headers, "Content-Length": String(body.byteLength) };
  return method === "HEAD"
    ? HttpServerResponse.empty({ status: 200, headers: responseHeaders })
    : HttpServerResponse.uint8Array(body, { headers: responseHeaders });
});
