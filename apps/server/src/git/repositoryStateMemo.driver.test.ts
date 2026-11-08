// @effect-diagnostics nodeBuiltinImport:off
/**
 * Drives `memoizeRepositoryReads` over the counting real driver: only reads under
 * `UseRepositoryStateMemo` are memoized, and a change to anything they depend on (an included
 * config file, the system config, a loose ref rewritten in place) reaches the next read.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeGitManagerOverRealGit,
  makeTrackedBranchesRepository,
  runGitSync,
} from "./GitManager.testkit.ts";
import { memoizeRepositoryReads, UseRepositoryStateMemo } from "./repositoryStateMemo.ts";

const REMOTE_URL = "https://github.com/acme/widgets.git";

/** A repository, the memoized driver over the counting real driver, and a sweep-scoped read. */
const makeMemoizedDriver = Effect.gen(function* () {
  const repo = yield* makeTrackedBranchesRepository({
    remoteUrl: REMOTE_URL,
    branches: ["feature/memo"],
  });
  const { git, spawned } = yield* makeGitManagerOverRealGit();
  const memoized = memoizeRepositoryReads(git);
  const asSweep = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.provideService(UseRepositoryStateMemo, true));
  // A fresh event-loop turn, so the next read recomputes the fingerprint.
  // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- The memo expires fingerprints with setImmediate; a real event-loop turn exercises that cache boundary without sleeping.
  const nextTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
  return { repo, memoized, spawned, asSweep, nextTurn };
});

describe("repository state memo through the git driver", () => {
  it.effect("repository state memo: reads outside the sweep always run git", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, memoized, spawned, nextTurn } = yield* makeMemoizedDriver;
        yield* memoized.readConfigValue(repo, "remote.origin.url");
        yield* nextTurn;
        const before = spawned.length;
        yield* memoized.readConfigValue(repo, "remote.origin.url");
        expect(spawned.length - before).toBe(1);
      }),
    ),
  );

  it.effect("repository state memo: the sweep's repeated read spawns nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, memoized, spawned, asSweep, nextTurn } = yield* makeMemoizedDriver;
        yield* asSweep(memoized.readConfigValue(repo, "remote.origin.url"));
        yield* nextTurn;
        const before = spawned.length;
        expect(yield* asSweep(memoized.readConfigValue(repo, "remote.origin.url"))).toBe(
          REMOTE_URL,
        );
        expect(spawned.length - before).toBe(0);
      }),
    ),
  );

  it.effect("repository state memo: an edited include.path file reaches the next read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, memoized, asSweep, nextTurn } = yield* makeMemoizedDriver;
        const included = NodePath.join(NodePath.dirname(repo), "remotes.gitconfig");
        NodeFS.writeFileSync(
          included,
          `[remote "upstream"]\n\turl = https://github.com/acme/a.git\n`,
        );
        runGitSync(repo, ["config", "include.path", "../../remotes.gitconfig"]);
        expect(yield* asSweep(memoized.readConfigValue(repo, "remote.upstream.url"))).toBe(
          "https://github.com/acme/a.git",
        );
        yield* nextTurn;
        // Rewritten in place, as an editor would; git never touches the repository.
        NodeFS.writeFileSync(
          included,
          `[remote "upstream"]\n\turl = https://github.com/acme/b.git\n`,
        );
        expect(yield* asSweep(memoized.readConfigValue(repo, "remote.upstream.url"))).toBe(
          "https://github.com/acme/b.git",
        );
      }),
    ),
  );

  it.effect("repository state memo: an edited includeIf file reaches the next read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, memoized, asSweep, nextTurn } = yield* makeMemoizedDriver;
        const included = NodePath.join(NodePath.dirname(repo), "conditional.gitconfig");
        NodeFS.writeFileSync(included, "[t3code]\n\tprobe = one\n");
        runGitSync(repo, ["config", `includeIf.gitdir:${repo}/.git.path`, included]);
        expect(yield* asSweep(memoized.readConfigValue(repo, "t3code.probe"))).toBe("one");
        yield* nextTurn;
        NodeFS.writeFileSync(included, "[t3code]\n\tprobe = two\n");
        expect(yield* asSweep(memoized.readConfigValue(repo, "t3code.probe"))).toBe("two");
      }),
    ),
  );

  it.effect("repository state memo: an edited system config reaches the next read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, memoized, asSweep, nextTurn } = yield* makeMemoizedDriver;
        const systemConfig = NodePath.join(NodePath.dirname(repo), "system.gitconfig");
        NodeFS.writeFileSync(systemConfig, "[t3code]\n\tsystem = one\n");
        const previous = process.env.GIT_CONFIG_SYSTEM;
        process.env.GIT_CONFIG_SYSTEM = systemConfig;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.GIT_CONFIG_SYSTEM;
            else process.env.GIT_CONFIG_SYSTEM = previous;
          }),
        );
        expect(yield* asSweep(memoized.readConfigValue(repo, "t3code.system"))).toBe("one");
        yield* nextTurn;
        NodeFS.writeFileSync(systemConfig, "[t3code]\n\tsystem = two\n");
        expect(yield* asSweep(memoized.readConfigValue(repo, "t3code.system"))).toBe("two");
      }),
    ),
  );

  it.effect("repository state memo: a loose ref rewritten in place reaches the next read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, memoized, asSweep, nextTurn } = yield* makeMemoizedDriver;
        runGitSync(repo, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
        expect(yield* asSweep(memoized.resolveDefaultBranchName(repo, "origin"))).toBe("main");
        yield* nextTurn;
        // Same inode, same directory entry: only the file itself changes.
        const headRef = NodePath.join(repo, ".git", "refs", "remotes", "origin", "HEAD");
        NodeFS.writeFileSync(headRef, "ref: refs/remotes/origin/develop\n");
        expect(yield* asSweep(memoized.resolveDefaultBranchName(repo, "origin"))).toBe("develop");
      }),
    ),
  );

  it.effect("repository state memo: an include it cannot resolve turns the memo off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, memoized, spawned, asSweep, nextTurn } = yield* makeMemoizedDriver;
        runGitSync(repo, ["config", "include.path", "%(prefix)/etc/unknowable.gitconfig"]);
        yield* asSweep(memoized.readConfigValue(repo, "remote.origin.url"));
        yield* nextTurn;
        const before = spawned.length;
        yield* asSweep(memoized.readConfigValue(repo, "remote.origin.url"));
        expect(spawned.length - before).toBe(1);
      }),
    ),
  );
});
