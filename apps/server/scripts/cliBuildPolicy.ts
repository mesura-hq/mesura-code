/**
 * Decides what `cli.ts build` does about the web client bundle.
 *
 * Failing is the default. The previous behavior — warn and exit 0 — produced a
 * server package that installs, starts, and answers its whole API while every
 * browser client receives `503 No static directory configured and no dev URL set.`
 * The desktop app hides that failure because it ships its own renderer and never
 * requests the server's static files, so every signal an operator checks reports a
 * healthy server and only phone and browser users see the breakage.
 *
 * Skipping stays reachable through `--allow-missing-client`, for a caller that
 * deliberately wants a server-only bundle.
 *
 * This lives outside `cli.ts` because that module calls `Command.run(...)` at import
 * time, so a test cannot reach the decision without running the CLI.
 *
 * Known coverage gap, stated rather than left silent: the tests cover this decision,
 * not the CLI's translation of it into an exit code and a flag. Closing that needs a
 * spawned build, and two things make one a poor trade here. `RepoRoot` resolves from
 * `import.meta.url` at module scope, so a spawned build always targets the real
 * repository and its outcome would depend on whether the machine happens to have
 * `apps/web/dist` built. Spawning also has to go through Effect's `ChildProcessSpawner`
 * to satisfy this repo's lint and type rules, which buys stream plumbing in a test for
 * a rename-sized regression. The wiring in `cli.ts` is straight-line and type-checked.
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
