import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerResponse } from "effect/http";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";

import { assetFileResponse, assetResponseHeaders } from "../http.ts";

const layer = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);
const legacy =
  '<!doctype html><head><style id="t3-theme">old theme</style>' +
  '<script>(function(){var s=document.getElementById("t3-theme");legacy();})();</script>' +
  "</head><body><script>page()</script>☃</body>";

describe("HTML render asset responses", () => {
  it.effect(
    "upgrades historical documents on GET and HEAD with fresh byte lengths and the same policy",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-html-render-" });
        const file = path.join(directory, "render.html");
        yield* fs.writeFileString(file, legacy);
        const expected = injectHtmlRenderBootstrap(legacy);
        for (const method of ["GET", "HEAD"] as const) {
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse(
              { path: file, mimeType: "text/html" },
              "bytes=0-1",
              undefined,
              method,
            ),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-length")).toBe(
            String(new TextEncoder().encode(expected).byteLength),
          );
          for (const [header, value] of Object.entries(
            assetResponseHeaders(file, { mimeType: "text/html" }),
          )) {
            expect(response.headers.get(header)).toBe(value);
          }
          expect(response.headers.get("etag")).toBeNull();
          expect(response.headers.get("last-modified")).toBeNull();
          expect(yield* Effect.promise(() => response.text())).toBe(
            method === "HEAD" ? "" : expected,
          );
        }
        expect(yield* fs.readFileString(file)).toBe(legacy);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("serves a current bootstrap once and leaves downloads unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "mesura-html-render-current-",
      });
      const file = path.join(directory, "render.html");
      const current = injectHtmlRenderBootstrap("<p>☃</p>");
      yield* fs.writeFileString(file, current);
      const response = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, mimeType: "text/html" }),
      );
      expect(yield* Effect.promise(() => response.text())).toBe(current);
      yield* fs.writeFileString(file, legacy);
      const download = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, download: true }),
      );
      expect(yield* Effect.promise(() => download.text())).toBe(legacy);
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps authored HTML without the render bootstrap unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-authored-html-" });
      const file = path.join(directory, "page.html");
      const authored = "<!doctype html><p>hello</p>";
      yield* fs.writeFileString(file, authored);
      const response = HttpServerResponse.toWeb(yield* assetFileResponse({ path: file }));
      expect(yield* Effect.promise(() => response.text())).toBe(authored);
    }).pipe(Effect.provide(layer)),
  );
});
