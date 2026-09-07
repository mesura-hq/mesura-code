/**
 * Decides what `cli.ts build` does about the web client bundle.
 *
 * This lives in its own module because `cli.ts` calls `Command.run(...)` at
 * import time, so a test cannot reach the decision without running the CLI.
 */

/** What the build should do with `apps/web/dist`. */
export type WebClientBundleAction = "bundle" | "skip" | "fail";

/**
 * Resolve the build's response to a missing web client.
 *
 * Failing is the default, and the reason is that the previous behavior — warn
 * and exit 0 — produced a server package that installs, starts, and answers its
 * whole API normally while every browser client receives
 * `503 No static directory configured and no dev URL set.` The desktop app hides
 * that failure because it ships its own renderer and never requests the server's
 * static files, so the only symptom reaches phone and browser users while every
 * signal an operator would check reports a healthy server.
 *
 * Skipping stays reachable through `--allow-missing-client` for a caller that
 * deliberately wants a server-only bundle.
 */
export const resolveWebClientBundleAction = (input: {
  readonly webDistExists: boolean;
  readonly allowMissingClient: boolean;
}): WebClientBundleAction => {
  if (input.webDistExists) return "bundle";
  return input.allowMissingClient ? "skip" : "fail";
};
