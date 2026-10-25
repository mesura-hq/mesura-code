import * as Effect from "effect/Effect";

import * as ProjectFaviconResolver from "../ProjectFaviconResolver.ts";

/** Keeps path and effective-image lookups consistent in metadata service fixtures. */
export const projectFaviconResolverForPath = (
  resolvePath: ProjectFaviconResolver.ProjectFaviconResolver["Service"]["resolvePath"],
) =>
  ProjectFaviconResolver.ProjectFaviconResolver.of({
    invalidate: () => Effect.void,
    resolvePath,
    resolveEffectiveImage: (...args) =>
      resolvePath(...args).pipe(
        Effect.map((resolved) =>
          resolved === null ? null : { path: resolved, source: "detected" as const },
        ),
      ),
  });
