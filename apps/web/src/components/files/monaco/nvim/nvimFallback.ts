/**
 * Why Neovim is not running, said so the developer can fix it.
 *
 * The reasons come from the launch unchanged, because they are different
 * problems with different fixes: a configuration directory that is not there
 * is not a Neovim that is too old, and telling them "the editor did not start"
 * for both tells them nothing. The panel keeps working either way — it is the
 * plain editor it was before modal editing existed — so this is an explanation
 * rather than an error.
 */

export type NvimFallbackReason =
  | "binary-missing"
  | "version"
  | "config-missing"
  | "spawn-failed"
  | "runtime-unwritable";

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
  return detail.length === 0 ? explanation : `${explanation} — ${detail}`;
}

/** Whether a reason is one the developer can fix in Settings. */
export function isSettingsFixable(reason: NvimFallbackReason): boolean {
  return reason === "config-missing" || reason === "binary-missing" || reason === "version";
}

/**
 * The fallback a failed `open` implies, if any.
 *
 * Pure, and separate from the hook, because the shape it has to read is the
 * part that was wrong: an atom command's failure carries an Effect `Cause`,
 * not the error. A `Cause` has `reasons`, and the typed error is inside one of
 * them — reading `reason` off the cause itself finds nothing, silently, and
 * the panel then sits with no session and no explanation, which is worse than
 * either branch it was meant to choose between.
 *
 * Only a spawn failure is a fallback. A lookup that raced a close, or one
 * request that failed, leaves the session alone to recover: turning the editor
 * into a plain one for a transient error is a worse answer than waiting.
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
 * Whether a failure says the thread has no session at all.
 *
 * What a server restart looks like from here: the client reconnects and
 * attaches again, and the session it attaches to went with the old process.
 * Unlike a spawn failure this is not a reason to give up on Neovim — opening
 * the file again starts a new session.
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
