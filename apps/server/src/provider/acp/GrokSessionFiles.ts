import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath, expandHomePathIn } from "../../pathExpansion.ts";

/**
 * Grok keeps each session under `$GROK_HOME/sessions/<encoded cwd>/<session id>/`
 * (`~/.grok` by default); the usage reader finds its transcripts there.
 */
export function resolveGrokHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.GROK_HOME?.trim() || "~/.grok";
  const home = environment.HOME?.trim();
  return home ? expandHomePathIn(configured, home) : expandHomePath(configured);
}

const isSafePathSegment = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

/**
 * Remove the native files of a Grok session this process created. Call after
 * the process closes. Two proofs of ownership, and nothing else is touched:
 *
 * - a project directory named for one of the step's own temporary working
 *   directories, which nothing else can share; this also covers a step
 *   cancelled before Grok reported its session ID;
 * - a session directory named for the session ID Grok returned to this step.
 *
 * Fails when a file cannot be removed, so the caller can report a transcript
 * left behind.
 */
export const removeGrokSessionFiles = Effect.fn("removeGrokSessionFiles")(function* (input: {
  readonly grokHome: string;
  readonly sessionId: string | undefined;
  readonly workingDirectories: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessionsDirectory = path.join(input.grokHome, "sessions");
  if (!(yield* fs.exists(sessionsDirectory))) {
    return;
  }
  const ownedProjects = new Set(input.workingDirectories.map((cwd) => encodeURIComponent(cwd)));
  const sessionId =
    input.sessionId !== undefined && isSafePathSegment(input.sessionId)
      ? input.sessionId
      : undefined;
  for (const entry of yield* fs.readDirectory(sessionsDirectory)) {
    const projectDirectory = path.join(sessionsDirectory, entry);
    if (ownedProjects.has(entry)) {
      yield* fs.remove(projectDirectory, { recursive: true, force: true });
      continue;
    }
    if (sessionId === undefined) continue;
    const sessionDirectory = path.join(projectDirectory, sessionId);
    if (yield* fs.exists(sessionDirectory)) {
      yield* fs.remove(sessionDirectory, { recursive: true, force: true });
    }
  }
});
