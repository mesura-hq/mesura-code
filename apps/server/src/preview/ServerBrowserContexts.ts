// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import {
  type BrowserImportResult,
  type ImportedCookie,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import { matchPaymentDomain } from "@t3tools/shared/paymentDomains";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

type PlaywrightCookie = Parameters<BrowserContext["addCookies"]>[0][number];

const PLAYWRIGHT_SAME_SITE = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
  // Chrome treats a cookie without SameSite as Lax.
  unspecified: "Lax",
} as const satisfies Record<ImportedCookie["sameSite"], PlaywrightCookie["sameSite"]>;

const cookieHost = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

// Always domain + path: Playwright rewrites a `url` cookie's path to the url's directory and
// its Secure flag to the url's scheme. Chrome keeps a domain without a leading dot host-only.
const toPlaywrightCookie = (cookie: ImportedCookie): PlaywrightCookie => {
  const sameSite = PLAYWRIGHT_SAME_SITE[cookie.sameSite];
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain?.startsWith(".") ? cookie.domain : cookieHost(cookie.url),
    path: cookie.path,
    expires: cookie.expirationDate ?? -1,
    httpOnly: cookie.httpOnly,
    // Chrome drops SameSite=None without Secure.
    secure: cookie.secure || sameSite === "None",
    sameSite,
  };
};

const MAX_REPORTED_SKIPPED_DOMAINS = 20;

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  /** Operations that still use a persistent context; an idle close waits for none. */
  private readonly leases = new Map<string, number>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    await this.closeProfileContext(profileId, () =>
      NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true }),
    );
  }

  /** Requests for the profile wait until the close and `afterClose` finish, then reopen it. */
  private async closeProfileContext(profileId: string, afterClose?: () => Promise<void>) {
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await afterClose?.();
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  /** Writes through the live persistent context; Chrome holds the on-disk cookie store open. */
  private async withLease<A>(profileId: string, use: () => Promise<A>) {
    const key = JSON.stringify([profileId, null]);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    try {
      return await use();
    } finally {
      const remaining = (this.leases.get(key) ?? 1) - 1;
      if (remaining === 0) this.leases.delete(key);
      else this.leases.set(key, remaining);
    }
  }

  /** Opens a page, keeping an import from closing the context before the page exists. */
  async openPage(
    profileId: string,
    isolationKey: string | undefined,
    prepare: (context: BrowserContext) => Promise<void>,
  ) {
    const open = async () => {
      const context = await this.contextFor(profileId, isolationKey);
      await prepare(context);
      return context.newPage();
    };
    return isolationKey === undefined ? this.withLease(profileId, open) : open();
  }

  /** Writes through the live persistent context; Chrome holds the on-disk cookie store open. */
  async importCookies(
    profileId: string,
    cookies: ReadonlyArray<ImportedCookie>,
    paymentDomains: ReadonlyArray<string>,
  ): Promise<BrowserImportResult> {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      throw new Error("Cookies cannot be imported into the incognito profile.");
    }
    const key = JSON.stringify([profileId, null]);
    let imported = 0;
    let skipped = 0;
    const skippedDomains = new Set<string>();
    const skip = (cookie: ImportedCookie) => {
      skipped += 1;
      skippedDomains.add(cookieHost(cookie.url));
    };
    const pending = this.contextFor(profileId);
    const context = await this.withLease(profileId, async () => {
      const context = await pending;
      for (const cookie of cookies) {
        const written = toPlaywrightCookie(cookie);
        if (matchPaymentDomain(written.domain ?? "", paymentDomains) !== undefined) {
          skip(cookie);
          continue;
        }
        // One at a time, so a cookie Chrome rejects does not drop the rest.
        const added = await context.addCookies([written]).then(
          () => true,
          () => false,
        );
        if (added) imported += 1;
        else skip(cookie);
      }
      return context;
    });
    // Chrome commits cookies to disk only on a graceful close or about 30 s later, and a
    // service stop signals Chrome itself, which drops uncommitted ones. Closing an idle
    // profile makes the import durable now; a profile with open tabs commits on Chrome's timer.
    const idle =
      this.contexts.get(key) === pending && !this.leases.has(key) && context.pages().length === 0;
    if (imported > 0 && idle) await this.closeProfileContext(profileId);
    return {
      imported,
      skipped,
      skippedDomains: [...skippedDomains].slice(0, MAX_REPORTED_SKIPPED_DOMAINS),
    };
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
