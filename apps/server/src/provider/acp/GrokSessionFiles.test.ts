// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { removeGrokSessionFiles, resolveGrokHome } from "./GrokSessionFiles.ts";

// Every `<project>/<session>` directory under a Grok home.
const sessionDirectories = (grokHome: string) => {
  const sessions = NodePath.join(grokHome, "sessions");
  return NodeFS.readdirSync(sessions)
    .flatMap((project) =>
      NodeFS.readdirSync(NodePath.join(sessions, project)).map((id) => `${project}/${id}`),
    )
    .toSorted();
};

const makeGrokHome = (sessions: ReadonlyArray<string>) => {
  const grokHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-files-"));
  for (const session of sessions) {
    const directory = NodePath.join(grokHome, "sessions", session);
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, "updates.jsonl"), "{}\n");
  }
  return grokHome;
};

const withGrokHome = <A, E, R>(
  sessions: ReadonlyArray<string>,
  run: (grokHome: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeGrokHome(sessions)),
    run,
    (grokHome) => Effect.sync(() => NodeFS.rmSync(grokHome, { recursive: true, force: true })),
  );

it.layer(NodeServices.layer)("removeGrokSessionFiles", (it) => {
  it.effect("removes the project directory named for the step's own working directory", () =>
    withGrokHome(
      [`${encodeURIComponent("/tmp/t3code-grok-search-abc")}/early-session`, "%2Fhome%2Fproj/kept"],
      (grokHome) =>
        Effect.gen(function* () {
          // No session ID: the step was cancelled before Grok reported one.
          yield* removeGrokSessionFiles({
            grokHome,
            sessionId: undefined,
            workingDirectories: ["/tmp/t3code-grok-search-abc"],
          });
          expect(sessionDirectories(grokHome)).toEqual(["%2Fhome%2Fproj/kept"]);
        }),
    ),
  );

  it.effect("removes a session by its ID without touching its project neighbours", () =>
    withGrokHome(["%2Fhome%2Fproj/owned-session", "%2Fhome%2Fproj/kept"], (grokHome) =>
      Effect.gen(function* () {
        yield* removeGrokSessionFiles({
          grokHome,
          sessionId: "owned-session",
          workingDirectories: [],
        });
        expect(sessionDirectories(grokHome)).toEqual(["%2Fhome%2Fproj/kept"]);
      }),
    ),
  );

  it.effect("refuses a Grok session ID that is not a plain path segment", () =>
    withGrokHome(["%2Fhome%2Fproj/kept", "victim/kept"], (grokHome) =>
      Effect.gen(function* () {
        for (const sessionId of ["../victim", "..", ".", "kept/../../victim", ""]) {
          yield* removeGrokSessionFiles({ grokHome, sessionId, workingDirectories: [] });
        }
        expect(sessionDirectories(grokHome)).toEqual(["%2Fhome%2Fproj/kept", "victim/kept"]);
      }),
    ),
  );

  it.effect("does nothing when the Grok home has no sessions directory", () =>
    Effect.gen(function* () {
      const grokHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-empty-"));
      yield* removeGrokSessionFiles({
        grokHome,
        sessionId: "any-session",
        workingDirectories: ["/tmp/anything"],
      }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(grokHome, { recursive: true }))));
    }),
  );

  it.effect("fails when the sessions directory cannot be read", () =>
    Effect.gen(function* () {
      const grokHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-broken-"));
      NodeFS.writeFileSync(NodePath.join(grokHome, "sessions"), "not a directory");
      const failed = yield* removeGrokSessionFiles({
        grokHome,
        sessionId: "any-session",
        workingDirectories: [],
      }).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(grokHome, { recursive: true }))),
      );
      expect(failed).toBeDefined();
    }),
  );
});

it("resolves the Grok home from GROK_HOME, then from HOME", () => {
  expect(resolveGrokHome({ GROK_HOME: "/opt/grok-data", HOME: "/home/a" })).toBe("/opt/grok-data");
  expect(resolveGrokHome({ GROK_HOME: "~/grok-data", HOME: "/home/a" })).toBe("/home/a/grok-data");
  expect(resolveGrokHome({ HOME: "/home/a" })).toBe("/home/a/.grok");
  expect(resolveGrokHome({ GROK_HOME: "  ", HOME: "/home/a" })).toBe("/home/a/.grok");
});
