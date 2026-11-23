// @effect-diagnostics nodeBuiltinImport:off - Host paths for the channel delivery scripts.
/**
 * The one place that names the machines, homes and paths the channel scripts act on. The channel
 * identities themselves (home directory name, executable, ports, artifact name) come from
 * `scripts/lib/brand-assets.ts`, which the packaged app reads too.
 */
import * as NodePath from "node:path";

import { MESURA_DESKTOP_CHANNEL_IDENTITY } from "../lib/brand-assets.ts";
import { runRemote } from "./shell.ts";

export const SIDE_BY_SIDE_CHANNELS = ["dev", "lab"] as const;
export type SideBySideChannel = (typeof SIDE_BY_SIDE_CHANNELS)[number];

/** Laptop servers a client can list; `vigilia` is the build host's stable server. */
export type ChannelServer = "stable" | SideBySideChannel | "vigilia";

/** The laptop SSH target of the release stage scripts (`stage-laptop.sh`); override per run. */
export const DEFAULT_LAPTOP_SSH_TARGET = "jc@arch-laptop";
export const LAPTOP_SSH_TARGET_ENV = "MESURA_CHANNEL_LAPTOP_TARGET";
/** Absolute laptop home; resolved over SSH when unset. A witness points it at a scratch home. */
export const LAPTOP_HOME_ENV = "MESURA_CHANNEL_LAPTOP_HOME";
/** The laptop's MagicDNS name; resolved over SSH from `tailscale status` when unset. */
export const LAPTOP_TAILNET_NAME_ENV = "MESURA_CHANNEL_LAPTOP_TAILNET_NAME";

/** The source checkout the deploy worktree shares objects with. */
export const CHANNEL_SOURCE_REPOSITORY = "/opt/dev/repos/mesura-code";
/** Never the stable deploy worktree (`/opt/dev/deploy/mesura-code-v012`). */
export const CHANNEL_DEPLOY_WORKTREE = "/opt/dev/deploy/mesura-code-channels";
export const CHANNEL_BUILD_LOCK = "/tmp/mesura-channel-build.lock";
export const CHANNEL_BUILD_WORKLOAD = "mesura-agent-service";
export const CHANNEL_BUILD_WORKLOAD_NAME = "mesura-channel-build";
export const CHANNEL_BUILD_MEMORY = "6G";

/** Stable homes no channel command may write to. Relative to the owning machine's home. */
export const VIGILIA_STABLE_HOME = ".mesura-code";
/** The laptop's daily app keeps its XDG-isolated state here (`~/.local/bin/mesura-sync-test`). */
export const LAPTOP_STABLE_STATE_ROOT = ".local/state/mesura-sync-v046-test";
export const LAPTOP_STABLE_HOME = `${LAPTOP_STABLE_STATE_ROOT}/home`;
export const LAPTOP_STABLE_LAUNCHER = ".local/bin/mesura-sync-test";

/** vigilia's server label, as clients save it, and the local port its Tailscale Serve route proxies. */
export const VIGILIA_ENVIRONMENT_LABEL = "vigilia-home";
export const VIGILIA_SERVER_PORT = MESURA_DESKTOP_CHANNEL_IDENTITY.stable.backendPort;

export const READINESS_PATH = "/.well-known/t3/environment";
export const READINESS_WAIT_SECONDS = 600;

export function channelTitle(channel: SideBySideChannel): "Dev" | "Lab" {
  const { stageLabel } = MESURA_DESKTOP_CHANNEL_IDENTITY[channel];
  if (stageLabel === null) throw new Error(`Channel ${channel} has no stage label.`);
  return stageLabel;
}

export function laptopOrigin(server: Exclude<ChannelServer, "vigilia">): string {
  return `http://127.0.0.1:${MESURA_DESKTOP_CHANNEL_IDENTITY[server].backendPort}`;
}

/** Every laptop path a channel owns, derived from the laptop's absolute home. */
export function laptopChannelPaths(laptopHome: string, channel: SideBySideChannel) {
  const identity = MESURA_DESKTOP_CHANNEL_IDENTITY[channel];
  const applications = NodePath.join(laptopHome, "Applications");
  const appImage = NodePath.join(applications, `${identity.artifactBaseName}.AppImage`);
  const home = NodePath.join(laptopHome, identity.homeDirName);
  const toolState = NodePath.join(laptopHome, ".local/state", `mesura-code-${channel}`);
  return {
    channel,
    executableName: identity.executableName,
    appImage,
    nextAppImage: NodePath.join(applications, `${identity.artifactBaseName}.next.AppImage`),
    previousAppImage: `${appImage}.prev`,
    launcher: NodePath.join(laptopHome, ".local/bin", `mesura-code-${channel}`),
    home,
    stateDirectory: NodePath.join(home, "userdata"),
    worktrees: NodePath.join(home, "worktrees"),
    savedEnvironments: NodePath.join(home, "userdata", "saved-environments.json"),
    /** The launcher appends `launch.log` here; the scripts keep their own files beside it. */
    toolState,
    launchLog: NodePath.join(toolState, "launch.log"),
    /** Held by the launcher's swap, `stage`'s publication and the Lab reset (launcher.sh names it too). */
    channelLock: NodePath.join(toolState, "channel.lock"),
    origin: laptopOrigin(channel),
    readinessUrl: `${laptopOrigin(channel)}${READINESS_PATH}`,
    tailscaleServePort: identity.tailscaleServePort,
  };
}

export function laptopStablePaths(laptopHome: string) {
  return {
    launcher: NodePath.join(laptopHome, LAPTOP_STABLE_LAUNCHER),
    savedEnvironments: NodePath.join(
      laptopHome,
      LAPTOP_STABLE_HOME,
      "userdata",
      "saved-environments.json",
    ),
    origin: laptopOrigin("stable"),
    readinessUrl: `${laptopOrigin("stable")}${READINESS_PATH}`,
  };
}

/** Build state on vigilia: the newest artifact per channel and the build logs. */
export function vigiliaChannelState(deployHome: string) {
  const root = NodePath.join(deployHome, ".local/state/mesura-channel");
  return {
    root,
    latestArtifact: (channel: SideBySideChannel) => NodePath.join(root, `${channel}-latest.json`),
    lastFailure: (channel: SideBySideChannel) =>
      NodePath.join(root, `${channel}-last-failure.json`),
    buildOutput: (channel: SideBySideChannel) =>
      NodePath.join(deployHome, "builds", `mesura-channel-${channel}`),
    buildLog: (channel: SideBySideChannel) => NodePath.join(root, `${channel}-build.log`),
  };
}

/** The laptop SSH target and its absolute home; the home is read over SSH unless overridden. */
export function resolveLaptopTarget(): { readonly target: string; readonly home: string } {
  const target = process.env[LAPTOP_SSH_TARGET_ENV] ?? DEFAULT_LAPTOP_SSH_TARGET;
  const home = process.env[LAPTOP_HOME_ENV] ?? runRemote(target, 'printf %s "$HOME"');
  return { target, home };
}
