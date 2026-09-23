import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import { PUBLISHED_RELEASE_BASE_URL } from "@t3tools/shared/stateHome";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);

/**
 * What update path this server can honour, or `null` when it can only be
 * replaced by hand.
 *
 * This is the only gate. Every caller must ask here rather than re-deriving the
 * answer from `mode` and `launcher.managed`, because the fork adds a condition
 * that has nothing to do with either: a `boot-service` update installs the
 * server from a published release archive, and the fork publishes none. While
 * `PUBLISHED_RELEASE_BASE_URL` is null that download resolves *upstream's*
 * release server, so accepting an update would swap this server for a different product —
 * one that does not implement the fork's own RPC methods — and would report
 * success while doing it. Advertise nothing rather than a capability the fork
 * cannot honour; the client then shows manual guidance instead of a button.
 */
export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
  /** Defaults to the fork's real answer; tests pass an origin to exercise the machinery. */
  readonly publishedReleaseBaseUrl?: string | null;
}): ServerSelfUpdateCapability | null {
  // Check for `undefined`, not falsiness. `??` would treat an explicit null as
  // "not supplied" and fall back to the constant, while `make` below uses a
  // destructuring default that only fires on `undefined`. Once the constant is
  // a real name the two hops would disagree, and this resolver would advertise
  // `boot-service` for a service whose own failure message says there is no
  // package to install.
  const publishedReleaseBaseUrl =
    input.publishedReleaseBaseUrl === undefined
      ? PUBLISHED_RELEASE_BASE_URL
      : input.publishedReleaseBaseUrl;
  if (input.desktopManaged) return "desktop-managed" as const;
  if (publishedReleaseBaseUrl === null) return null;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const withRunningThreadContinuation = Effect.fn(
  "cloud.server_self_update.withRunningThreadContinuation",
)(function* (input: {
  readonly mode: ServerConfig.RuntimeMode;
  readonly selfUpdate: ServerSelfUpdate["Service"];
  readonly prepare: Effect.Effect<ReadonlyArray<ThreadId>, ServerSelfUpdateError>;
  readonly clear: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<void, ServerSelfUpdateError>;
}) {
  const desktopContinuationTokens = yield* Ref.make(HashSet.empty<string>());
  const clearOnError = <A>(
    effect: Effect.Effect<A, ServerSelfUpdateError>,
    threadIds: () => ReadonlyArray<ThreadId>,
    handoffAccepted: () => boolean,
  ): Effect.Effect<A, ServerSelfUpdateError> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        (handoffAccepted() && Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : input.clear(threadIds())
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );

  const update: ServerSelfUpdate["Service"]["update"] = (
    request,
    reportProgress = () => Effect.void,
  ) => {
    let prepared = false;
    let handoffAccepted = false;
    let continuationThreadIds: ReadonlyArray<ThreadId> = [];
    return clearOnError(
      input.selfUpdate
        .update(
          request,
          (stage) =>
            (request.continueRunningThreads === true &&
            input.mode !== "desktop" &&
            stage === "installing" &&
            !prepared
              ? input.prepare.pipe(
                  Effect.tap((threadIds) =>
                    Effect.sync(() => {
                      prepared = true;
                      continuationThreadIds = threadIds;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void
            ).pipe(Effect.andThen(reportProgress(stage))),
          () =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
        )
        .pipe(
          Effect.tap((result) => {
            if (
              result.method === "desktop-app" &&
              result.desktopUpdateToken !== undefined &&
              request.continueRunningThreads === true
            ) {
              return Ref.update(desktopContinuationTokens, HashSet.add(result.desktopUpdateToken));
            }
            return Effect.void;
          }),
        ),
      () => continuationThreadIds,
      () => handoffAccepted,
    );
  };

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId) =>
      Effect.gen(function* () {
        const shouldContinue = yield* Ref.modify(desktopContinuationTokens, (tokens) => [
          HashSet.has(tokens, requestId),
          HashSet.remove(tokens, requestId),
        ]);
        let handoffAccepted = false;
        let continuationThreadIds: ReadonlyArray<ThreadId> = [];
        return yield* clearOnError(
          Effect.gen(function* () {
            continuationThreadIds = shouldContinue ? yield* input.prepare : [];
            return yield* input.selfUpdate.commitDesktopUpdate(requestId, () =>
              Effect.sync(() => {
                handoffAccepted = true;
              }),
            );
          }),
          () => continuationThreadIds,
          () => handoffAccepted,
        ).pipe(
          Effect.catchCause((cause) =>
            (shouldContinue && !handoffAccepted
              ? Ref.update(desktopContinuationTokens, HashSet.add(requestId))
              : Effect.void
            ).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      }),
  });
});

export const make = Effect.fn("cloud.server_self_update.make")(function* ({
  publishedReleaseBaseUrl = PUBLISHED_RELEASE_BASE_URL,
}: {
  /**
   * Which origin a release-archive update would install from. Production takes
   * the default, which is the fork's real answer: none. Tests pass an origin so
   * the staging, preflight and single-flight machinery stays covered — the fork
   * disabled that path, it did not delete it, and an upstream merge has to keep
   * finding it here.
   */
  readonly publishedReleaseBaseUrl?: string | null;
} = {}) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  // Archive-distributed targets download from GitHub Releases. The client is
  // optional so callers without one (tests, npm-only hosts) still construct.
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.string(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const inFlight = yield* Ref.make(false);

  // Ask the gate above rather than re-deriving the answer here. This branch
  // used to duplicate the resolver's logic, so the descriptor a client reads
  // and the check this service enforces could disagree — and did, the moment
  // the fork added the unpublished-package condition to only one of them.
  // A configured mirror is an origin this server may install from, so it counts
  // here too — otherwise `T3CODE_RELEASE_BASE_URL` would be honoured by the
  // installer and ignored by the capability a client reads.
  const installOrigin = releaseBaseUrl ?? publishedReleaseBaseUrl;
  const capability = resolveServerSelfUpdateCapability({
    desktopManaged: serverConfig.mode === "desktop",
    launcherManaged: launcher.managed,
    publishedReleaseBaseUrl: installOrigin,
  });
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void, onHandoffAccepted = () => Effect.void) {
    if (capability === "desktop-managed") {
      // input.targetVersion is meaningless here: the desktop app's own
      // update feed decides what it downloads, and the result carries what
      // it actually got.
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(reportProgress);
      }
      return yield* failWith(
        "This server is managed by the Mesura Code desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      // The capability above already decided; this only selects the wording.
      return yield* failWith(
        installOrigin === null
          ? "This Mesura Code server cannot update itself, because Mesura Code publishes no release archive to update from. Build the server and install it on the server machine by hand."
          : "Remote updates require the Mesura Code background service. Run `t3 service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    // `capability !== null` above already proves this, but the compiler cannot
    // see it and the install must never guess an origin — the one it would
    // otherwise resolve is upstream's release server.
    if (installOrigin === null) {
      return yield* failWith("Mesura Code publishes no release archive to install an update from.");
    }

    return yield* Effect.gen(function* () {
      yield* reportProgress("downloading");
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        httpClient,
        platform,
        arch,
        releaseBaseUrl: installOrigin,
        validate: (runtime) =>
          runner
            .run({
              command: pinnedRuntimeCommand(runtime).command,
              args: [
                ...pinnedRuntimeCommand(runtime).args,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : failWith(`Could not prepare t3@${targetVersion}.`, error),
        ),
      );

      yield* reportProgress("installing");
      const updateId = yield* Effect.uninterruptible(
        launcher.requestUpdate({ targetVersion, dbPath: serverConfig.dbPath }).pipe(
          Effect.mapError((error) =>
            failWith(
              error._tag === "ServiceLauncherRejectedError"
                ? error.reason
                : "Could not ask the service launcher to activate the prepared update.",
              error,
            ),
          ),
          Effect.tap(() => onHandoffAccepted()),
        ),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId, onHandoffAccepted) =>
      desktopAppUpdate.commit(requestId, onHandoffAccepted),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
