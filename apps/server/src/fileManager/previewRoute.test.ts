import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import {
  authorisePreview,
  authorisePreviewDirectory,
  forgetPreviewTokens,
} from "@symmetria/fm-main/previewTokens";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { FILE_MANAGER_PREVIEW_ROUTE_PREFIX } from "./FileManagerHost.ts";
import { fileManagerPreviewRouteLayer, previewResponse } from "./previewRoute.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "mesura-fm-preview-" });
});

const respond = (pathname: string, options: { method?: "GET" | "HEAD"; range?: string } = {}) =>
  previewResponse(pathname, options.method ?? "GET", { range: options.range }).pipe(
    Effect.map(HttpServerResponse.toWeb),
  );

it.layer(NodeServices.layer, { excludeTestServices: true })("the preview route", (it) => {
  // The grant tables are process-wide module state; every test starts empty.
  beforeEach(() => forgetPreviewTokens());

  describe("file grants", () => {
    it.effect("serves a granted file with the file manager's MIME type and its length", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const file = path.join(root, "picture.png");
        yield* fileSystem.writeFileString(file, "not really a png");
        const token = authorisePreview(file);

        const response = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("content-length")).toBe("16");
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(yield* Effect.promise(() => response.text())).toBe("not really a png");
      }),
    );

    it.effect("answers 404 with no body for a token nobody granted or one that was evicted", () =>
      Effect.gen(function* () {
        const unknown = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}no-such-token`);
        expect(unknown.status).toBe(404);
        expect(yield* Effect.promise(() => unknown.text())).toBe("");

        // The standalone's cap: 64 grants stay loadable, the oldest goes first.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        yield* fileSystem.writeFileString(path.join(root, "oldest.txt"), "x");
        const oldest = authorisePreview(path.join(root, "oldest.txt"));
        let newest = oldest;
        for (let index = 0; index < 64; index += 1) {
          const file = path.join(root, `later-${String(index)}.txt`);
          yield* fileSystem.writeFileString(file, "x");
          newest = authorisePreview(file);
        }
        const evicted = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${oldest}`);
        const kept = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${newest}`);
        expect(evicted.status).toBe(404);
        expect(kept.status).toBe(200);
      }),
    );

    it.effect("frames a document behind the file manager's policy, with its charset", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const file = path.join(root, "page.html");
        yield* fileSystem.writeFileString(file, "<p>héllo</p>");
        const token = authorisePreview(file);
        const url = `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}`;

        const whole = yield* respond(url);
        const partial = yield* respond(url, { range: "bytes=0-1" });

        expect(whole.headers.get("content-type")).toBe("text/html; charset=utf-8");
        for (const response of [whole, partial]) {
          expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
          expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
        }
      }),
    );

    it.effect("answers byte ranges with 206 so audio can seek, and HEAD without a body", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const file = path.join(root, "clip.mp3");
        yield* fileSystem.writeFileString(file, "0123456789");
        const token = authorisePreview(file);
        const url = `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}`;

        const partial = yield* respond(url, { range: "bytes=2-4" });
        expect(partial.status).toBe(206);
        expect(partial.headers.get("content-range")).toBe("bytes 2-4/10");
        expect(partial.headers.get("content-type")).toBe("audio/mpeg");
        expect(yield* Effect.promise(() => partial.text())).toBe("234");

        const beyond = yield* respond(url, { range: "bytes=10-" });
        expect(beyond.status).toBe(416);
        expect(beyond.headers.get("content-range")).toBe("bytes */10");

        const head = yield* respond(url, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe("10");
        expect(yield* Effect.promise(() => head.text())).toBe("");
      }),
    );

    it.effect("falls back to octet-stream for a name the MIME tables do not know", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const file = path.join(root, "mystery.zzqx");
        yield* fileSystem.writeFileString(file, "?");
        const token = authorisePreview(file);

        const response = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}`);

        expect(response.headers.get("content-type")).toBe("application/octet-stream");
      }),
    );
  });

  describe("directory grants", () => {
    it.effect("serves a neighbour of a granted document under the same prefix", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(root, "doc/images"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, "doc/images/a.svg"), "<svg/>");
        const token = authorisePreviewDirectory(path.join(root, "doc"));

        const response = yield* respond(
          `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}/images/a.svg`,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
        // The asset route sandboxes SVG; a preview must not do less.
        expect(response.headers.get("content-security-policy")).toContain("sandbox");
        expect(yield* Effect.promise(() => response.text())).toBe("<svg/>");
      }),
    );

    it.effect("reaches a neighbour whose name carries a percent sign, decoded once", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(root, "doc"));
        yield* fileSystem.writeFileString(path.join(root, "doc/100%.png"), "png?");
        yield* fileSystem.writeFileString(path.join(root, "doc/a b.png"), "spaced");
        const token = authorisePreviewDirectory(path.join(root, "doc"));

        // What the file manager's HTML preview builds: the name, encoded once.
        const percent = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}/100%25.png`);
        const spaced = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}/a%20b.png`);

        expect(yield* Effect.promise(() => percent.text())).toBe("png?");
        expect(yield* Effect.promise(() => spaced.text())).toBe("spaced");
      }),
    );

    it.effect("refuses to leave the granted directory, by dot segments or by symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(root, "doc"));
        yield* fileSystem.writeFileString(path.join(root, "secret.txt"), "no");
        yield* fileSystem.symlink(path.join(root, "secret.txt"), path.join(root, "doc/link.txt"));
        const token = authorisePreviewDirectory(path.join(root, "doc"));

        const dots = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}/../secret.txt`);
        const encodedDots = yield* respond(
          `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}/%2e%2e/secret.txt`,
        );
        const link = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}/link.txt`);
        const bare = yield* respond(`${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}/`);

        expect(dots.status).toBe(404);
        expect(encodedDots.status).toBe(404);
        expect(link.status).toBe(404);
        expect(bare.status).toBe(404);
      }),
    );

    it.effect("is mounted on its prefix and maps HEAD onto the GET route", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const file = path.join(root, "clip.mp3");
        yield* fileSystem.writeFileString(file, "0123456789");
        const token = authorisePreview(file);
        // The route's per-request services travel as the handler's context.
        const services = yield* Layer.build(NodeServices.layer);
        const handler = HttpRouter.toWebHandler(fileManagerPreviewRouteLayer, {
          disableLogger: true,
        });
        const origin = "http://preview.test";
        const url = `${origin}${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}`;

        const get = yield* Effect.promise(() => handler.handler(new Request(url), services));
        const head = yield* Effect.promise(() =>
          handler.handler(new Request(url, { method: "HEAD" }), services),
        );
        const ranged = yield* Effect.promise(() =>
          handler.handler(new Request(url, { headers: { range: "bytes=1-2" } }), services),
        );
        const elsewhere = yield* Effect.promise(() =>
          handler.handler(new Request(`${origin}/api/file-manager/nope/${token}`), services),
        );

        expect(get.status).toBe(200);
        expect(yield* Effect.promise(() => get.text())).toBe("0123456789");
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe("10");
        expect(yield* Effect.promise(() => head.text())).toBe("");
        expect(ranged.status).toBe(206);
        expect(yield* Effect.promise(() => ranged.text())).toBe("12");
        expect(elsewhere.status).toBe(404);
        yield* Effect.promise(() => handler.dispose());
      }),
    );

    it.effect("never serves a directory token as a file, nor a file token as a directory", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a");
        const fileToken = authorisePreview(path.join(root, "a.txt"));
        const directoryToken = authorisePreviewDirectory(root);

        const fileAsDirectory = yield* respond(
          `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${fileToken}/a.txt`,
        );
        const directoryAsFile = yield* respond(
          `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${directoryToken}`,
        );

        expect(fileAsDirectory.status).toBe(404);
        expect(directoryAsFile.status).toBe(404);
      }),
    );
  });
});
