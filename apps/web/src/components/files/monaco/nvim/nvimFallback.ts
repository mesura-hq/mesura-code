/**
 * Why Neovim is not running, with the launch's own reason, because each reason has a different fix.
 * The panel keeps working as plain Monaco either way, so this is an explanation, not an error.
 */

export type NvimFallbackReason =
  | "binary-missing"
  | "version"
  | "config-missing"
  | "spawn-failed"
  | "runtime-unwritable"
  // Not launch reasons: Neovim started, and then its session ended.
  | "kept-exiting"
  | "session-lost";

export interface NvimFallback {
  readonly reason: NvimFallbackReason;
  readonly detail: string;
}

const EXPLANATIONS: Readonly<Record<NvimFallbackReason, string>> = {
  "binary-missing": "Neovim is not on this machine's PATH",
  version: "this Neovim is too old",
  "config-missing": "that configuration directory is not there",
  "spawn-failed": "Neovim would not start",
  "runtime-unwritable": "the runtime directory could not be written",
  "kept-exiting": "Neovim kept exiting, so it was not restarted",
  "session-lost": "the editor session ended",
};

/**
 * One line for the status strip.
 *
 * The detail is Neovim's own words or a path, and it is what makes the line
 * actionable — a missing directory is only useful with the directory in it.
 */
export function describeFallback(fallback: NvimFallback): string {
  const explanation = EXPLANATIONS[fallback.reason] ?? "Neovim would not start";
  const detail = fallback.detail.trim();
  return detail.length === 0 ? explanation : `${explanation}: ${detail}`;
}

/** Whether a reason is one the developer can fix in Settings. */
export function isSettingsFixable(reason: NvimFallbackReason): boolean {
  return reason === "config-missing" || reason === "binary-missing" || reason === "version";
}

/**
 * The fallback a failed `open` implies, if any. An atom command's failure is an Effect `Cause`: the
 * typed error is inside one of its `reasons`, and reading `reason` off the cause silently finds
 * nothing. Only a spawn failure falls back; a raced lookup or one failed request is transient.
 */
export function fallbackFromCause(cause: unknown): NvimFallback | null {
  for (const error of taggedErrorsOf(cause)) {
    if (error._tag !== "EditorSessionSpawnError") continue;
    const spawn = error as { reason?: unknown; detail?: unknown };
    if (typeof spawn.reason !== "string") continue;
    return {
      reason: spawn.reason as NvimFallbackReason,
      detail: typeof spawn.detail === "string" ? spawn.detail : "",
    };
  }
  return null;
}

/**
 * Whether a failure says the thread has no session at all, as after a server restart. Unlike a
 * spawn failure this is no reason to give up on Neovim: opening the file again starts a new
 * session.
 */
export function isSessionMissing(cause: unknown): boolean {
  return taggedErrorsOf(cause).some((error) => error._tag === "EditorSessionLookupError");
}

/** The typed errors inside an Effect `Cause`, which keeps them in `reasons`. */
function taggedErrorsOf(cause: unknown): ReadonlyArray<{ readonly _tag: unknown }> {
  const reasons =
    typeof cause === "object" && cause !== null && "reasons" in cause
      ? (cause as { reasons: ReadonlyArray<unknown> }).reasons
      : [];
  const errors: Array<{ readonly _tag: unknown }> = [];
  for (const entry of reasons) {
    if (typeof entry !== "object" || entry === null || !("error" in entry)) continue;
    const error = (entry as { error: unknown }).error;
    if (typeof error !== "object" || error === null || !("_tag" in error)) continue;
    errors.push(error);
  }
  return errors;
}
