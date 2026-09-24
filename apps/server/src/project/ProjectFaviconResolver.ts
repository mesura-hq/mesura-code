/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - FileSystem stat exposes only millisecond Date timestamps; rapid same-length saves need nanosecond metadata.
import * as NodeFSP from "node:fs/promises";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { MESURA_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { expandHomePathWith } from "../pathExpansion.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

// Resolution walks up to 12 well-known paths plus 7 source files, so a miss
// costs ~20 filesystem probes. AssetAccess resolves on every project-favicon
// asset URL, so the answer is cached. Each lookup checks .mesura.json metadata
// to refresh repository edits without parsing unchanged files. Legacy t3.json
// edits retain their existing TTL. A deleted cached icon triggers discovery.
const FAVICON_CACHE_CAPACITY = 512;
const FAVICON_POSITIVE_CACHE_TTL = Duration.minutes(10);
const FAVICON_NEGATIVE_CACHE_TTL = Duration.minutes(1);

function faviconCacheKey(cwd: string, faviconPath?: string): string {
  return `${faviconPath ?? ""}\0${cwd}`;
}

function parseFaviconCacheKey(key: string): {
  readonly cwd: string;
  readonly faviconPath?: string;
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return { cwd: key };
  }
  const faviconPath = key.slice(0, separatorIndex);
  const cwd = key.slice(separatorIndex + 1);
  return faviconPath.length === 0 ? { cwd } : { cwd, faviconPath };
}

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
] as const;

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
// The tag pattern is anchored on `<link`, so it only starts at real candidates. Object metadata
// is matched by scanning brace-free runs instead of by one combined pattern: an unanchored
// pattern restarts at every offset and rescans forward, which is quadratic on large sources.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

export class ProjectFaviconResolutionError extends Schema.TaggedError<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

/** Service tag for project favicon resolution. */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  {
    /**
     * Resolve a favicon or icon file path for the provided workspace root.
     *
     * Returns `null` when no candidate icon file can be found.
     */
    readonly resolvePath: (
      cwd: string,
      faviconPath?: string,
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
  }
>()("t3/project/ProjectFaviconResolver") {}

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  // Icon metadata counts when `rel` and `href` share a brace-free run, so a run holding `rel`
  // but no href falls through to the next one rather than ending the search.
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const projectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  const resolveIconHref = (href: string): ReadonlyArray<string> => {
    const clean = href.replace(/^\//, "");
    return [path.join("public", clean), clean];
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
    candidateScope: "workspace" | "filesystem",
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* (
        candidateScope === "filesystem" && path.isAbsolute(relativePath)
          ? Effect.succeed({ absolutePath: relativePath, relativePath })
          : workspacePaths.resolveRelativePathWithinRoot({
              workspaceRoot: projectCwd,
              relativePath,
            })
      ).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          WorkspacePathOutsideRootError: () =>
            Effect.succeed(
              Option.none<{ readonly absolutePath: string; readonly relativePath: string }>(),
            ),
        }),
      );
      if (Option.isNone(candidate)) {
        continue;
      }
      const stats = yield* optionOnNotFound(fileSystem.stat(candidate.value.absolutePath)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot: projectCwd,
              relativePath,
              absolutePath: candidate.value.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isSome(stats) && stats.value.type === "File") {
        return candidate.value.absolutePath;
      }
    }
    return null;
  });

  const resolvePathUncached = Effect.fn("ProjectFaviconResolver.resolvePathUncached")(function* (
    cwd: string,
    faviconPath?: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const projectCwd = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
      ),
    );
    const defaults = yield* projectFileLoader.loadRepositoryDefaults(projectCwd);
    // A repository icon wins over the saved local icon. A stale candidate falls
    // through to the local icon, t3.json, then automatic discovery.
    const configuredCandidates = [
      ...defaults.iconCandidates.filter((candidate) => candidate.source === "mesura"),
      // A grouped project's saved path can be absent from one checkout. That
      // is normal: use it where it exists and fall through silently elsewhere.
      ...(faviconPath === undefined ? [] : [{ value: faviconPath, source: "project" as const }]),
      ...defaults.iconCandidates.filter((candidate) => candidate.source === "t3"),
    ];
    for (const candidate of configuredCandidates) {
      const existing = yield* findExistingFile(
        projectCwd,
        [candidate.value],
        candidate.source === "project" ? "filesystem" : "workspace",
      );
      if (existing) {
        return existing;
      }
      if (candidate.source !== "project") {
        yield* Effect.logWarning(
          "Configured project icon is unavailable; trying the next candidate.",
          {
            workspaceRoot: projectCwd,
            iconPath: candidate.value,
            source: candidate.source,
          },
        );
      }
    }

    for (const candidate of FAVICON_CANDIDATES) {
      const existing = yield* findExistingFile(projectCwd, [candidate], "workspace");
      if (existing) {
        return existing;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: projectCwd,
          relativePath: sourceFile,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectFaviconResolutionError({
                operation: "resolve-path",
                workspaceRoot: projectCwd,
                relativePath: sourceFile,
                cause,
              }),
          ),
        );
      const source = yield* optionOnNotFound(
        fileSystem.readFileString(sourcePath.absolutePath),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "read-source",
              workspaceRoot: projectCwd,
              relativePath: sourceFile,
              absolutePath: sourcePath.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isNone(source)) {
        continue;
      }
      const href = extractIconHref(source.value);
      if (!href) {
        continue;
      }
      const existing = yield* findExistingFile(projectCwd, resolveIconHref(href), "workspace");
      if (existing) {
        return existing;
      }
    }

    return null;
  });

  const readRepositoryRevision = Effect.fn("ProjectFaviconResolver.readRepositoryRevision")(
    function* (cwd: string) {
      const configPath = path.join(expandHomePathWith(cwd.trim(), path), MESURA_PROJECT_FILE_NAME);
      // Date.getTime() collapsed rapid equal-length saves into one revision.
      // Preserve the filesystem's precision and detect timestamp-preserving
      // writes through ctime, plus atomic editor replacements through inode.
      return yield* Effect.tryPromise(() => NodeFSP.stat(configPath, { bigint: true })).pipe(
        Effect.match({
          onSuccess: (info) =>
            `${info.mode}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
          onFailure: (error) =>
            Predicate.isObject(error.cause) && error.cause.code === "ENOENT" ? "missing" : null,
        }),
      );
    },
  );

  const faviconCache = yield* Cache.makeWith(
    Effect.fn("ProjectFaviconResolver.loadCacheEntry")(function* (key: string) {
      const { cwd, faviconPath } = parseFaviconCacheKey(key);
      const revision = yield* readRepositoryRevision(cwd);
      const resolvedPath = yield* resolvePathUncached(cwd, faviconPath);
      return { revision, resolvedPath };
    }),
    {
      capacity: FAVICON_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value.resolvedPath === null ? FAVICON_NEGATIVE_CACHE_TTL : FAVICON_POSITIVE_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd, faviconPath) {
    const revision = yield* readRepositoryRevision(cwd);
    // Caching only by cwd previously hid edits behind the ten-minute TTL.
    // Compare the last observed revision rather than retaining historical keys:
    // deleting a config must not resurrect an earlier cached miss.
    if (revision === null) return yield* resolvePathUncached(cwd, faviconPath);
    const key = faviconCacheKey(cwd, faviconPath);
    let entry = yield* Cache.get(faviconCache, key);
    if (entry.revision !== revision) {
      yield* Cache.invalidate(faviconCache, key);
      entry = yield* Cache.get(faviconCache, key);
    }
    const cached = entry.resolvedPath;
    if (cached === null) {
      return null;
    }

    // A hit still confirms the file with one stat rather than the ~20 probes a
    // full walk costs, so a deleted icon falls back at once instead of after
    // the TTL.
    const stats = yield* optionOnNotFound(fileSystem.stat(cached)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "stat-candidate",
            workspaceRoot: cwd,
            absolutePath: cached,
            cause,
          }),
      ),
    );
    if (Option.isSome(stats) && stats.value.type === "File") {
      return cached;
    }

    yield* Cache.invalidate(faviconCache, key);
    return (yield* Cache.get(faviconCache, key)).resolvedPath;
  });

  return ProjectFaviconResolver.of({ resolvePath });
});

export const layer = Layer.effect(ProjectFaviconResolver, make);
