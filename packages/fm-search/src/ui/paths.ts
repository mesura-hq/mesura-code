/**
 * The one path rule the finder's own components share.
 *
 * The engine spells a directory with a trailing separator on both path forms
 * and keys its own store on that, so a row keeps it. Nothing outside the engine
 * wants it: a host's path is separator-free, and `join(path, name)` on
 * `/home/jc/notes/` builds `/home/jc/notes//file` — which works on Linux and
 * silently stops matching the same directory written the normal way.
 *
 * Two callers need the rule — the confirm handler and the information panel —
 * which is one more than justifies stating it once.
 */

/** Root stays "/"; anything else loses its trailing separator. */
export function withoutTrailingSeparator(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
