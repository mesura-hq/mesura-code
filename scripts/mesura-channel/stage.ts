// @effect-diagnostics nodeBuiltinImport:off - Copies a channel build and its launcher to the laptop.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
}

export function planStage(input: StageInput) {
  const paths = laptopChannelPaths(input.laptopHome, input.channel);
  const incoming = `${paths.nextAppImage}.incoming`;
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

function remoteSha256(plan: StagePlan, path: string): string {
  return runRemote(plan.target, `sha256sum ${shellQuote(path)} | cut -d' ' -f1`).trim();
}

/**
 * Copies the AppImage under a temporary name, checks its hash there and only then renames it to
 * the staged `.next` name, so the launcher never activates a partial copy.
 */
export function executeStage(plan: StagePlan): void {
  const imageBytes = NodeFS.statSync(plan.appImage.source).size;
  const applications = NodePath.dirname(plan.appImage.destination);
  runRemote(
    plan.target,
    [
      `mkdir -p ${shellQuote(applications)} ${shellQuote(NodePath.dirname(plan.launcher.destination))}`,
      `free_kb=$(df -Pk ${shellQuote(applications)} | awk 'NR == 2 {print $4}')`,
      `need_kb=${Math.ceil((imageBytes * 2) / 1024)}`,
      `[ "$free_kb" -gt "$need_kb" ] || { echo "$free_kb KB free in ${applications}, need $need_kb KB; nothing staged" >&2; exit 1; }`,
    ].join("\n"),
  );
  run(
    "rsync",
    ["-t", "--partial", plan.appImage.source, `${plan.target}:${plan.appImage.incoming}`],
    { outputFd: process.stderr.fd },
  );
  const copied = remoteSha256(plan, plan.appImage.incoming);
  if (copied !== plan.verify.sha256) {
    throw new Error(
      `The copy at ${plan.appImage.incoming} hashes to ${copied}, not ${plan.verify.sha256}.`,
    );
  }
  // The launcher and the Lab reset take the same lock before they read `.next`.
  const staged = runRemote(
    plan.target,
    [
      `mkdir -p ${shellQuote(NodePath.dirname(plan.channelLock))}`,
      `exec 9>${shellQuote(plan.channelLock)}`,
      "flock -w 900 9",
      `chmod +x ${shellQuote(plan.appImage.incoming)}`,
      `mv -f ${shellQuote(plan.appImage.incoming)} ${shellQuote(plan.appImage.destination)}`,
      `sha256sum ${shellQuote(plan.verify.path)} | cut -d' ' -f1`,
    ].join("\n"),
  ).trim();
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
