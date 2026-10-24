/**
 * Provider probes carry `MESURA_PROVIDER_PROBE=1`; provider sessions never do,
 * even when the server's own or an instance's environment already has it.
 *
 * A host can wrap the provider CLIs to confine what the server spawns, and
 * exempt a process whose environment has exactly `MESURA_PROVIDER_PROBE=1`
 * (see `providerProbeMarker.ts`). These tests pin that contract from the
 * server's side: they spawn recording fakes
 * (`testFixtures/*SpawnEnvironmentPeer.mjs`) through the real probe paths and
 * read back the environment each child saw.
 *
 * Entry points: `checkCodexProviderStatus`, `probeCodexSkillsForCwd`,
 * `readCodexAccountLimits`, `probeClaudeCapabilities`, `readClaudeAccountLimits`,
 * `checkClaudeProviderStatus`. Sessions spawn from the orchestration-v2
 * adapters, which strip the marker with `withoutProviderProbeMarker`; the
 * helper specs below pin what that strip guarantees.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  checkClaudeProviderStatus,
  probeClaudeCapabilities,
  readClaudeAccountLimits,
} from "./ClaudeProvider.ts";
import {
  checkCodexProviderStatus,
  probeCodexSkillsForCwd,
  readCodexAccountLimits,
} from "./CodexProvider.ts";
import {
  PROVIDER_PROBE_MARKER_ENVIRONMENT,
  withoutProviderProbeMarker,
  withProviderProbeMarker,
} from "./providerProbeMarker.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

// The fakes are `#!/usr/bin/env node` scripts, which Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const fixturesDirectory = NodePath.join(import.meta.dirname, "testFixtures");
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
  it("withProviderProbeMarker returns a new environment and never writes into its input", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const marked = withProviderProbeMarker(environment);
    assert.deepEqual(marked, { PATH: "/usr/bin", ...PROVIDER_PROBE_MARKER_ENVIRONMENT });
    assert.isUndefined(environment.MESURA_PROVIDER_PROBE);
  });

  it("withoutProviderProbeMarker keeps the key as undefined, which outranks an inherited value", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin", MESURA_PROVIDER_PROBE: "1" };
    const stripped = withoutProviderProbeMarker(environment);
    assert.isTrue(Object.hasOwn(stripped, "MESURA_PROVIDER_PROBE"));
    assert.isUndefined(stripped.MESURA_PROVIDER_PROBE);
    // Spread over an inherited environment, as `extendEnv` does, the strip wins.
    assert.isUndefined({ ...environment, ...stripped }.MESURA_PROVIDER_PROBE);
    assert.equal(environment.MESURA_PROVIDER_PROBE, "1");
  });
});
