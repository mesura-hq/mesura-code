// @effect-diagnostics nodeBuiltinImport:off - Copies a channel build and its launcher to the laptop.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { BuildArtifact } from "./build.ts";
import { laptopChannelPaths, type SideBySideChannel } from "./config.ts";
import { run, runRemote, shellQuote } from "./shell.ts";

export const LAUNCHER_TEMPLATE = new URL("./launcher.sh", import.meta.url);
export const LAUNCHER_CHANNEL_TOKEN = "@CHANNEL@";

export interface StageInput {
  readonly channel: SideBySideChannel;
  readonly appImagePath: string;
  readonly sha256: string;
  readonly laptopHome: string;
  readonly laptopTarget: string;
  /** Names this transfer's temporary copy, so two overlapping stages never share one file. */
  readonly transferId?: string;
}

export function planStage(input: StageInput) {
  const paths = laptopChannelPaths(input.laptopHome, input.channel);
  const transferId = input.transferId ?? NodeCrypto.randomBytes(6).toString("hex");
  const incoming = `${paths.nextAppImage}.incoming-${transferId}`;
  return {
    channel: input.channel,
    target: input.laptopTarget,
    appImage: { source: input.appImagePath, incoming, destination: paths.nextAppImage },
    launcher: { channel: input.channel, destination: paths.launcher },
    verify: { target: input.laptopTarget, path: paths.nextAppImage, sha256: input.sha256 },
    channelLock: paths.channelLock,
    writePaths: [incoming, paths.nextAppImage, paths.launcher, paths.channelLock],
  };
}

export type StagePlan = ReturnType<typeof planStage>;

export function renderLauncher(channel: SideBySideChannel): string {
  return NodeFS.readFileSync(LAUNCHER_TEMPLATE, "utf8").replaceAll(LAUNCHER_CHANNEL_TOKEN, channel);
}

/**
 * Copies the AppImage under this transfer's own temporary name, then, under the channel lock in one
 * remote step, checks its hash and renames it to the staged `.next` name, so the launcher never
 * activates a partial copy and an overlapping stage cannot swap the file between check and rename.
 */
export function executeStage(plan: StagePlan): void {
  const imageBytes = NodeFS.statSync(plan.appImage.source).size;
  const applications = NodePath.dirname(plan.appImage.destination);
  const incoming = shellQuote(plan.appImage.incoming);
  runRemote(
    plan.target,
    [
      `mkdir -p ${shellQuote(applications)} ${shellQuote(NodePath.dirname(plan.launcher.destination))}`,
      `free_kb=$(df -Pk ${shellQuote(applications)} | awk 'NR == 2 {print $4}')`,
      `need_kb=${Math.ceil((imageBytes * 2) / 1024)}`,
      `[ "$free_kb" -gt "$need_kb" ] || { echo "$free_kb KB free in ${applications}, need $need_kb KB; nothing staged" >&2; exit 1; }`,
    ].join("\n"),
  );
  let staged: string;
  try {
    run(
      "rsync",
      ["-t", "--partial", plan.appImage.source, `${plan.target}:${plan.appImage.incoming}`],
      {
        outputFd: process.stderr.fd,
      },
    );
    // The launcher and the Lab reset take the same lock before they read `.next`.
    staged = runRemote(
      plan.target,
      [
        `mkdir -p ${shellQuote(NodePath.dirname(plan.channelLock))}`,
        `exec 9>${shellQuote(plan.channelLock)}`,
        "flock -w 900 9",
        `copied=$(sha256sum ${incoming} | cut -d' ' -f1)`,
        `[ "$copied" = ${shellQuote(plan.verify.sha256)} ] || { echo "The copy at ${plan.appImage.incoming} hashes to $copied, not ${plan.verify.sha256}." >&2; exit 1; }`,
        `chmod +x ${incoming}`,
        `mv -f ${incoming} ${shellQuote(plan.appImage.destination)}`,
        `sha256sum ${shellQuote(plan.verify.path)} | cut -d' ' -f1`,
      ].join("\n"),
    ).trim();
  } catch (error) {
    try {
      runRemote(plan.target, `rm -f ${incoming}`);
    } catch {
      // An unreachable laptop keeps the partial copy; the next transfer uses a new name.
    }
    throw error;
  }
  if (staged !== plan.verify.sha256) {
    throw new Error(`${plan.verify.path} hashes to ${staged}, not ${plan.verify.sha256}.`);
  }

  using scratch = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "mesura-channel-launcher-"),
  );
  const launcher = NodePath.join(scratch.path, `mesura-code-${plan.channel}`);
  NodeFS.writeFileSync(launcher, renderLauncher(plan.channel), { mode: 0o755 });
  run("rsync", ["-t", "--chmod=F755", launcher, `${plan.target}:${plan.launcher.destination}`]);
  process.stdout.write(
    `Staged ${plan.appImage.destination} (sha256 ${staged}) and ${plan.launcher.destination} on ${plan.target}.\n`,
  );
}

/** Stages one build of its channel on the laptop; `stage`, `lab` and `follow-dev` all come here. */
export function stageBuildArtifact(
  artifact: BuildArtifact,
  laptop: { readonly target: string; readonly home: string },
): void {
  executeStage(
    planStage({
      channel: artifact.channel,
      appImagePath: artifact.path,
      sha256: artifact.sha256,
      laptopHome: laptop.home,
      laptopTarget: laptop.target,
    }),
  );
}
