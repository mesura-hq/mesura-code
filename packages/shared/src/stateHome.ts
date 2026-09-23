/**
 * The one place that names the directory a Mesura Code server keeps its state
 * in, and the one place that decides whether the server ships as a published
 * npm package.
 *
 * Both facts are fork identity, and both are read by processes that never see
 * each other: the server itself, the SSH launcher that starts servers on remote
 * hosts, and the client that tells a user how to update one. Every copy of
 * either fact is a copy that can drift.
 *
 * It already drifted once. The fork renamed the state directory from upstream's
 * `.t3` in `resolveBaseDir` (apps/server/src/os-jank.ts) and nowhere else, so
 * the remote scripts in packages/ssh kept writing `~/.t3`. Two consequences,
 * both silent: a server the launcher started and a server the operator started
 * by hand used different databases on the same machine, and the launcher's
 * external-server reuse never matched, because it looked for the runtime file
 * under a path no server writes.
 */

/**
 * The directory under `$HOME` that holds a server's state when no base dir is
 * given.
 *
 * Not to be confused with the `.t3` in `devHome.ts`, which is a different
 * directory for a different job: a gitignored state home *inside a git
 * worktree*, so feature work in a throwaway branch does not share a database
 * with the installed app. That one is named by the repository's own
 * `.gitignore`, it never appears on a server, and it must keep its name.
 */
export const DEFAULT_STATE_HOME_DIR_NAME = ".mesura-code";

/**
 * The same directory written as a shell expression, for the scripts that
 * packages/ssh sends to a remote host. `$HOME` stays unexpanded on purpose:
 * the remote user's home is not the local one.
 *
 * The value must contain no whitespace and no shell metacharacter. The remote
 * scripts in packages/ssh/src/tunnel.ts interpolate it raw into generated POSIX
 * `sh`, outside any quoting the generator controls, so a space would split a
 * word and a metacharacter would be interpreted — either one writes state
 * somewhere else, silently. packages/ssh/src/tunnel.test.ts pins the shape.
 */
export const REMOTE_DEFAULT_STATE_HOME = `$HOME/${DEFAULT_STATE_HOME_DIR_NAME}`;

/**
 * The npm package a released server installs from, or `null` while the fork
 * publishes nothing.
 *
 * Mesura Code is a private fork whose server workspace is still named `t3`, so
 * every registry lookup it inherits from upstream resolves *upstream's*
 * package. That is not a missing feature, it is a hazard: a self-update would
 * replace this server with a different product that does not implement the
 * fork's own RPC methods, and would do it without saying so.
 *
 * Keep this `null` until the fork publishes under a name it owns. Code that
 * resolves a package from a registry must treat `null` as "this server cannot
 * be installed from a registry" and offer the operator a path that works,
 * rather than a command that quietly installs someone else's server.
 */
export const PUBLISHED_SERVER_PACKAGE_NAME: string | null = null;

/**
 * The origin a released server downloads its own release archives from, or
 * `null` while the fork publishes none.
 *
 * The registry hazard above has a second road. v0.0.42 replaced the remote
 * `npx t3` bootstrap with a self-contained release archive, and the origin it
 * falls back to is upstream's GitHub releases. A remote launch would therefore
 * download and run *upstream's* server and connect this desktop to it — the
 * same outcome PUBLISHED_SERVER_PACKAGE_NAME closes for npm, reached by a
 * different road and with no npm involved.
 *
 * Keep this `null` until the fork publishes archives it owns. Code that builds
 * a download URL must treat `null` as "this server cannot be installed from a
 * release archive" and refuse, rather than silently resolving upstream's.
 */
export const PUBLISHED_RELEASE_BASE_URL: string | null = null;
