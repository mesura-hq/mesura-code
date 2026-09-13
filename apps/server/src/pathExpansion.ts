// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as Path from "effect/Path";

/**
 * Expand a leading `~` (or `~/…`, `~\…`) in a user-supplied path to the
 * current user's home directory. Spawned processes don't get shell
 * expansion, so env vars like `CODEX_HOME=~/.codex-work` would be passed
 * verbatim and treated as relative paths by the receiver.
 *
 * Matches the behavior of the other `expandHomePath` helpers in the
 * workspace layers and CLI bootstrap: `~` alone and both `~/` and `~\`
 * separators are handled. Returns the input unchanged if it doesn't
 * start with `~` or is empty. Does not handle `~user` (other-user)
 * expansion.
 */
export function expandHomePath(value: string): string {
  return expandHomePathIn(value, NodeOS.homedir());
}

/**
 * Same expansion, against a home directory the caller names.
 *
 * Separate from `expandHomePath` so a caller can be tested against a
 * temporary directory instead of the machine's real home. Callers that have
 * no reason to override it should use `expandHomePath`.
 */
export function expandHomePathIn(value: string, homeDir: string): string {
  if (!value) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(homeDir, value.slice(2));
  }
  return value;
}

/**
 * Same expansion as `expandHomePath`, but joins with a caller-supplied
 * `Path.Path` service instead of `node:path`. Use this inside Effect code that
 * already has `Path.Path` in context so the platform layer stays in control of
 * separator handling.
 */
export function expandHomePathWith(value: string, path: Path.Path): string {
  if (value === "~") {
    return NodeOS.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}
