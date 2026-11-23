// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A plain CLI with no Effect runtime; builds a channel AppImage on the build host.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { MESURA_DESKTOP_CHANNEL_IDENTITY } from "../lib/brand-assets.ts";
import {
  CHANNEL_BUILD_LOCK,
  CHANNEL_BUILD_MEMORY,
  CHANNEL_BUILD_WORKLOAD,
  CHANNEL_BUILD_WORKLOAD_NAME,
  CHANNEL_DEPLOY_WORKTREE,
  CHANNEL_SOURCE_REPOSITORY,
  type SideBySideChannel,
  vigiliaChannelState,
} from "./config.ts";
import { run, sha256File, shellCommand } from "./shell.ts";

export interface BuildInput {
  readonly channel: SideBySideChannel;
  readonly revision: string;
  /** The build host's home, where artifacts, logs and the latest-artifact record live. */
  readonly deployHome: string;
  /** Each run packages into its own directory, so a failed build keeps the last good artifact. */
  readonly runId?: string;
}

/** Set by the workload's `flock` wrapper; the executor refuses to run without it. */
export const BUILD_LOCK_HELD_ENV = "MESURA_CHANNEL_BUILD_LOCK_HELD";

export type BuildStep =
  | { readonly kind: "checkout"; readonly revision: string; readonly sourceRepository: string }
  | { readonly kind: "select-node"; readonly versionFile: string }
  | { readonly kind: "install"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "verify-extracted-electron"; readonly packageJson: string }
  | { readonly kind: "package"; readonly args: ReadonlyArray<string>; readonly outputDir: string }
  | { readonly kind: "verify-packed-electron"; readonly executableName: string }
  | {
      readonly kind: "report-artifact";
      readonly fields: ReadonlyArray<"path" | "sha256">;
      readonly record: string;
    };

export interface BuildArtifact {
  readonly channel: SideBySideChannel;
  readonly revision: string;
  readonly commit: string;
  readonly path: string;
  readonly sha256: string;
  readonly electron: string;
  readonly runId: string;
}

export function planBuild(input: BuildInput) {
  const worktree = CHANNEL_DEPLOY_WORKTREE;
  const state = vigiliaChannelState(input.deployHome);
  const outputRoot = state.buildOutput(input.channel);
  const outputDir = NodePath.join(outputRoot, input.runId ?? "next");
  const steps: ReadonlyArray<BuildStep> = [
    { kind: "checkout", revision: input.revision, sourceRepository: CHANNEL_SOURCE_REPOSITORY },
    { kind: "select-node", versionFile: NodePath.join(worktree, ".nvmrc") },
    { kind: "install", args: ["install", "--frozen-lockfile"] },
    {
      kind: "verify-extracted-electron",
      packageJson: NodePath.join(worktree, "apps/desktop/package.json"),
    },
    {
      kind: "package",
      args: [
        NodePath.join("scripts", "build-desktop-artifact.ts"),
        "--platform",
        "linux",
        "--target",
        "AppImage",
        "--arch",
        "x64",
        "--channel",
        input.channel,
        "--output-dir",
        outputDir,
      ],
      outputDir,
    },
    {
      kind: "verify-packed-electron",
      executableName: MESURA_DESKTOP_CHANNEL_IDENTITY[input.channel].executableName,
    },
    {
      kind: "report-artifact",
      fields: ["path", "sha256"],
      record: state.latestArtifact(input.channel),
    },
  ];
  return {
    channel: input.channel,
    revision: input.revision,
    worktree,
    workload: CHANNEL_BUILD_WORKLOAD,
    workloadName: CHANNEL_BUILD_WORKLOAD_NAME,
    lockPath: CHANNEL_BUILD_LOCK,
    log: state.buildLog(input.channel),
    failureRecord: state.lastFailure(input.channel),
    steps,
    outputRoot,
    writePaths: [
      worktree,
      outputRoot,
      state.buildLog(input.channel),
      state.latestArtifact(input.channel),
      state.lastFailure(input.channel),
      CHANNEL_BUILD_LOCK,
    ],
  };
}

export type BuildPlan = ReturnType<typeof planBuild>;

/** Mirrors /opt/dev/deploy/build-dev.sh: the revision's .nvmrc Node and the vite-plus toolchain. */
function toolchainPrefix(nodeVersion: string): string {
  return [
    'source "$HOME/.nvm/nvm.sh" >/dev/null',
    `nvm use ${nodeVersion} >/dev/null`,
    `[ "$(node -v)" = v${nodeVersion} ] || { echo "node $(node -v) is not .nvmrc ${nodeVersion}" >&2; exit 1; }`,
    '. "$HOME/.config/vite-plus/env"',
    'export PATH="$PWD/node_modules/.bin:$PATH"',
  ].join("\n");
}

/** The executor runs only inside its workload unit, under the build lock its wrapper took. */
export function assertInBuildWorkload(
  plan: Pick<BuildPlan, "workloadName">,
  runId: string,
  context: { readonly env: NodeJS.ProcessEnv; readonly cgroup: string } = {
    env: process.env,
    cgroup: NodeFS.readFileSync("/proc/self/cgroup", "utf8"),
  },
) {
  if (
    context.env[BUILD_LOCK_HELD_ENV] !== runId ||
    !context.cgroup.includes(`mesura-workload-${plan.workloadName}.service`)
  ) {
    throw new Error(
      `--in-workload is for the build workload only; run build without it to start one.`,
    );
  }
}

/** Publishes the record with a rename, then drops run directories other than it and the previous one. */
export function publishArtifact(outputRoot: string, record: string, artifact: BuildArtifact) {
  const previous = NodeFS.existsSync(record)
    ? (JSON.parse(NodeFS.readFileSync(record, "utf8")) as BuildArtifact).path
    : undefined;
  NodeFS.mkdirSync(NodePath.dirname(record), { recursive: true });
  NodeFS.writeFileSync(`${record}.tmp`, `${JSON.stringify(artifact, null, 2)}\n`);
  NodeFS.renameSync(`${record}.tmp`, record);
  const keep = new Set(
    [artifact.path, previous].flatMap((path) => (path ? [NodePath.dirname(path)] : [])),
  );
  for (const entry of NodeFS.readdirSync(outputRoot)) {
    const directory = NodePath.join(outputRoot, entry);
    if (!keep.has(directory)) NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

/** The install can leave the host @pnpm/exe artifact in the lockfile, also when it fails. */
export function installWithLockfileRestored(worktree: string, install: () => unknown): void {
  try {
    install();
  } finally {
    run("git", ["-C", worktree, "checkout", "-q", "--", "pnpm-lock.yaml"]);
  }
}

/** Runs the plan's steps in order inside the workload; the lock is held by the caller (`flock`). */
export function executeBuild(plan: BuildPlan, runId: string): BuildArtifact {
  assertInBuildWorkload(plan, runId);
  NodeFS.mkdirSync(NodePath.dirname(plan.log), { recursive: true });
  const logFd = NodeFS.openSync(plan.log, "w");
  const log = (line: string) => NodeFS.writeSync(logFd, `${new Date().toISOString()} ${line}\n`);
  const bash = (script: string, nodeVersion: string) =>
    run("bash", ["-c", `set -eo pipefail\n${toolchainPrefix(nodeVersion)}\n${script}`], {
      cwd: plan.worktree,
      outputFd: logFd,
    });
  const capture = (script: string, nodeVersion: string) =>
    run("bash", ["-c", `set -eo pipefail\n${toolchainPrefix(nodeVersion)}\n${script}`], {
      cwd: plan.worktree,
    }).trim();

  let nodeVersion = "";
  let commit = "";
  let electron = "";
  let appImage = "";
  try {
    log(`build ${plan.channel} from ${plan.revision} (run ${runId})`);
    for (const step of plan.steps) {
      log(`step ${step.kind}`);
      switch (step.kind) {
        case "checkout": {
          run("git", ["-C", step.sourceRepository, "fetch", "-q", "origin"], { outputFd: logFd });
          if (!NodeFS.existsSync(NodePath.join(plan.worktree, ".git"))) {
            run(
              "git",
              ["-C", step.sourceRepository, "worktree", "add", "--detach", plan.worktree, "HEAD"],
              { outputFd: logFd },
            );
          }
          // A previous install can leave the host @pnpm/exe artifact in the lockfile.
          run("git", ["-C", plan.worktree, "checkout", "-q", "--", "pnpm-lock.yaml"]);
          const remoteRef = `origin/${step.revision}^{commit}`;
          const resolve = (ref: string) =>
            run("git", ["-C", plan.worktree, "rev-parse", "--verify", "-q", ref]).trim();
          try {
            commit = resolve(remoteRef);
          } catch {
            commit = resolve(`${step.revision}^{commit}`);
          }
          run("git", ["-C", plan.worktree, "checkout", "-q", "--detach", commit], {
            outputFd: logFd,
          });
          log(`checked out ${commit}`);
          break;
        }
        case "select-node":
          nodeVersion = NodeFS.readFileSync(step.versionFile, "utf8").trim();
          log(`node ${capture("node -v", nodeVersion)}`);
          break;
        case "install":
          installWithLockfileRestored(plan.worktree, () =>
            bash(`pnpm ${shellCommand(step.args)}`, nodeVersion),
          );
          break;
        case "verify-extracted-electron": {
          electron = JSON.parse(NodeFS.readFileSync(step.packageJson, "utf8")).dependencies
            .electron;
          // A truncated Electron archive once passed install silently; check the binary itself.
          const extracted = capture(
            [
              "[ -f apps/desktop/node_modules/electron/dist/version ] || node apps/desktop/node_modules/electron/install.js >&2",
              "apps/desktop/node_modules/.bin/electron --version",
            ].join("\n"),
            nodeVersion,
          ).replace(/^v/u, "");
          if (extracted !== electron) {
            throw new Error(`Extracted Electron ${extracted} is not ${electron}.`);
          }
          log(`extracted electron ${extracted}`);
          break;
        }
        case "package": {
          NodeFS.rmSync(step.outputDir, { recursive: true, force: true });
          NodeFS.mkdirSync(step.outputDir, { recursive: true });
          bash(`node ${shellCommand(step.args)}`, nodeVersion);
          const images = NodeFS.readdirSync(step.outputDir).filter((name) =>
            name.endsWith(".AppImage"),
          );
          if (images.length !== 1) {
            throw new Error(`Expected one AppImage in ${step.outputDir}, found ${images.length}.`);
          }
          appImage = NodePath.join(step.outputDir, images[0] ?? "");
          break;
        }
        case "verify-packed-electron": {
          // electron-builder packs its own Electron download; check the packed one too.
          const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-channel-"));
          try {
            run(appImage, ["--appimage-extract"], { cwd: scratch });
            const packed = run(
              "timeout",
              [
                "30",
                NodePath.join(scratch, "squashfs-root", step.executableName),
                "-p",
                "process.versions.electron",
              ],
              { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
            ).trim();
            if (packed !== electron) {
              throw new Error(`The AppImage packs Electron '${packed}', not ${electron}.`);
            }
            log(`packed electron ${packed}`);
          } finally {
            NodeFS.rmSync(scratch, { recursive: true, force: true });
          }
          break;
        }
        case "report-artifact": {
          const artifact: BuildArtifact = {
            channel: plan.channel,
            revision: plan.revision,
            commit,
            path: appImage,
            sha256: sha256File(appImage),
            electron,
            runId,
          };
          publishArtifact(plan.outputRoot, step.record, artifact);
          log(`AppImage ${artifact.path}`);
          log(`sha256 ${artifact.sha256}`);
          return artifact;
        }
      }
    }
    throw new Error("The build plan has no report-artifact step.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED ${message}`);
    NodeFS.mkdirSync(NodePath.dirname(plan.failureRecord), { recursive: true });
    NodeFS.writeFileSync(
      plan.failureRecord,
      `${JSON.stringify({ runId, revision: plan.revision, log: plan.log, error: message }, null, 2)}\n`,
    );
    throw error;
  } finally {
    NodeFS.closeSync(logFd);
  }
}

export function readLatestArtifact(
  deployHome: string,
  channel: SideBySideChannel,
): BuildArtifact | undefined {
  const record = vigiliaChannelState(deployHome).latestArtifact(channel);
  if (!NodeFS.existsSync(record)) return undefined;
  return JSON.parse(NodeFS.readFileSync(record, "utf8")) as BuildArtifact;
}

/**
 * Starts the build as its own workload under the build lock and follows its log until it ends.
 * The box's memory rules keep builds out of an agent's session scope and one at a time.
 */
export async function buildInWorkload(input: BuildInput): Promise<BuildArtifact> {
  const plan = planBuild(input);
  const runId = `${Date.now()}-${process.pid}`;
  const unit = `mesura-workload-${plan.workloadName}`;
  run(
    plan.workload,
    [
      plan.workloadName,
      "--memory",
      CHANNEL_BUILD_MEMORY,
      "--",
      "flock",
      "-w",
      "3600",
      plan.lockPath,
      "env",
      `${BUILD_LOCK_HELD_ENV}=${runId}`,
      process.execPath,
      NodePath.join(import.meta.dirname, "channel.ts"),
      "build",
      "--channel",
      input.channel,
      "--rev",
      input.revision,
      "--in-workload",
      "--run-id",
      runId,
    ],
    { outputFd: process.stderr.fd },
  );
  process.stderr.write(`Following ${plan.log}\n`);

  let offset = 0;
  const follow = () => {
    if (!NodeFS.existsSync(plan.log)) return;
    const content = NodeFS.readFileSync(plan.log);
    // The workload truncates the log when it starts; restart from the top then.
    if (content.length < offset) offset = 0;
    process.stderr.write(content.subarray(offset));
    offset = content.length;
  };
  const isActive = () => {
    try {
      run("systemctl", ["--user", "is-active", "--quiet", unit]);
      return true;
    } catch {
      return false;
    }
  };
  while (isActive()) {
    follow();
    await NodeTimersPromises.setTimeout(2_000);
  }
  follow();

  const artifact = readLatestArtifact(input.deployHome, input.channel);
  if (artifact?.runId !== runId) {
    throw new Error(
      `The ${input.channel} build did not finish; see ${plan.log} and journalctl --user -u ${unit}.`,
    );
  }
  return artifact;
}
