import { fileURLToPath } from "node:url";

import type { BrowserWindowConstructorOptions } from "electron";

/**
 * The first paint happens before any stylesheet loads. Without a background
 * colour that first frame is white, which on a near-black application reads as
 * a flash every time a window opens.
 */
export const WINDOW_BACKGROUND = "#0b0b0b";

/** Where the preload bundle lands, relative to the built main bundle. */
function preloadPath(): string {
  return fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
}

/**
 * Build the options for the one window this application opens.
 *
 * Pure on purpose: it imports Electron's *types* and nothing from Electron at
 * runtime, so the security posture can be asserted in a plain unit test instead
 * of only inside a launched application.
 *
 * The three `webPreferences` flags below are copied from the host that will
 * eventually embed this panel. They are not a preference: the renderer must be
 * unable to reach the filesystem, so that every scan, stat and mutation is
 * forced across the bridge. If the standalone diverges here, the interface
 * cannot be shared and the project ends up maintaining two of them.
 */
export function buildWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Stated rather than left to the default. These two are what quietly
      // reopen what `sandbox: true` closed, and a future edit that flips one
      // would otherwise pass every other assertion about this object.
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      // What turns on Chromium's built-in PDF viewer, and nothing else.
      //
      // It defaults to false, and with it off an `<embed type="application/pdf">`
      // loads `chrome-error://chromewebdata` instead — a failure invisible from
      // the DOM, which still shows a correct-looking embed tag, and silent at
      // the console. Only the frame tree exposes it.
      //
      // The name is a leftover: NPAPI and PPAPI plugins are long gone from
      // Chromium, so the only thing this flag now admits is the PDF viewer. It
      // does not widen what the renderer may reach — that is still decided by
      // `sandbox`, `contextIsolation` and the content policy.
      plugins: true,
    },
  };
}
