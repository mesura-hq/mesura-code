import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-favicon-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const makeResolverWithFileSystem = (fileSystem: FileSystem.FileSystem) =>
  T3ProjectFileLoader.make.pipe(
    Effect.flatMap((loader) =>
      ProjectFaviconResolver.make.pipe(
        Effect.provideService(T3ProjectFileLoader.T3ProjectFileLoader, loader),
        Effect.provide(WorkspacePaths.layer),
      ),
    ),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect(
      "logs a stale Mesura icon and falls through saved and legacy icons to discovery",
      () => {
        const messages: unknown[] = [];
        const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
        return Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(
            cwd,
            ".mesura.json",
            '{ "version": 1, "iconPath": "brand/portable.svg" }',
          );
          yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/legacy.svg" }');
          for (const name of [
            "brand/portable.svg",
            "brand/saved.svg",
            "brand/legacy.svg",
            "favicon.svg",
          ]) {
            yield* writeTextFile(cwd, name, "<svg/>");
          }
          const resolve = resolver.resolvePath(cwd, "brand/saved.svg");
          for (const expected of [
            "brand/portable.svg",
            "brand/saved.svg",
            "brand/legacy.svg",
            "favicon.svg",
          ]) {
            expect(yield* resolve).toBe(path.join(cwd, expected));
            yield* fileSystem.remove(path.join(cwd, expected));
          }
          expect(messages).toContainEqual([
            "Configured project icon is unavailable; trying the next candidate.",
            { workspaceRoot: cwd, iconPath: "brand/portable.svg", source: "mesura" },
          ]);
          expect(messages).toContainEqual([
            "Configured project icon is unavailable; trying the next candidate.",
            { workspaceRoot: cwd, iconPath: "brand/legacy.svg", source: "t3" },
          ]);
          expect(messages).not.toContainEqual([
            expect.any(String),
            expect.objectContaining({ source: "project" }),
          ]);
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      },
    );

    it.effect("retains the legacy t3 icon cache lifetime after edits", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        for (const fileName of ["t3.json"]) {
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "brand/old.svg", "<svg/>");
          yield* writeTextFile(cwd, "brand/new.svg", "<svg/>");
          yield* writeTextFile(cwd, fileName, '{ "version": 1, "iconPath": "brand/old.svg" }');
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand", "old.svg"));

          yield* writeTextFile(cwd, fileName, '{ "version": 1, "iconPath": "brand/new.svg" }');
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand", "old.svg"));
          yield* TestClock.adjust(Duration.minutes(11));
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand", "new.svg"));
        }
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("refreshes Mesura icon edits while the old image still exists", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const configPath = path.join(cwd, ".mesura.json");
        yield* writeTextFile(cwd, "brand/old.svg", "<svg/>");
        yield* writeTextFile(cwd, "brand/new.svg", "<svg/>");
        yield* writeTextFile(cwd, ".mesura.json", '{ "version": 1, "iconPath": "brand/old.svg" }');
        yield* fileSystem.utimes(configPath, 1000, 1000);
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand/old.svg"));
        yield* writeTextFile(cwd, ".mesura.json", '{ "version": 1, "iconPath": "brand/new.svg" }');
        yield* fileSystem.utimes(configPath, 1001, 1001);
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand/new.svg"));
      }),
    );

    it.effect("refreshes rapid same-length Mesura saves without changing file timestamps", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const configPath = path.join(cwd, ".mesura.json");
        yield* writeTextFile(cwd, "brand/old.svg", "<svg/>");
        yield* writeTextFile(cwd, "brand/new.svg", "<svg/>");
        for (let save = 0; save < 80; save += 1) {
          const iconPath = save % 2 === 0 ? "brand/old.svg" : "brand/new.svg";
          yield* fileSystem.writeFileString(configPath, `{"version":1,"iconPath":"${iconPath}"}`);
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, iconPath));
        }
      }),
    );

    it.effect(
      "refreshes an atomic Mesura replacement with the same length and modification time",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
          const cwd = yield* makeTempDir;
          const configPath = path.join(cwd, ".mesura.json");
          const replacementPath = path.join(cwd, ".mesura.json.tmp");
          yield* writeTextFile(cwd, "brand/old.svg", "<svg/>");
          yield* writeTextFile(cwd, "brand/new.svg", "<svg/>");
          yield* fileSystem.writeFileString(configPath, '{"version":1,"iconPath":"brand/old.svg"}');
          yield* fileSystem.utimes(configPath, 1000, 1000);
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand/old.svg"));
          yield* fileSystem.writeFileString(
            replacementPath,
            '{"version":1,"iconPath":"brand/new.svg"}',
          );
          yield* fileSystem.utimes(replacementPath, 1000, 1000);
          yield* fileSystem.rename(replacementPath, configPath);
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand/new.svg"));
        }),
    );

    it.effect(
      "refreshes Mesura additions removals and invalid replacements across cached misses",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "brand/portable.svg", "<svg/>");
          expect(yield* resolver.resolvePath(cwd)).toBeNull();
          yield* writeTextFile(
            cwd,
            ".mesura.json",
            '{ "version": 1, "iconPath": "brand/portable.svg" }',
          );
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand/portable.svg"));
          yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
          yield* fileSystem.remove(path.join(cwd, ".mesura.json"));
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
          yield* writeTextFile(cwd, "brand/saved.svg", "<svg/>");
          yield* writeTextFile(cwd, "brand/legacy.svg", "<svg/>");
          yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/legacy.svg" }');
          yield* writeTextFile(
            cwd,
            ".mesura.json",
            '{ "version": 1, "iconPath": "brand/portable.svg" }',
          );
          expect(yield* resolver.resolvePath(cwd, "brand/saved.svg")).toBe(
            path.join(cwd, "brand/portable.svg"),
          );
          yield* writeTextFile(cwd, ".mesura.json", "{ broken");
          expect(yield* resolver.resolvePath(cwd, "brand/saved.svg")).toBe(
            path.join(cwd, "brand/saved.svg"),
          );
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand/legacy.svg"));
        }),
    );

    it.effect("does not reread unchanged Mesura configuration on icon cache hits", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const configPath = path.join(cwd, ".mesura.json");
        yield* writeTextFile(cwd, "brand/icon.svg", "<svg/>");
        yield* writeTextFile(cwd, ".mesura.json", '{ "version": 1, "iconPath": "brand/icon.svg" }');
        // A configuration changed moments ago is compared by content, because a
        // second save in the same timestamp tick would leave its metadata alone.
        // A minute later both its mtime and its ctime are settled.
        const saved = yield* fileSystem.stat(configPath);
        yield* TestClock.setTime(
          Option.getOrThrow(saved.mtime).getTime() + Duration.toMillis(Duration.minutes(1)),
        );
        let configReads = 0;
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            readFileString: (filePath, encoding) => {
              if (filePath === configPath) configReads += 1;
              return fileSystem.readFileString(filePath, encoding);
            },
          }),
        );
        for (const _attempt of [1, 2, 3]) {
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand/icon.svg"));
        }
        expect(configReads).toBe(1);
      }),
    );

    it.effect("follows a same-length Mesura save that restores its modification time", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const configPath = path.join(cwd, ".mesura.json");
        yield* writeTextFile(cwd, "brand/old.svg", "<svg/>");
        yield* writeTextFile(cwd, "brand/new.svg", "<svg/>");
        // The clock reads the time of these writes, so only a recent ctime can
        // make the configuration count as changed.
        const now = yield* fileSystem.stat(path.join(cwd, "brand/new.svg"));
        yield* TestClock.setTime(Option.getOrThrow(now.mtime).getTime());
        // Saves rapid enough to share a ctime tick, as in the test above, each
        // putting back an old mtime.
        for (let save = 0; save < 80; save += 1) {
          const iconPath = save % 2 === 0 ? "brand/old.svg" : "brand/new.svg";
          yield* fileSystem.writeFileString(configPath, `{"version":1,"iconPath":"${iconPath}"}`);
          yield* fileSystem.utimes(configPath, 1000, 1000);
          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, iconPath));
        }
      }),
    );

    it.effect("serves repeated resolves from cache instead of re-walking candidates", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "public/favicon.svg", "<svg>public</svg>");

        const resolved = yield* resolver.resolvePath(cwd);
        expect(resolved?.endsWith(path.join("public", "favicon.svg"))).toBe(true);

        // `favicon.svg` outranks `public/favicon.svg`, so a resolver that walked
        // the candidate list again would switch to it. Staying on the original
        // answer is only possible from cache.
        yield* writeTextFile(cwd, "favicon.svg", "<svg>root</svg>");

        for (const _attempt of [1, 2, 3]) {
          expect(yield* resolver.resolvePath(cwd)).toBe(resolved);
        }

        yield* TestClock.adjust(Duration.minutes(11));

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
        expect(yield* resolver.resolvePath(cwd)).not.toBe(resolved);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("falls back at once when a cached favicon is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        expect(yield* resolver.resolvePath(cwd)).not.toBeNull();

        yield* fileSystem.remove(path.join(cwd, "favicon.svg")).pipe(Effect.orDie);

        // Still inside the positive TTL: the cached path must not be served.
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("re-probes for a favicon added after a miss once the negative TTL expires", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        expect(yield* resolver.resolvePath(cwd)).toBeNull();

        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");
        expect(yield* resolver.resolvePath(cwd)).toBeNull();

        yield* TestClock.adjust(Duration.minutes(2));

        expect(yield* resolver.resolvePath(cwd)).not.toBeNull();
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("prefers a t3.json iconPath over well-known files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/mark.svg" }');
        yield* writeTextFile(cwd, "brand/mark.svg", "<svg>mark</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(cwd, "brand", "mark.svg"));
      }),
    );

    it.effect("uses a saved project favicon override", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "brand/custom.svg", "<svg>custom</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>automatic</svg>");

        const resolved = yield* resolver.resolvePath(cwd, "brand/custom.svg");

        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(cwd, "brand", "custom.svg"));
      }),
    );

    it.effect("uses a saved project favicon outside the workspace", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const pictures = yield* makeTempDir;
        yield* writeTextFile(pictures, "custom.png", "image");
        const externalPath = path.join(pictures, "custom.png");

        const resolved = yield* resolver.resolvePath(cwd, externalPath);

        expect(resolved).toBe(externalPath);
      }),
    );

    it.effect("falls back when a saved override is missing from a checkout", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>automatic</svg>");

        const resolved = yield* resolver.resolvePath(cwd, "brand/missing.svg");

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("falls back to well-known files when the t3.json iconPath does not exist", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/missing.svg" }');
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("ignores invalid t3.json files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", "{ not json");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("does not resolve a t3.json iconPath outside the workspace root", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const parent = yield* makeTempDir;
        const cwd = `${parent}/app`;
        yield* writeTextFile(parent, "secret.svg", "<svg>secret</svg>");
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "../secret.svg" }');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    it.effect("resolves icon hrefs from object-literal route metadata", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/routes/__root.tsx",
          `export const Route = createRootRoute({
  head: () => ({
    links: [
      { rel: "stylesheet", href: "/app.css" },
      { rel: "icon", href: "/brand/logo.svg" },
    ],
  }),
});`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    it.effect("resolves object-literal icon metadata when href precedes rel", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/root.tsx",
          `const links = [{ href: "/brand/logo.svg", rel: "shortcut icon" }];`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    it.effect("resolves object-literal icon metadata alongside nested objects", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/root.tsx",
          `const links = [{ attributes: {}, rel: "icon", href: "/brand/logo.svg" }];`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    it.effect("skips icon metadata without an href and keeps scanning", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/root.tsx",
          `const links = [{ rel: "icon" }, { rel: "icon", href: "/brand/logo.svg" }];`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    // A large icon source with no icon metadata used to pin the server's event loop for
    // minutes: the object pattern was unanchored, so it restarted at every offset and
    // rescanned forward from each one. Anchoring keeps this proportional to file size.
    it.effect("scans large icon sources without an icon in reasonable time", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        // Mirrors a generated single-file build: large, brace-sparse, and no icon metadata.
        const filler = `<p>${"pokopia companion guide ".repeat(24)}</p>\n`;
        yield* writeTextFile(
          cwd,
          "index.html",
          `<!doctype html><html><head><title>guide</title></head><body>\n${filler.repeat(1200)}</body></html>`,
        );

        const startedAt = performance.now();
        const resolved = yield* resolver.resolvePath(cwd);
        const elapsedMs = performance.now() - startedAt;

        expect(resolved).toBeNull();
        expect(elapsedMs).toBeLessThan(5_000);
      }),
    );

    it.effect("returns null when no icon is present", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("preserves workspace normalization context", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const missingCwd = `${cwd}/missing`;

        const error = yield* resolver.resolvePath(missingCwd).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProjectFaviconResolutionError",
          operation: "normalize-workspace",
          workspaceRoot: missingCwd,
        });
        expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspaceRootNotExistsError);
      }),
    );

    it.effect("preserves non-missing candidate stat failures", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const faviconPath = path.join(cwd, "favicon.svg");
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "stat",
          pathOrDescriptor: faviconPath,
        });
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (filePath) =>
              filePath === faviconPath ? Effect.fail(cause) : fileSystem.stat(filePath),
          }),
        );

        const error = yield* resolver.resolvePath(cwd).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProjectFaviconResolutionError",
          operation: "stat-candidate",
          workspaceRoot: cwd,
          relativePath: "favicon.svg",
          absolutePath: faviconPath,
        });
        expect(error.cause).toBe(cause);
      }),
    );

    it.effect("preserves icon source read failures", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const sourcePath = path.join(cwd, "index.html");
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/favicon.svg">');
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: sourcePath,
        });
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            readFileString: (filePath, options) =>
              filePath === sourcePath
                ? Effect.fail(cause)
                : fileSystem.readFileString(filePath, options),
          }),
        );

        const error = yield* resolver.resolvePath(cwd).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProjectFaviconResolutionError",
          operation: "read-source",
          workspaceRoot: cwd,
          relativePath: "index.html",
          absolutePath: sourcePath,
        });
        expect(error.cause).toBe(cause);
      }),
    );

    it.effect("skips icon metadata paths outside the workspace", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="../../secret.svg">');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("continues to later sources after an outside-root icon href", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="../../secret.svg">');
        yield* writeTextFile(cwd, "public/index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );
  });
});
