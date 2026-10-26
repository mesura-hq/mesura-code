// @effect-diagnostics nodeBuiltinImport:off
/**
 * A GitManager over real git whose every spawned process goes through one counting spawner, so
 * `spawned` lists them in order. The source control registry is the server's real one: without
 * `listChangeRequests` no provider is registered, as in production; with it, a GitHub provider
 * answers github.com lookups. No test reaches a real hosting provider.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderKind } from "@t3tools/contracts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSourceControlHost from "../sourceControl/ServerSourceControlHost.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";

export interface SpawnedProcess {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const makeGitManagerOverRealGit = (options?: {
  readonly listChangeRequests?: SourceControlProvider["Service"]["listChangeRequests"];
}): Effect.Effect<
  {
    readonly manager: GitManager.GitManager["Service"];
    readonly repositoryIdentities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"];
    /** The counting git driver the manager reads through. */
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
    readonly spawned: ReadonlyArray<SpawnedProcess>;
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const spawned: Array<SpawnedProcess> = [];
    const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
      Effect.provide(NodeServices.layer),
    );
    const countingSpawner = ChildProcessSpawner.make((command) => {
      spawned.push(
        command._tag === "StandardCommand"
          ? { command: command.command, args: command.args }
          : { command: "<piped>", args: [] },
      );
      return realSpawner.spawn(command);
    });

    const layerProcesses = Layer.mergeAll(
      ProcessRunner.layer,
      Layer.effect(VcsProcess.VcsProcess, VcsProcess.make).pipe(Layer.provide(ProcessRunner.layer)),
    );
    const layerGit = Layer.mergeAll(GitVcsDriver.layer, VcsDriverRegistry.layer).pipe(
      Layer.provideMerge(layerProcesses),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-testkit-" })),
      Layer.provideMerge(ServerSettings.layerTest()),
    );
    const listChangeRequests = options?.listChangeRequests;
    const layerSourceControl = Layer.effect(
      SourceControlProviderRegistry.SourceControlProviderRegistry,
      listChangeRequests === undefined
        ? SourceControlProviderRegistry.makeWithProviders([])
        : Effect.gen(function* () {
            // The unregistered GitHub provider fails every call; only lookups answer.
            const unregistered = yield* (yield* SourceControlProviderRegistry.makeWithProviders(
              [],
            )).get(SourceControlProviderKind.make("github"));
            return yield* SourceControlProviderRegistry.makeWithProviders([
              {
                kind: SourceControlProviderKind.make("github"),
                provider: { ...unregistered, listChangeRequests },
                discovery: {
                  kind: SourceControlProviderKind.make("github"),
                  label: "GitHub",
                  installHint: "",
                  type: "api",
                  probeAuth: Effect.succeed({
                    status: "authenticated",
                    account: Option.none(),
                    host: Option.none(),
                    detail: Option.none(),
                  }),
                },
              },
            ]);
          }).pipe(Effect.orDie),
    ).pipe(Layer.provide(ServerSourceControlHost.layer));
    const layerManager = Layer.mergeAll(
      Layer.effect(GitManager.GitManager, GitManager.make),
      Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make(),
      ),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(TextGeneration.TextGeneration)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
            runForThread: () => Effect.succeed({ status: "no-script" as const }),
          }),
          Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
            Layer.provide(SqlitePersistence.layerMemory),
          ),
        ),
      ),
      Layer.provideMerge(layerSourceControl),
      Layer.provideMerge(layerGit),
      // The counting spawner is provided before NodeServices, so every layer
      // above that spawns gets it instead of the platform's.
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, countingSpawner)),
      Layer.provide(NodeServices.layer),
    );
    const context = yield* Layer.build(layerManager).pipe(Effect.orDie);
    return {
      manager: Context.get(context, GitManager.GitManager),
      repositoryIdentities: Context.get(
        context,
        RepositoryIdentityResolver.RepositoryIdentityResolver,
      ),
      git: Context.get(context, GitVcsDriver.GitVcsDriver),
      spawned,
    };
  });

/** Runs git synchronously, outside any counting spawner, for fixture setup and edits. */
export const runGitSync = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

/**
 * A repository whose only remote is `origin` at `remoteUrl`, with one branch per name tracking an
 * existing `origin/<name>` ref (as after `git push -u`), so a pull-request lookup reaches the
 * provider. Built with plain git outside the counting spawner; it never contacts the remote.
 */
export const makeTrackedBranchesRepository = (input: {
  readonly remoteUrl: string | null;
  readonly branches: ReadonlyArray<string>;
  readonly checkout?: string;
}): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-testkit-repo-"))),
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  ).pipe(
    Effect.map((root) => {
      const repo = NodePath.join(root, "repo");
      NodeFS.mkdirSync(repo, { recursive: true });
      runGitSync(repo, ["init", "--quiet", "--initial-branch=main"]);
      runGitSync(repo, ["config", "user.email", "test@example.com"]);
      runGitSync(repo, ["config", "user.name", "Test User"]);
      NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "fixture\n");
      runGitSync(repo, ["add", "README.md"]);
      runGitSync(repo, ["commit", "--quiet", "-m", "Initial commit"]);
      if (input.remoteUrl === null) return repo;
      runGitSync(repo, ["remote", "add", "origin", input.remoteUrl]);
      runGitSync(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      runGitSync(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      for (const branch of input.branches) {
        runGitSync(repo, ["branch", branch]);
        runGitSync(repo, ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
        runGitSync(repo, ["config", `branch.${branch}.remote`, "origin"]);
        runGitSync(repo, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
      }
      if (input.checkout !== undefined) runGitSync(repo, ["checkout", "--quiet", input.checkout]);
      return repo;
    }),
  );
