// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Command-line entry for the channel delivery scripts.
// Builds, stages and installs the side-by-side Dev and Lab channels; see docs/operations/mesura-channels.md.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type BuildArtifact,
  buildInWorkload,
  executeBuild,
  planBuild,
  readLatestArtifact,
} from "./build.ts";
import {
  laptopChannelPaths,
  resolveLaptopTarget,
  SIDE_BY_SIDE_CHANNELS,
  type SideBySideChannel,
} from "./config.ts";
import { executeConnect, parseSuppliedPairingUrls, readPrivateInput } from "./connect.ts";
import { labResetRemoteScript, planLabReset } from "./lab-reset.ts";
import { redactSecrets, run, runRemote, shellQuote } from "./shell.ts";
import { runFollowDevTick } from "./follow-dev.ts";
import { stageBuildArtifact } from "./stage.ts";

const USAGE = `Usage:
  channel.ts build --channel <dev|lab> --rev <rev>
  channel.ts stage --channel <dev|lab>
  channel.ts lab --rev <branch>
  channel.ts connect [--pairing-urls <mode-0600 file | ->]
  channel.ts follow-dev`;

export type ChannelCommand =
  | {
      readonly command: "build";
      readonly channel: SideBySideChannel;
      readonly revision: string;
      /** Set by the workload the outer `build` starts; runs the steps in this process. */
      readonly runId?: string;
    }
  | { readonly command: "stage"; readonly channel: SideBySideChannel }
  | { readonly command: "lab"; readonly revision: string }
  | {
      readonly command: "connect";
      /** A mode-0600 file, or `-` for stdin, with `stable=<url>` / `vigilia=<url>` lines. */
      readonly pairingUrlsFile?: string;
    }
  | { readonly command: "follow-dev" };

function usageError(message: string): Error {
  return new Error(`${message}\n${USAGE}`);
}

/** Parses `--flag value` pairs; a flag outside `allowed` or without a value throws. */
function readFlags(argv: ReadonlyArray<string>, allowed: ReadonlyArray<string>) {
  const values = new Map<string, Array<string>>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (!allowed.includes(flag)) throw usageError(`Unknown argument ${flag}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw usageError(`${flag} needs a value.`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
    index += 1;
  }
  const single = (flag: string) => {
    const found = values.get(flag) ?? [];
    if (found.length > 1) throw usageError(`${flag} is given more than once.`);
    return found[0];
  };
  const required = (flag: string) => {
    const value = single(flag);
    if (value === undefined) throw usageError(`${flag} is required.`);
    return value;
  };
  return { values, single, required };
}

function readChannel(value: string): SideBySideChannel {
  const channel = SIDE_BY_SIDE_CHANNELS.find((candidate) => candidate === value);
  if (channel === undefined) {
    throw usageError(
      `--channel must be one of ${SIDE_BY_SIDE_CHANNELS.join(", ")}; the stable app has its own release scripts.`,
    );
  }
  return channel;
}

export function parseChannelArgs(argv: ReadonlyArray<string>): ChannelCommand {
  const [command, ...rest] = argv;
  switch (command) {
    case "build": {
      // `--in-workload` takes no value; the workload passes it with `--run-id`.
      const inWorkload = rest.includes("--in-workload");
      const flags = readFlags(
        rest.filter((argument) => argument !== "--in-workload"),
        ["--channel", "--rev", ...(inWorkload ? ["--run-id"] : [])],
      );
      const runId = inWorkload ? flags.required("--run-id") : undefined;
      return {
        command,
        channel: readChannel(flags.required("--channel")),
        revision: flags.required("--rev"),
        ...(runId === undefined ? {} : { runId }),
      };
    }
    case "stage":
      return {
        command,
        channel: readChannel(readFlags(rest, ["--channel"]).required("--channel")),
      };
    case "lab":
      return { command, revision: readFlags(rest, ["--rev"]).required("--rev") };
    case "connect": {
      const pairingUrlsFile = readFlags(rest, ["--pairing-urls"]).single("--pairing-urls");
      return { command, ...(pairingUrlsFile === undefined ? {} : { pairingUrlsFile }) };
    }
    case "follow-dev":
      readFlags(rest, []);
      return { command };
    default:
      throw usageError(`Unknown command ${command ?? "(none)"}.`);
  }
}

function stageLatest(
  channel: SideBySideChannel,
  laptop: { target: string; home: string },
): BuildArtifact {
  const artifact = readLatestArtifact(NodeOS.homedir(), channel);
  if (artifact === undefined) {
    throw new Error(`No ${channel} build yet; run build --channel ${channel} --rev <rev> first.`);
  }
  stageBuildArtifact(artifact, laptop);
  return artifact;
}

/** The laptop has no checkout, so its half of the Lab reset travels as one self-contained file. */
async function bundleLabResetForLaptop(outfile: string): Promise<void> {
  const esbuild = await import("esbuild");
  await esbuild.build({
    stdin: {
      contents:
        'import { runLabResetOnLaptop } from "./lab-reset.ts";\nawait runLabResetOnLaptop(process.argv.slice(2));\n',
      resolveDir: import.meta.dirname,
      loader: "ts",
      sourcefile: "lab-reset-entry.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    logLevel: "warning",
  });
}

async function runLab(revision: string): Promise<void> {
  const laptop = resolveLaptopTarget();
  await buildInWorkload({ channel: "lab", revision, deployHome: NodeOS.homedir() });
  const artifact = stageLatest("lab", laptop);
  const { stateDirectory } = laptopChannelPaths(laptop.home, "lab");
  const stateEntries = runRemote(
    laptop.target,
    `ls -A ${shellQuote(stateDirectory)} 2>/dev/null || true`,
  )
    .split("\n")
    .filter((entry) => entry.length > 0);
  const plan = planLabReset({
    revision,
    laptopHome: laptop.home,
    laptopTarget: laptop.target,
    stateEntries,
    resetId: new Date().toISOString().replaceAll(/[:.]/gu, "-"),
    sha256: artifact.sha256,
  });

  using scratch = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-lab-reset-"));
  const bundle = NodePath.join(scratch.path, "lab-reset.mjs");
  await bundleLabResetForLaptop(bundle);
  runRemote(laptop.target, `mkdir -p ${shellQuote(NodePath.dirname(plan.laptopScript))}`);
  run("rsync", ["-t", bundle, `${laptop.target}:${plan.laptopScript}`]);
  runRemote(laptop.target, labResetRemoteScript(plan), { outputFd: process.stdout.fd });
  process.stdout.write(`Lab runs ${revision} (${artifact.commit}).\n`);
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const parsed = parseChannelArgs(argv);
  switch (parsed.command) {
    case "build": {
      const input = {
        channel: parsed.channel,
        revision: parsed.revision,
        deployHome: NodeOS.homedir(),
      };
      const artifact =
        parsed.runId === undefined
          ? await buildInWorkload(input)
          : executeBuild(planBuild({ ...input, runId: parsed.runId }), parsed.runId);
      process.stdout.write(`AppImage ${artifact.path}\nsha256 ${artifact.sha256}\n`);
      return;
    }
    case "stage":
      stageLatest(parsed.channel, resolveLaptopTarget());
      return;
    case "lab":
      await runLab(parsed.revision);
      return;
    case "connect":
      await executeConnect({
        suppliedPairingUrls:
          parsed.pairingUrlsFile === undefined
            ? new Map()
            : parseSuppliedPairingUrls(readPrivateInput(parsed.pairingUrlsFile)),
      });
      return;
    case "follow-dev":
      await runFollowDevTick({ deployHome: NodeOS.homedir() });
      return;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${redactSecrets(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
}
