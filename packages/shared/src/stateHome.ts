/**
 * The one place that names the server's state directory and decides whether the server ships as a
 * published package. The server, the SSH launcher and the client read both facts in separate processes,
 * and a second copy drifts silently: packages/ssh once kept writing `~/.t3` after a rename.
 */

/**
 * Not the `.t3` in `devHome.ts`: that is a gitignored state home inside a git worktree, named by the
 * repository's `.gitignore`, and it must keep its name.
 */
export const DEFAULT_STATE_HOME_DIR_NAME = ".mesura-code";

/**
 * `$HOME` stays unexpanded: the remote user's home is not the local one. The value must contain no
 * whitespace or shell metacharacter, because packages/ssh/src/tunnel.ts interpolates it raw into
 * generated POSIX `sh`; packages/ssh/src/tunnel.test.ts pins the shape.
 */
export const REMOTE_DEFAULT_STATE_HOME = `$HOME/${DEFAULT_STATE_HOME_DIR_NAME}`;

/**
 * `null` while the fork publishes no server package: the server workspace is still named `t3`, so
 * a registry lookup resolves upstream's package and a self-update would silently replace this server.
 * Code that resolves a package must treat `null` as not installable from a registry and offer a path
 * that works.
 */
export const PUBLISHED_SERVER_PACKAGE_NAME: string | null = null;

/**
 * `null` while the fork publishes no release archives: the fallback origin is upstream's GitHub
 * releases, so a remote launch would download and run upstream's server. Code that builds a download
 * URL must refuse on `null` rather than silently resolving upstream's.
 */
export const PUBLISHED_RELEASE_BASE_URL: string | null = null;
