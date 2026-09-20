import { clipboard, nativeImage } from "electron";

/**
 * The system clipboard, which only this process can reach.
 *
 * The renderer is sandboxed: it cannot read a file and it has no platform API,
 * so both destinations cross the bridge. Text arrives already derived — the
 * shared package builds it from the paths, so the rule for what "the name
 * without its extension" means lives in one place and is tested without a
 * window.
 *
 * ── Why this fixes a Qt defect by construction ──────────────────────────────
 * The Qt build copies through `wl-copy`, which forks a process to serve the
 * selection for as long as it is the owner. That fork dies with the window —
 * the daemon quits by design and systemd kills the cgroup — so a copy made in
 * a window that then closed pasted nothing. Electron's clipboard belongs to the
 * application process and has no such shape. Nothing here reproduces the Qt
 * workaround because nothing needs to.
 */

/** Put text on the clipboard. An empty string is a legitimate copy. */
export function copyText(text: string): void {
  clipboard.writeText(text);
}

/**
 * Put an image on the clipboard, or say why not.
 *
 * `nativeImage.createFromPath` does NOT throw for a file that is not an image,
 * or for one that does not exist — it returns an EMPTY image, and writing that
 * would clear the clipboard while reporting success. `isEmpty()` is the only
 * way to tell, so it is checked rather than assumed.
 */
export function copyImage(path: string): string | null {
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return "that image could not be read";

  clipboard.writeImage(image);
  return null;
}
