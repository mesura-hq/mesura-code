/**
 * A missing web client fails the build by default: the server would answer its API while every
 * browser gets `503 No static directory configured`, and the desktop app never shows it.
 * `--allow-missing-client` opts into a server-only bundle. This lives outside `cli.ts` because
 * that module runs `Command.run(...)` at import, so tests cover this decision, not the exit code.
 */

/** What the build should do with `apps/web/dist`. */
export type WebClientBundleAction = "bundle" | "skip" | "fail";

/** Resolve the build's response to a missing web client. See the module doc for why. */
export const resolveWebClientBundleAction = (input: {
  readonly webClientExists: boolean;
  readonly allowMissingClient: boolean;
}): WebClientBundleAction => {
  if (input.webClientExists) return "bundle";
  return input.allowMissingClient ? "skip" : "fail";
};
