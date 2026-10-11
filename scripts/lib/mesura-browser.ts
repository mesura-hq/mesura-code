// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Browser automation helper for agents; no Effect runtime.
/**
 * A paired, headless browser on this worktree's dev server, for agents verifying
 * UI. Every session used to rebuild the same throwaway Playwright script: find a
 * browser binary, mint a pairing token, pair, emulate a phone, set the theme. This
 * module is that script, once.
 *
 *   import { openMesuraPage } from "<repo>/scripts/lib/mesura-browser.ts";
 *   const { page, close } = await openMesuraPage({ route: "/", device: "phone" });
 *   try { ... } finally { await close(); }
 *
 * - The profile lives in the worktree's gitignored `.t3/browser-profile`, so the
 *   pairing survives a reboot that clears `/tmp`. One process may hold it at a time.
 * - Pairing mints its own token with `apps/server/src/bin.ts pair --base-dir`, against
 *   this worktree's `.t3` unless `baseDir` names another isolated home. Without the
 *   flag `pair` falls back to the shared home, which is the developer's live install.
 * - `theme` sets the browser's `prefers-color-scheme`. Dark is the default because it
 *   is the developer's; an appearance saved in the app's settings still wins over it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type BrowserContext, type Page, chromium, devices } from "playwright-core";

import { toolchainEnvironment } from "./mesura-toolchain.ts";

export const MESURA_DEVICES = ["desktop", "phone"] as const;
export type MesuraDevice = (typeof MESURA_DEVICES)[number];
export const MESURA_THEMES = ["dark", "light"] as const;
export type MesuraTheme = (typeof MESURA_THEMES)[number];

export interface OpenMesuraPageOptions {
  /** App path to open after pairing, for example `/` or `/<environmentId>/<threadId>`. */
  readonly route?: string;
  readonly device?: MesuraDevice;
  readonly theme?: MesuraTheme;
  /**
   * Web origin to use, for example the tailnet one. Kept as given: pairing builds
   * its URL on this origin. Defaults to the origin last paired for `baseDir`.
   */
  readonly origin?: string;
  /** The dev server's home, when it was started with `--home-dir`. Defaults to `<repo>/.t3`. */
  readonly baseDir?: string;
}

export interface MesuraPage {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..", "..");
const defaultBaseDir = NodePath.join(repositoryRoot, ".t3");
const profileDirectory = NodePath.join(repositoryRoot, ".t3", "browser-profile");
/** Last paired origin per base directory, so a second isolated server is not confused with the first. */
const originsFile = NodePath.join(profileDirectory, "mesura-origins.json");
const PAIR_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 30_000;

const DEVICE_OPTIONS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: devices["Pixel 7"],
} as const;

/** Newest usable headless shell in the Playwright cache, for when the pinned revision is absent. */
function newestInstalledHeadlessShell(): string | undefined {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    NodePath.join(NodeOS.homedir(), ".cache", "ms-playwright");
  if (!NodeFS.existsSync(cache)) return undefined;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone agent script has no Effect runtime.
  const hostPlatform = NodeOS.platform();
  const platformDirectory = hostPlatform === "linux" ? "chrome-headless-shell-linux64" : undefined;
  if (platformDirectory === undefined) return undefined;
  return NodeFS.readdirSync(cache)
    .filter((entry) => entry.startsWith("chromium_headless_shell-"))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((entry) => NodePath.join(cache, entry, platformDirectory, "chrome-headless-shell"))
    .find((executable) => {
      try {
        NodeFS.accessSync(executable, NodeFS.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * Launches with the browser this `playwright-core` expects, or else the newest
 * usable headless shell: agents on this host install browsers with other Playwright
 * versions, so the pinned revision is often missing while a newer one works.
 */
async function launchContext(options: OpenMesuraPageOptions): Promise<BrowserContext> {
  const launchOptions = {
    headless: true,
    ...DEVICE_OPTIONS[options.device ?? "desktop"],
    colorScheme: options.theme ?? "dark",
  };
  try {
    return await chromium.launchPersistentContext(profileDirectory, launchOptions);
  } catch (error) {
    if (!/Executable doesn't exist/u.test(String(error))) throw error;
    const executablePath = newestInstalledHeadlessShell();
    if (executablePath === undefined) {
      throw new Error(
        "no Chromium headless shell found: run `npx playwright-core install chromium-headless-shell`",
        { cause: error },
      );
    }
    return chromium.launchPersistentContext(profileDirectory, { ...launchOptions, executablePath });
  }
}

/** Mints a standard-scope pairing URL against the dev server whose home is `baseDir`. */
function mintPairingUrl(baseDir: string): string {
  const result = NodeChildProcess.spawnSync(
    "node",
    ["apps/server/src/bin.ts", "pair", "--base-dir", baseDir],
    { cwd: repositoryRoot, encoding: "utf8", env: toolchainEnvironment(repositoryRoot) },
  );
  const pairUrl = /Pair(?:ing)? URL: (\S+)/u.exec(`${result.stdout}${result.stderr}`)?.[1];
  if (pairUrl === undefined) {
    throw new Error(
      `could not mint a pairing token: is a dev server running with home ${baseDir}?\n${result.stdout}${result.stderr}`,
    );
  }
  return pairUrl;
}

function readOrigins(): Record<string, string> {
  try {
    return JSON.parse(NodeFS.readFileSync(originsFile, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberOrigin(baseDir: string, origin: string): void {
  NodeFS.writeFileSync(
    originsFile,
    JSON.stringify({ ...readOrigins(), [baseDir]: origin }, null, 2),
  );
}

/**
 * Waits until the app decided where the session belongs. The page's load event is
 * not that receipt: React replaces the boot splash, then the router resolves auth
 * asynchronously and may still redirect to `/pair`. Settled means the splash is gone
 * and the URL held still for a second.
 */
async function waitForAppToSettle(page: Page): Promise<void> {
  // A string, because it runs in the page: the scripts package has no DOM types.
  await page.waitForFunction('document.getElementById("boot-shell") === null', null, {
    timeout: SETTLE_TIMEOUT_MS,
  });
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previousUrl = page.url();
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    if (page.url() === previousUrl) return;
    previousUrl = page.url();
  }
}

/** Whether the cached origin answered and the app kept the session; false means pair again. */
async function openWithExistingSession(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url);
  } catch {
    return false;
  }
  await waitForAppToSettle(page);
  return !new URL(page.url()).pathname.startsWith("/pair");
}

export async function openMesuraPage(options: OpenMesuraPageOptions = {}): Promise<MesuraPage> {
  const route = options.route ?? "/";
  const baseDir = NodePath.resolve(options.baseDir ?? defaultBaseDir);
  NodeFS.mkdirSync(profileDirectory, { recursive: true });
  const context = await launchContext(options);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    let origin = options.origin ?? readOrigins()[baseDir];
    const hasSession =
      origin !== undefined &&
      (await openWithExistingSession(page, new URL(route, origin).toString()));
    if (!hasSession) {
      const minted = new URL(mintPairingUrl(baseDir));
      origin = options.origin ?? minted.origin;
      // The token is not bound to an origin, so an explicit origin pairs on itself.
      await page.goto(new URL(`${minted.pathname}${minted.hash}`, origin).toString());
      await page.waitForURL((url) => !url.pathname.startsWith("/pair"), {
        timeout: PAIR_TIMEOUT_MS,
      });
      rememberOrigin(baseDir, origin);
      await page.goto(new URL(route, origin).toString());
      await waitForAppToSettle(page);
    }
    return { page, context, origin: origin!, close: () => context.close() };
  } catch (error) {
    // The caller never receives `close` when setup fails; release the profile here.
    await context.close().catch(() => undefined);
    throw error;
  }
}
