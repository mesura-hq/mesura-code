/**
 * The scheme the renderer and every previewed file are served from.
 *
 * Its own module, holding one constant, for one reason: `protocol.ts` imports
 * `electron` at module scope and therefore cannot be reached from any test, so
 * anything that needs this value AND needs to be testable cannot get it from
 * there. `frameNavigation.ts` is exactly that — a security rule nobody can
 * check is how a guard quietly stops guarding.
 *
 * Written twice before this existed, once here and once with a colon on the
 * end, which is the shape where a rename lands in one file and the other keeps
 * comparing against a value that no longer exists.
 */
export const APP_SCHEME = "symmetria-fm";

/** The same, as a URL's `protocol` reads it. */
export const APP_SCHEME_PROTOCOL = `${APP_SCHEME}:`;
