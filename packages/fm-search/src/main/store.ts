/**
 * The one owner of where the search databases live.
 *
 * **One function, and only one, decides this.** The engine refuses to open the
 * same store twice inside one process, so two callers that disagree about the
 * path do not merely duplicate work — they produce a second environment and a
 * failure that reads as "environment already open" from somewhere unrelated.
 * The research named this as the piece both products need and neither
 * implements; this is it.
 *
 * The engine creates the directories itself, via `fs::create_dir_all`. Nothing
 * here should `mkdir`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface StorePaths {
  /** The frecency database. Opened by the engine; never written by this app. */
  readonly frecencyDbPath: string;
  /** The query-tracker database. This is the one `recordOpen` writes. */
  readonly historyDbPath: string;
}

/**
 * Resolve both database paths from the environment.
 *
 * Precedence, highest first:
 *
 * 1. `SYMMETRIA_FM_FRECENCY_DIR` — the override. The tests isolate the store
 *    into a temp directory through it, so it has to outrank everything; it is
 *    also the user's relocation hook.
 * 2. `XDG_DATA_HOME`.
 * 3. `HOME` plus the XDG default of `.local/share`.
 *
 * `env` is a parameter rather than a read of `process.env`, because a function
 * that reads the ambient environment cannot be tested for its precedence rules
 * without mutating the process the tests run in.
 */
export function resolveStorePaths(env: NodeJS.ProcessEnv = process.env): StorePaths {
  const override = env["SYMMETRIA_FM_FRECENCY_DIR"];
  const root =
    override !== undefined && override !== "" ? override : join(dataHome(env), "symmetria", "fff");

  return { frecencyDbPath: join(root, "frecency"), historyDbPath: join(root, "history") };
}

function dataHome(env: NodeJS.ProcessEnv): string {
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg !== "") return xdg;

  // `homedir()` is the fallback rather than `?? ""`, because an empty HOME
  // produced a RELATIVE path — and since the engine creates the directory
  // itself, the store then landed silently under whatever the process's
  // working directory happened to be. A utility process with a stripped
  // environment is exactly the case the next phase introduces.
  const home = env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (home === "") throw new Error("Cannot locate the search store: no HOME and no XDG_DATA_HOME.");
  return join(home, ".local", "share");
}
