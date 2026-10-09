/**
 * Provider probes carry `MESURA_PROVIDER_PROBE=1`; provider sessions never do,
 * even when the server's own or an instance's environment already has it.
 *
 * A host can wrap the provider CLIs to confine what the server spawns, and
 * exempt a process whose environment has exactly `MESURA_PROVIDER_PROBE=1`
 * (see `providerProbeMarker.ts`). These tests pin that contract from the
 * server's side: they spawn recording fakes
 * (`testFixtures/*SpawnEnvironmentPeer.mjs`) through the real spawn paths and
 * read back the environment each child saw.
 *
 * Entry points: `checkCodexProviderStatus`, `probeCodexSkillsForCwd`,
 * `readCodexAccountLimits`, `CodexDriver.create(...).consumeResetCredit`,
 * `probeClaudeCapabilities`, `readClaudeAccountLimits` (probes), and
 * `makeCodexSessionRuntime(...).start`, `makeClaudeAdapter(...).startSession`
 * (sessions).
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  probeClaudeCapabilities,
  readClaudeAccountLimits,
} from "./ClaudeProvider.ts";
import { layerTest as codexResetCreditLayerTest } from "./codexResetCredit.ts";
import {
  checkCodexProviderStatus,
  probeCodexSkillsForCwd,
  readCodexAccountLimits,
} from "./CodexProvider.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

// The fakes are `#!/usr/bin/env node` scripts, which Windows cannot execute.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const fixturesDirectory = NodePath.join(import.meta.dirname, "../testFixtures");
const codexPeerPath = NodePath.join(fixturesDirectory, "codexSpawnEnvironmentPeer.mjs");
const claudePeerPath = NodePath.join(fixturesDirectory, "claudeSpawnEnvironmentPeer.mjs");

const SPAWN_ENVIRONMENT_LOG_VARIABLE = "T3_SPAWN_ENVIRONMENT_LOG";

type SpawnEnvironmentRecord =
  | {
      readonly kind: "spawn";
      readonly pid: number;
      readonly argv: ReadonlyArray<string>;
      readonly providerProbeMarker: string | null;
    }
  | { readonly kind: "request"; readonly pid: number; readonly method: string };

/**
 * A scoped log file the fakes append one record to per spawn, plus an
 * environment that points them at it. The ambient marker is stripped so a test
 * runner started from a marked shell cannot make a session look marked.
 */
const makeSpawnEnvironmentLog = Effect.gen(function* () {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-probe-marker-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const logPath = NodePath.join(directory, "spawns.ndjson");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [SPAWN_ENVIRONMENT_LOG_VARIABLE]: logPath,
  };
  delete environment.MESURA_PROVIDER_PROBE;
  const read = (): ReadonlyArray<SpawnEnvironmentRecord> =>
    NodeFS.existsSync(logPath)
      ? NodeFS.readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as SpawnEnvironmentRecord)
      : [];
  return { directory, logPath, environment, read };
});

/** The marker each spawned child saw, in spawn order. */
const markersOf = (records: ReadonlyArray<SpawnEnvironmentRecord>) =>
  records.flatMap((record) => (record.kind === "spawn" ? [record.providerProbeMarker] : []));

/** The marker seen by the one child that answered `method`. */
const markerOfSpawnServing = (records: ReadonlyArray<SpawnEnvironmentRecord>, method: string) => {
  const servingPids = records.flatMap((record) =>
    record.kind === "request" && record.method === method ? [record.pid] : [],
  );
  assert.equal(servingPids.length, 1, `exactly one spawn should serve ${method}`);
  return markersOf(records.filter((record) => record.pid === servingPids[0]))[0];
};

/**
 * Sets `variables` on `process.env` for the enclosing scope and restores the
 * previous values, absent ones included, when the scope closes.
 */
const withProcessEnvironment = (variables: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.keys(variables).map((name) => [name, process.env[name]] as const);
      Object.assign(process.env, variables);
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );

/**
 * Starts a Codex session on the recording fake and closes it again. `close`
 * closes the scope the runtime was built in, so it gets its own rather than
 * the caller's, which owns the spawn log.
 */
const runCodexSession = (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv | undefined;
}) =>
  Effect.gen(function* () {
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("thread-probe-marker-codex-session"),
      binaryPath: codexPeerPath,
      cwd: input.cwd,
      runtimeMode: "full-access",
      ...(input.environment ? { environment: input.environment } : {}),
    });
    yield* runtime.start();
    yield* runtime.close;
  }).pipe(Effect.scoped);

/**
 * Starts a Claude session on the recording fake, waits until the fake's
 * CLI-side `system/init` arrives, and stops the session. The fake writes that
 * message only after its spawn record is on disk, so the event is the proof
 * the record exists.
 */
const runClaudeSession = (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv | undefined;
}) =>
  Effect.gen(function* () {
    const adapter = yield* makeClaudeAdapter(
      decodeClaudeSettings({ binaryPath: claudePeerPath }),
      input.environment ? { environment: input.environment } : {},
    );
    const threadId = ThreadId.make("thread-probe-marker-claude-session");
    const cliInitialized = yield* adapter.streamEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "session.configured" &&
          (event.payload.config as { readonly peer?: unknown }).peer ===
            "claudeSpawnEnvironmentPeer",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      cwd: input.cwd,
      runtimeMode: "full-access",
    });
    yield* Fiber.join(cliInitialized);
    yield* adapter.stopSession(threadId);
  });

const codexDriverLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-probe-marker-codex-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(codexResetCreditLayerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("The probe-marker tests make no HTTP request")),
    ),
  ),
);

describe("provider probe marker", () => {
  it.layer(NodeServices.layer)("Codex probes", (it) => {
    it.effect.skipIf(windowsHost)(
      "probe marker: the Codex status probe spawns app-server with MESURA_PROVIDER_PROBE=1",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          const provider = yield* checkCodexProviderStatus(
            decodeCodexSettings({ binaryPath: codexPeerPath }),
            undefined,
            log.environment,
          );
          assert.equal(provider.status, "ready");
          assert.deepEqual(markersOf(log.read()), ["1"]);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "probe marker: the Codex skills probe spawns app-server with MESURA_PROVIDER_PROBE=1",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          yield* probeCodexSkillsForCwd({
            binaryPath: codexPeerPath,
            cwd: log.directory,
            environment: log.environment,
          }).pipe(Effect.scoped);
          assert.deepEqual(markersOf(log.read()), ["1"]);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "probe marker: the Codex account-limit read spawns app-server with MESURA_PROVIDER_PROBE=1",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          yield* readCodexAccountLimits({
            binaryPath: codexPeerPath,
            cwd: log.directory,
            environment: log.environment,
          });
          assert.deepEqual(markersOf(log.read()), ["1"]);
        }).pipe(Effect.scoped),
    );
  });

  it.layer(codexDriverLayer)("Codex reset-credit probe", (it) => {
    // Live clock: the driver confirms a redemption by seeing the re-probe's
    // `checkedAt` move, which a frozen TestClock never lets it do.
    it.effect.skipIf(windowsHost)(
      "probe marker: Codex reset-credit redemption spawns app-server with MESURA_PROVIDER_PROBE=1",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          const instance = yield* CodexDriver.create({
            instanceId: ProviderInstanceId.make("codex-probe-marker"),
            displayName: "Codex probe marker",
            // Enabled, because a redemption re-probes the status afterwards to
            // confirm the new limits; that re-probe is a probe spawn as well.
            enabled: true,
            environment: [
              {
                name: SPAWN_ENVIRONMENT_LOG_VARIABLE,
                value: log.logPath,
                sensitive: false,
              },
            ],
            config: { ...CodexDriver.defaultConfig(), binaryPath: codexPeerPath },
          });
          const consumeResetCredit = instance.consumeResetCredit;
          assert.isDefined(consumeResetCredit);
          const outcome = yield* consumeResetCredit!();
          assert.equal(outcome, "nothingToReset");
          const records = log.read();
          assert.equal(markerOfSpawnServing(records, "account/rateLimitResetCredit/consume"), "1");
          // Every other spawn here is the status probe confirming the new limits.
          assert.deepEqual(
            markersOf(records).filter((marker) => marker !== "1"),
            [],
          );
        }).pipe(Effect.scoped, TestClock.withLive),
    );
  });

  it.layer(NodeServices.layer)("Claude probes", (it) => {
    it.effect.skipIf(windowsHost)(
      "probe marker: the Claude capability probe spawns claude with MESURA_PROVIDER_PROBE=1",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          const capabilities = yield* probeClaudeCapabilities(
            decodeClaudeSettings({ binaryPath: claudePeerPath }),
            log.environment,
            log.directory,
          );
          assert.equal(capabilities?.email, "dev@example.com");
          assert.deepEqual(markersOf(log.read()), ["1"]);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "probe marker: the Claude account-limit read spawns claude with MESURA_PROVIDER_PROBE=1",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          const read = yield* readClaudeAccountLimits(
            decodeClaudeSettings({ binaryPath: claudePeerPath }),
            log.environment,
            log.directory,
          );
          assert.equal(read.account?.label, "dev@example.com");
          assert.deepEqual(markersOf(log.read()), ["1"]);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "probe marker: the Claude status check spawns claude --version with MESURA_PROVIDER_PROBE=1",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          // No capability resolver: the only spawn left is the CLI version check.
          const provider = yield* checkClaudeProviderStatus(
            decodeClaudeSettings({ binaryPath: claudePeerPath }),
            undefined,
            log.environment,
            log.directory,
          );
          assert.equal(provider.version, "2.1.0");
          const records = log.read();
          assert.deepEqual(
            records.flatMap((record) => (record.kind === "spawn" ? [record.argv] : [])),
            [["--version"]],
          );
          assert.deepEqual(markersOf(records), ["1"]);
        }).pipe(Effect.scoped),
    );
  });
});

describe("provider session spawns stay unmarked", () => {
  it.layer(NodeServices.layer)("Codex session", (it) => {
    it.effect.skipIf(windowsHost)(
      "session guard: a Codex session spawned after a probe on the same environment carries no MESURA_PROVIDER_PROBE",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          // Probe first, on the very object the session receives next: the
          // driver hands `process.env` itself to both, so a probe that wrote
          // its marker into the shared object would mark every later session.
          yield* probeCodexSkillsForCwd({
            binaryPath: codexPeerPath,
            cwd: log.directory,
            environment: log.environment,
          }).pipe(Effect.scoped);
          yield* runCodexSession({ cwd: log.directory, environment: log.environment });

          const records = log.read();
          assert.equal(markersOf(records).length, 2);
          assert.equal(markerOfSpawnServing(records, "thread/start"), null);
          assert.equal(log.environment.MESURA_PROVIDER_PROBE, undefined);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "session strip: a Codex session whose environment and process.env both preset MESURA_PROVIDER_PROBE=1 spawns unmarked",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          yield* withProcessEnvironment({ MESURA_PROVIDER_PROBE: "1" });
          yield* runCodexSession({
            cwd: log.directory,
            environment: { ...log.environment, MESURA_PROVIDER_PROBE: "1" },
          });
          assert.equal(markerOfSpawnServing(log.read(), "thread/start"), null);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "session strip: a Codex session inheriting MESURA_PROVIDER_PROBE=1 from process.env spawns unmarked",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          // No session environment: the spawner extends `process.env` itself.
          yield* withProcessEnvironment({
            MESURA_PROVIDER_PROBE: "1",
            [SPAWN_ENVIRONMENT_LOG_VARIABLE]: log.logPath,
          });
          yield* runCodexSession({ cwd: log.directory, environment: undefined });
          assert.equal(markerOfSpawnServing(log.read(), "thread/start"), null);
        }).pipe(Effect.scoped),
    );
  });

  it.layer(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-probe-marker-claude-adapter-" }).pipe(
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
  )("Claude session", (it) => {
    it.effect.skipIf(windowsHost)(
      "session guard: a Claude session spawned after a probe on the same environment carries no MESURA_PROVIDER_PROBE",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          const claudeSettings = decodeClaudeSettings({ binaryPath: claudePeerPath });
          yield* probeClaudeCapabilities(claudeSettings, log.environment, log.directory);

          yield* runClaudeSession({ cwd: log.directory, environment: log.environment });

          const markers = markersOf(log.read());
          assert.equal(markers.length, 2);
          assert.equal(markers[1], null);
          assert.equal(log.environment.MESURA_PROVIDER_PROBE, undefined);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "session strip: a Claude session whose environment and process.env both preset MESURA_PROVIDER_PROBE=1 spawns unmarked",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          yield* withProcessEnvironment({ MESURA_PROVIDER_PROBE: "1" });
          yield* runClaudeSession({
            cwd: log.directory,
            environment: { ...log.environment, MESURA_PROVIDER_PROBE: "1" },
          });
          assert.deepEqual(markersOf(log.read()), [null]);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "session strip: a Claude session inheriting MESURA_PROVIDER_PROBE=1 from process.env spawns unmarked",
      () =>
        Effect.gen(function* () {
          const log = yield* makeSpawnEnvironmentLog;
          // No adapter environment: the Claude environment starts from `process.env`.
          yield* withProcessEnvironment({
            MESURA_PROVIDER_PROBE: "1",
            [SPAWN_ENVIRONMENT_LOG_VARIABLE]: log.logPath,
          });
          yield* runClaudeSession({ cwd: log.directory, environment: undefined });
          assert.deepEqual(markersOf(log.read()), [null]);
        }).pipe(Effect.scoped),
    );
  });
});
