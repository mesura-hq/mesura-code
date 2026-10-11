// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Browser automation helper for agents; no Effect runtime.
/**
 * A paired, headless browser on this worktree's dev server, for agents verifying
 * UI. Every session used to rebuild the same throwaway Playwright script: find a
 * browser binary, mint a pairing token, pair, emulate a phone, set the theme. This
 * module is that script, once.
 *
 *   import { openMesuraPage } from "<repo>/scripts/lib/mesura-browser.ts";
 *   const { page, close } = await openMesuraPage({ route: "/", device: "phone" });
 *
 * - The profile lives in the worktree's gitignored `.t3/browser-profile`, so the
 *   pairing survives a reboot that clears `/tmp`. One process may hold it at a time.
 * - Pairing mints its own token with `apps/server/src/bin.ts pair`; it never opens
 *   a URL handed to the developer.
 * - Dark is the default theme because it is the developer's: a probe in the light
 *   theme once passed a focus ring that was plainly visible in the dark one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type BrowserContext, type Page, chromium, devices } from "playwright-core";

import { toolchainEnvironment } from "./mesura-toolchain.ts";

export type MesuraDevice = "desktop" | "phone";

export interface OpenMesuraPageOptions {
  /** App path to open after pairing, for example `/` or `/<environmentId>/<threadId>`. */
  readonly route?: string;
  readonly device?: MesuraDevice;
  readonly theme?: "dark" | "light";
  /** Dev server web origin. Defaults to the origin of the last pairing in this profile. */
  readonly origin?: string;
  /** Passed to `pair --base-dir` when the server was started with `--home-dir`. */
  readonly baseDir?: string;
}

export interface MesuraPage {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..", "..");
const profileDirectory = NodePath.join(repositoryRoot, ".t3", "browser-profile");
const originFile = NodePath.join(profileDirectory, "mesura-origin");
const PAIR_TIMEOUT_MS = 30_000;

const DEVICE_OPTIONS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: devices["Pixel 7"],
} as const;

/**
 * The headless shell this `playwright-core` expects, or else the newest one in the
 * Playwright cache. Agents on this host install browsers with other Playwright
 * versions, so the exact revision is often missing while a newer one works.
 */
function resolveChromiumExecutable(): string | undefined {
  if (NodeFS.existsSync(chromium.executablePath())) return undefined;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    NodePath.join(NodeOS.homedir(), ".cache", "ms-playwright");
  const newest = NodeFS.existsSync(cache)
    ? NodeFS.readdirSync(cache)
        .filter((entry) => entry.startsWith("chromium_headless_shell-"))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .at(-1)
    : undefined;
  if (newest === undefined) {
    throw new Error(
      "no Chromium headless shell found: run `npx playwright-core install chromium-headless-shell`",
    );
  }
  return NodePath.join(cache, newest, "chrome-headless-shell-linux64", "chrome-headless-shell");
}

/** Mints a standard-scope pairing URL against the running dev server. */
function mintPairingUrl(baseDir: string | undefined): string {
  const result = NodeChildProcess.spawnSync(
    "node",
    ["apps/server/src/bin.ts", "pair", ...(baseDir === undefined ? [] : ["--base-dir", baseDir])],
    { cwd: repositoryRoot, encoding: "utf8", env: toolchainEnvironment(repositoryRoot) },
  );
  const pairUrl = /Pair(?:ing)? URL: (\S+)/u.exec(`${result.stdout}${result.stderr}`)?.[1];
  if (pairUrl === undefined) {
    throw new Error(
      `could not mint a pairing token (is this worktree's dev server running?):\n${result.stdout}${result.stderr}`,
    );
  }
  return pairUrl;
}

function isPairingScreen(page: Page): boolean {
  return new URL(page.url()).pathname.startsWith("/pair");
}

export async function openMesuraPage(options: OpenMesuraPageOptions = {}): Promise<MesuraPage> {
  const route = options.route ?? "/";
  NodeFS.mkdirSync(profileDirectory, { recursive: true });
  const executablePath = resolveChromiumExecutable();
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true,
    ...(executablePath === undefined ? {} : { executablePath }),
    ...DEVICE_OPTIONS[options.device ?? "desktop"],
    colorScheme: options.theme ?? "dark",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  let origin =
    options.origin ??
    (NodeFS.existsSync(originFile) ? NodeFS.readFileSync(originFile, "utf8").trim() : undefined);

  if (origin !== undefined) {
    await page.goto(new URL(route, origin).toString());
    await page.waitForLoadState("domcontentloaded");
  }
  if (origin === undefined || isPairingScreen(page)) {
    const pairUrl = mintPairingUrl(options.baseDir);
    origin = new URL(pairUrl).origin;
    await page.goto(pairUrl);
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: PAIR_TIMEOUT_MS });
    NodeFS.writeFileSync(originFile, origin);
    await page.goto(new URL(route, origin).toString());
  }
  return { page, context, origin, close: () => context.close() };
}
