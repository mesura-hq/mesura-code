// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A plain CLI with no Effect runtime; one tick of the Dev follower.
/**
 * Builds Dev after each merge to `dev` and stages it once the laptop answers. The timer
 * `systemd/mesura-channel-dev.timer` runs one tick every 15 minutes; see
 * docs/operations/mesura-channels.md. The decisions read only the record, so they test without a build.
 */
import * as NodeFS from "node:fs";

import { type BuildArtifact, type BuildInput, buildInWorkload } from "./build.ts";
import {
  CHANNEL_SOURCE_REPOSITORY,
  laptopSshTarget,
  resolveLaptopTarget,
  vigiliaChannelState,
} from "./config.ts";
import { type FollowDevError, type FollowDevState, readFollowDevState } from "./follow-record.ts";
import { isSshReachable, run, tryHoldFileLock, writeJsonAtomic } from "./shell.ts";
import { stageBuildArtifact } from "./stage.ts";

const CHANNEL = "dev";
/** dev can move during every build; past this many builds in one tick, the next tick goes on. */
const MAX_BUILDS_PER_TICK = 3;

export type FollowDevDecision =
  | { readonly kind: "idle" }
  | { readonly kind: "build"; readonly sha: string }
  | { readonly kind: "stage"; readonly artifact: BuildArtifact };

export function decideFollowDevTick(
  state: Pick<FollowDevState, "lastBuiltSha" | "lastStagedSha"> & Partial<FollowDevState>,
  observations: { readonly originDevSha: string },
): FollowDevDecision {
  if (observations.originDevSha !== state.lastBuiltSha) {
    return { kind: "build", sha: observations.originDevSha };
  }
  if (state.lastStagedSha === state.lastBuiltSha) return { kind: "idle" };
  // The unstaged build is gone (or was never recorded): build the same SHA again.
  if (!state.pendingAppImage) return { kind: "build", sha: observations.originDevSha };
  return { kind: "stage", artifact: state.pendingAppImage };
}

export interface FollowDevOptions {
  /** The build host's home, where the record and the build state live. */
  readonly deployHome: string;
  readonly fetchOriginDev?: () => Promise<string>;
  readonly build?: (input: BuildInput) => Promise<BuildArtifact>;
  readonly isLaptopReachable?: () => Promise<boolean>;
  readonly stage?: (artifact: BuildArtifact) => Promise<void>;
  readonly report?: (line: string) => void;
}

async function fetchOriginDevFromSource(): Promise<string> {
  run("git", ["-C", CHANNEL_SOURCE_REPOSITORY, "fetch", "-q", "origin", "dev"]);
  return run("git", [
    "-C",
    CHANNEL_SOURCE_REPOSITORY,
    "rev-parse",
    "--verify",
    "-q",
    "origin/dev^{commit}",
  ]).trim();
}

function assertCommitSha(value: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    throw new Error(`origin/dev resolved to '${value}', which is not a commit SHA.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One tick, under the follower lock: fetch `origin/dev`, build it when its SHA is not the last built
 * one, fetch again after the build (dev may have moved meanwhile), then stage the newest build when
 * the laptop answers. A failure is recorded and rethrown, so the unit fails and the next tick
 * retries; the last built SHA moves only after a build succeeds.
 */
export async function runFollowDevTick(options: FollowDevOptions): Promise<FollowDevState> {
  const {
    deployHome,
    fetchOriginDev = fetchOriginDevFromSource,
    build = buildInWorkload,
    isLaptopReachable = async () => isSshReachable(laptopSshTarget()),
    stage = async (artifact: BuildArtifact) => stageBuildArtifact(artifact, resolveLaptopTarget()),
    report = (line: string) => process.stdout.write(`${line}\n`),
  } = options;
  const channelState = vigiliaChannelState(deployHome);
  const recordPath = channelState.followState(CHANNEL);
  using lock = tryHoldFileLock(channelState.followLock(CHANNEL));
  if (lock === undefined) {
    report(`Another follow-dev tick holds ${channelState.followLock(CHANNEL)}; this one skips.`);
    return readFollowDevState(recordPath);
  }

  let state = readFollowDevState(recordPath);
  if (state.pendingAppImage && !NodeFS.existsSync(state.pendingAppImage.path)) {
    report(`The unstaged build ${state.pendingAppImage.path} is gone; it is built again.`);
    state = { ...state, pendingAppImage: null };
  }
  const save = (next: FollowDevState) => {
    state = next;
    writeJsonAtomic(recordPath, state);
  };
  const fail = (sha: string, step: FollowDevError["step"], error: unknown, log?: string) => {
    save({
      ...state,
      lastError: {
        sha,
        at: new Date().toISOString(),
        step,
        error: errorMessage(error),
        ...(log === undefined ? {} : { log }),
      },
    });
    return error;
  };
  const observe = async () => ({ originDevSha: assertCommitSha(await fetchOriginDev()) });

  let observations = await observe();
  let decision = decideFollowDevTick(state, observations);
  for (let builds = 0; decision.kind === "build"; builds += 1) {
    if (builds === MAX_BUILDS_PER_TICK) {
      report(`dev moved during ${builds} builds; the next tick builds ${decision.sha}.`);
      return state;
    }
    const { sha } = decision;
    report(`Building Dev at ${sha}.`);
    let artifact: BuildArtifact;
    try {
      artifact = await build({ channel: CHANNEL, revision: sha, deployHome });
    } catch (error) {
      throw fail(sha, "build", error, channelState.buildLog(CHANNEL));
    }
    save({ ...state, lastBuiltSha: sha, pendingAppImage: artifact, lastError: null });
    observations = await observe();
    decision = decideFollowDevTick(state, observations);
  }

  if (decision.kind === "stage") {
    const { artifact } = decision;
    if (!(await isLaptopReachable())) {
      report(`The laptop does not answer; ${artifact.path} waits for a later tick.`);
      return state;
    }
    const sha = state.lastBuiltSha ?? artifact.commit;
    report(`Staging Dev at ${sha}.`);
    try {
      await stage(artifact);
    } catch (error) {
      throw fail(sha, "stage", error);
    }
    save({ ...state, lastStagedSha: sha, pendingAppImage: null, lastError: null });
    return state;
  }

  report(`Dev is staged at ${observations.originDevSha}; nothing to do.`);
  return state;
}
