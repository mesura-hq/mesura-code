// @effect-diagnostics nodeBuiltinImport:off - Reads the Dev follower's record; `build` and `follow-dev` share it.
import * as NodeFS from "node:fs";

import type { BuildArtifact } from "./build.ts";

export interface FollowDevError {
  readonly sha: string;
  readonly at: string;
  readonly step: "build" | "stage";
  readonly error: string;
  readonly log?: string;
}

export interface FollowDevState {
  readonly lastBuiltSha: string | null;
  readonly lastStagedSha: string | null;
  /** The newest build not yet on the laptop; a newer build replaces it, cleanup keeps it. */
  readonly pendingAppImage: BuildArtifact | null;
  readonly lastError: FollowDevError | null;
}

const EMPTY_FOLLOW_DEV_STATE: FollowDevState = {
  lastBuiltSha: null,
  lastStagedSha: null,
  pendingAppImage: null,
  lastError: null,
};

export function readFollowDevState(path: string): FollowDevState {
  if (!NodeFS.existsSync(path)) return EMPTY_FOLLOW_DEV_STATE;
  return {
    ...EMPTY_FOLLOW_DEV_STATE,
    ...(JSON.parse(NodeFS.readFileSync(path, "utf8")) as Partial<FollowDevState>),
  };
}
