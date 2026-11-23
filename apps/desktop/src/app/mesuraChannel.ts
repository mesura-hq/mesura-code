// @effect-diagnostics nodeBuiltinImport:off - the channel decides the Electron profile, which is set before Electron is ready and before any Effect service exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Option from "effect/Option";

import {
  MESURA_DESKTOP_CHANNEL_IDENTITY,
  resolveMesuraDesktopChannelIdentity,
  type MesuraDesktopChannelIdentity,
} from "../../../../scripts/lib/brand-assets.ts";

export type { MesuraDesktopChannelIdentity } from "../../../../scripts/lib/brand-assets.ts";

const resolvedByAppPath = new Map<string, MesuraDesktopChannelIdentity>();

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/**
 * Electron loads `main` from this manifest, so a packaged app always has one; only an app path
 * with no manifest at all (ENOENT) counts as stable. Any other read failure, invalid JSON or a
 * non-object manifest throws, because guessing stable would open the stable profile and home.
 */
function readPackagedChannelField(appPath: string): unknown {
  const manifestPath = NodePath.join(appPath, "package.json");
  let raw: string;
  try {
    raw = NodeFS.readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(`Cannot read the packaged manifest ${manifestPath}.`, { cause: error });
  }
  const manifest: unknown = JSON.parse(raw);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`The packaged manifest ${manifestPath} is not a JSON object.`);
  }
  return "mesuraChannel" in manifest ? manifest.mesuraChannel : undefined;
}

/**
 * Reads the packaged `mesuraChannel` field once per app path. An unpackaged app is stable;
 * development mode still takes precedence through `isDevelopment` at each call site.
 * An unknown value throws instead of opening the stable home.
 */
export function resolveMesuraChannel(input: {
  readonly isPackaged: boolean;
  readonly appPath: string;
}): MesuraDesktopChannelIdentity {
  if (!input.isPackaged) return MESURA_DESKTOP_CHANNEL_IDENTITY.stable;
  const cached = resolvedByAppPath.get(input.appPath);
  if (cached !== undefined) return cached;
  const identity = resolveMesuraDesktopChannelIdentity(readPackagedChannelField(input.appPath));
  resolvedByAppPath.set(input.appPath, identity);
  return identity;
}

/** Stable keeps scanning upward from 3773; a side-by-side channel pins its own port. */
export function resolveMesuraChannelBackendPort(
  channel: MesuraDesktopChannelIdentity,
): Option.Option<number> {
  return channel.channel === "stable" ? Option.none() : Option.some(channel.backendPort);
}
