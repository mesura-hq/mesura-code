import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    contexts,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

const withLauncher = () => {
  const release = vi.fn(async () => {});
  return {
    release,
    configuration: {
      ...options(),
      launcher: vi.fn(async (executable: string) => ({ path: `${executable}-launcher`, release })),
    },
  };
};

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    const started = Promise.withResolvers<void>();
    launches.launch.mockImplementation(() => {
      started.resolve();
      return launch.promise;
    });
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await started.promise;
    // Playwright may retry the same path until the launch settles.
    expect(release).not.toHaveBeenCalled();
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executablePath: "/test/chromium-launcher" }),
    );
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium-launcher" }),
    );
    expect(release).toHaveBeenCalledTimes(2);
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("diagnoses a launcher failure against the real executable", async () => {
    const diagnosed = new Error("diagnosed");
    const diagnose = vi.fn(async () => diagnosed);
    const pool = new ServerBrowserContexts({
      ...options(),
      diagnose,
      launcher: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    await expect(pool.contextFor("default", "agent")).rejects.toBe(diagnosed);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("/test/chromium", expect.any(Error));
    expect(launches.launch).not.toHaveBeenCalled();
  });

  it("creates no launcher for a profile whose storage cannot be created", async () => {
    launches.mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const { configuration } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    await expect(pool.contextFor("work/team")).rejects.toThrow("EACCES");
    expect(configuration.launcher).not.toHaveBeenCalled();
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("waits for the context to close when the same profile is cleared concurrently", async () => {
    const human = makeContext();
    const closed = Promise.withResolvers<void>();
    human.close.mockImplementation(async () => closed.promise);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work/team");

    const first = pool.clearProfile("work/team");
    const second = pool.clearProfile("work/team");
    const deletionsBeforeClose = launches.rm.mock.calls.length;
    closed.resolve();
    await Promise.all([first, second]);

    expect(deletionsBeforeClose).toBe(0);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.contexts[0]?.close).toHaveBeenCalled();
  });
});

type PlaywrightCookie = Parameters<BrowserContext["addCookies"]>[0][number];

// Models Chrome's cookie store: added cookies live in memory and reach the per-directory
// store on disk only when the context closes gracefully, so `crash` loses them.
const cookieStores = new Map<string, PlaywrightCookie[]>();
// Playwright's rewriteCookies: a url sets the domain, the url's directory as path, and Secure
// from the scheme, overriding what the caller passed.
const asPlaywrightSends = (cookie: PlaywrightCookie): PlaywrightCookie => {
  if (!cookie.url) return cookie;
  const { url: _url, ...rest } = cookie;
  const url = new URL(cookie.url);
  return {
    ...rest,
    domain: url.hostname,
    path: url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1),
    secure: url.protocol === "https:",
  };
};

const makeCookieContext = (directory: string, reject?: (cookie: PlaywrightCookie) => boolean) => {
  const context = makeContext();
  const inMemory = [...(cookieStores.get(directory) ?? [])];
  const openPages: unknown[] = [];
  let closed = false;
  const addCookies = vi.fn(async (cookies: ReadonlyArray<PlaywrightCookie>) => {
    if (closed) throw new Error("Target page, context or browser has been closed");
    for (const cookie of cookies) {
      // Playwright's own validation of an addCookies entry.
      if (!cookie.url && !(cookie.domain && cookie.path))
        throw new Error("Cookie should have a url or a domain/path pair");
      if (cookie.url && cookie.domain) throw new Error("Cookie should have either url or domain");
      if (cookie.url && cookie.path) throw new Error("Cookie should have either url or path");
      if (reject?.(cookie)) throw new Error(`Chrome rejected ${cookie.name}`);
    }
    for (const cookie of cookies.map(asPlaywrightSends)) {
      // Chrome drops SameSite=None without Secure, and Storage.setCookies still succeeds.
      if (cookie.sameSite === "None" && !cookie.secure) continue;
      const replaced = inMemory.findIndex(
        (stored) =>
          stored.name === cookie.name &&
          stored.domain === cookie.domain &&
          stored.path === cookie.path,
      );
      if (replaced === -1) inMemory.push(cookie);
      else inMemory[replaced] = cookie;
    }
  });
  const newPage = vi.fn(async () => {
    if (closed) throw new Error("Target page, context or browser has been closed");
    const page = {};
    openPages.push(page);
    return page;
  });
  const cookies = vi.fn(async () => [...inMemory]);
  const gracefulClose = context.close;
  const close = vi.fn(async () => {
    if (!closed) cookieStores.set(directory, [...inMemory]);
    closed = true;
    await gracefulClose();
  });
  const crash = () => {
    closed = true;
    return gracefulClose();
  };
  context.pages.mockImplementation(() => openPages as never[]);
  return Object.assign(context, { addCookies, cookies, close, crash, newPage, openPages });
};

const openCookieContexts = (reject?: (cookie: PlaywrightCookie) => boolean) => {
  const opened: ReturnType<typeof makeCookieContext>[] = [];
  launches.persistent.mockImplementation(async (directory) => {
    const context = makeCookieContext(directory, reject);
    opened.push(context);
    return context as unknown as BrowserContext;
  });
  return opened;
};

const importedCookie = (
  overrides: Partial<{
    url: string;
    name: string;
    value: string;
    domain: string | undefined;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expirationDate: number | undefined;
    sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  }> = {},
) => ({
  url: "https://example.test/",
  name: "session",
  value: "abc",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: 1_800_000_000,
  sameSite: "lax" as const,
  ...overrides,
});

describe("ServerBrowserContexts.importCookies", () => {
  beforeEach(() => cookieStores.clear());

  it("imports cookies into the persistent context of the named profile", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const result = await pool.importCookies("work/team", [importedCookie()], []);
    expect(result).toEqual({ imported: 1, skipped: 0, skippedDomains: [] });
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.anything(),
    );
    expect(launches.launch).not.toHaveBeenCalled();
    expect(opened[0]!.addCookies).toHaveBeenCalledOnce();
    expect(cookieStores.get("/test/profiles/work%2Fteam")).toEqual([
      expect.objectContaining({ name: "session", value: "abc" }),
    ]);
    await pool.close();
  });

  it("skips cookies of payment domains and reports their hosts", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const result = await pool.importCookies(
      "default",
      [
        importedCookie({ url: "https://www.paypal.com/", name: "paypal-host" }),
        importedCookie({ url: "https://paypal.com/", domain: ".paypal.com", name: "paypal-dom" }),
        importedCookie({ url: "https://github.com/", name: "kept" }),
      ],
      ["paypal.com"],
    );
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect([...result.skippedDomains].sort()).toEqual(["paypal.com", "www.paypal.com"]);
    const written = opened[0]!.addCookies.mock.calls.flatMap(([cookies]) => cookies);
    expect(written.map((cookie) => cookie.name)).toEqual(["kept"]);
    await pool.close();
  });

  it("counts a cookie Chrome rejects as skipped and still imports the others", async () => {
    const opened = openCookieContexts((cookie) => cookie.name === "rejected");
    const pool = new ServerBrowserContexts(options());
    const result = await pool.importCookies(
      "default",
      [
        importedCookie({ url: "https://a.example/", name: "first" }),
        importedCookie({ url: "https://bad.example/", name: "rejected" }),
        importedCookie({ url: "https://b.example/", name: "last" }),
      ],
      [],
    );
    expect(result).toEqual({ imported: 2, skipped: 1, skippedDomains: ["bad.example"] });
    expect(opened[0]!.addCookies).toHaveBeenCalledTimes(3);
    expect(cookieStores.get("/test/profiles/default")?.map((cookie) => cookie.name)).toEqual([
      "first",
      "last",
    ]);
    await pool.close();
  });

  it("keeps host-only cookies on their exact host and domain cookies on their leading-dot domain", async () => {
    openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.importCookies(
      "default",
      [
        importedCookie({
          url: "https://app.example.test/account",
          name: "__Host-id",
          path: "/account",
        }),
        importedCookie({
          url: "https://example.test/docs",
          name: "wide",
          domain: ".example.test",
          path: "/docs",
        }),
      ],
      [],
    );
    const [hostOnly, wide] = cookieStores.get("/test/profiles/default") ?? [];
    expect(hostOnly).toMatchObject({
      name: "__Host-id",
      domain: "app.example.test",
      path: "/account",
    });
    expect(wide).toMatchObject({ name: "wide", domain: ".example.test", path: "/docs" });
    await pool.close();
  });

  it.each([
    { sameSite: "no_restriction", secure: false, expected: { sameSite: "None", secure: true } },
    { sameSite: "lax", secure: false, expected: { sameSite: "Lax", secure: false } },
    { sameSite: "strict", secure: true, expected: { sameSite: "Strict", secure: true } },
    { sameSite: "unspecified", secure: false, expected: { sameSite: "Lax", secure: false } },
  ] as const)(
    "maps an imported SameSite $sameSite cookie onto Chrome's $expected.sameSite",
    async ({ sameSite, secure, expected }) => {
      openCookieContexts();
      const pool = new ServerBrowserContexts(options());
      await pool.importCookies("default", [importedCookie({ sameSite, secure })], []);
      expect(cookieStores.get("/test/profiles/default")?.[0]).toMatchObject(expected);
      await pool.close();
    },
  );

  it("maps an imported expiry in seconds and keeps a session cookie a session cookie", async () => {
    openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.importCookies(
      "default",
      [
        importedCookie({ name: "persistent", expirationDate: 1_800_000_000 }),
        importedCookie({ name: "session-only", expirationDate: undefined }),
      ],
      [],
    );
    const [persistent, sessionOnly] = cookieStores.get("/test/profiles/default") ?? [];
    expect(persistent).toMatchObject({ expires: 1_800_000_000, httpOnly: true, value: "abc" });
    expect(sessionOnly).toMatchObject({ expires: -1 });
    await pool.close();
  });

  it("reports the import result as imported, skipped and skippedDomains only", async () => {
    openCookieContexts((cookie) => cookie.name === "rejected");
    const pool = new ServerBrowserContexts(options());
    const result = await pool.importCookies(
      "default",
      [
        importedCookie({ name: "kept" }),
        importedCookie({ url: "https://stripe.com/", name: "pay" }),
        importedCookie({ url: "https://broken.example/", name: "rejected" }),
      ],
      ["stripe.com"],
    );
    expect(result).toStrictEqual({
      imported: 1,
      skipped: 2,
      skippedDomains: ["stripe.com", "broken.example"],
    });
    await pool.close();
  });

  it("refuses to import cookies into the incognito profile", async () => {
    openCookieContexts();
    launches.launch.mockResolvedValue(makeBrowser() as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(
      pool.importCookies(INCOGNITO_BROWSER_PROFILE_ID, [importedCookie()], []),
    ).rejects.toThrow();
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(launches.launch).not.toHaveBeenCalled();
    await pool.close();
  });

  it("imports cookies requested during a profile clear only after its storage is deleted", async () => {
    openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.importCookies("work/team", [importedCookie({ name: "old" })], []);
    const removed = Promise.withResolvers<void>();
    launches.rm.mockImplementationOnce(async (directory: string) => {
      await removed.promise;
      cookieStores.delete(directory);
    });
    const clearing = pool.clearProfile("work/team");
    const importing = pool.importCookies("work/team", [importedCookie({ name: "new" })], []);
    removed.resolve();
    await Promise.all([clearing, importing]);
    expect(cookieStores.get("/test/profiles/work%2Fteam")?.map((cookie) => cookie.name)).toEqual([
      "new",
    ]);
    await pool.close();
  });

  it("checks payment domains against the host the cookie is written to", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const result = await pool.importCookies(
      "default",
      [importedCookie({ url: "https://www.paypal.com/", domain: "github.com", name: "smuggled" })],
      ["paypal.com"],
    );
    expect(result).toEqual({ imported: 0, skipped: 1, skippedDomains: ["www.paypal.com"] });
    expect(opened[0]!.addCookies).not.toHaveBeenCalled();
    await pool.close();
  });

  it("keeps the path of host-only cookies, so same-name cookies on other paths survive", async () => {
    openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.importCookies(
      "default",
      [
        importedCookie({ url: "https://example.test/", name: "same", value: "root", path: "/" }),
        importedCookie({
          url: "https://example.test/app",
          name: "same",
          value: "app",
          path: "/app",
        }),
        importedCookie({ url: "https://example.test/", name: "__Host-id", path: "/" }),
      ],
      [],
    );
    const stored = cookieStores.get("/test/profiles/default") ?? [];
    expect(stored.map(({ name, value, domain, path }) => ({ name, value, domain, path }))).toEqual([
      { name: "same", value: "root", domain: "example.test", path: "/" },
      { name: "same", value: "app", domain: "example.test", path: "/app" },
      { name: "__Host-id", value: "abc", domain: "example.test", path: "/" },
    ]);
    await pool.close();
  });

  it("keeps SameSite=None cookies from an http url Secure so Chrome stores them", async () => {
    openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const result = await pool.importCookies(
      "default",
      [importedCookie({ url: "http://plain.test/", secure: false, sameSite: "no_restriction" })],
      [],
    );
    expect(result.imported).toBe(1);
    expect(cookieStores.get("/test/profiles/default")).toEqual([
      expect.objectContaining({ domain: "plain.test", sameSite: "None", secure: true }),
    ]);
    await pool.close();
  });

  it("does not close a profile whose tab is still opening when an import finishes", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const opening = pool.openPage("work/team", undefined, async () => {
      preparing.resolve();
      await prepared.promise;
    });
    await preparing.promise;
    await pool.importCookies("work/team", [importedCookie({ name: "during-open" })], []);
    prepared.resolve();
    await opening;
    expect(opened).toHaveLength(1);
    expect(opened[0]!.close).not.toHaveBeenCalled();
    expect(opened[0]!.openPages).toHaveLength(1);
    await pool.close();
  });

  it("closes an idle profile only after every concurrent import finishes writing", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work/team");
    const context = opened[0]!;
    const write = context.addCookies.getMockImplementation()!;
    const gate = Promise.withResolvers<void>();
    context.addCookies.mockImplementation(async (cookies) => {
      if (cookies[0]?.name === "slow") await gate.promise;
      return write(cookies);
    });
    const slow = pool.importCookies("work/team", [importedCookie({ name: "slow" })], []);
    const fast = await pool.importCookies("work/team", [importedCookie({ name: "fast" })], []);
    expect(fast.imported).toBe(1);
    expect(context.close).not.toHaveBeenCalled();
    gate.resolve();
    expect((await slow).imported).toBe(1);
    expect(context.close).toHaveBeenCalledOnce();
    expect(cookieStores.get("/test/profiles/work%2Fteam")?.map((cookie) => cookie.name)).toEqual([
      "fast",
      "slow",
    ]);
    await pool.close();
  });

  it("keeps a tab opened through openPage working after an import into its profile", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const tab = await pool.openPage("work/team", undefined, async () => {});
    await pool.importCookies("work/team", [importedCookie({ name: "for-tab" })], []);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.close).not.toHaveBeenCalled();
    expect(opened[0]!.openPages).toEqual([tab]);
    expect((await opened[0]!.cookies()).map((cookie) => cookie.name)).toEqual(["for-tab"]);
    await pool.openPage("work/team", undefined, async () => {});
    expect(opened).toHaveLength(1);
    expect(opened[0]!.openPages).toHaveLength(2);
    await pool.close();
  });

  it("reports each skipped host once and at most 20 of them", async () => {
    openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const paymentHosts = Array.from({ length: 25 }, (_, index) => `shop${index}.pay.test`);
    const result = await pool.importCookies(
      "default",
      [
        ...paymentHosts.map((host) => importedCookie({ url: `https://${host}/`, name: host })),
        importedCookie({ url: "https://shop0.pay.test/", name: "again" }),
      ],
      ["pay.test"],
    );
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(26);
    expect(result.skippedDomains).toEqual(paymentHosts.slice(0, 20));
    await pool.close();
  });

  it("writes a __Host- cookie host-only on the root path with Secure", async () => {
    openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.importCookies(
      "default",
      [importedCookie({ url: "https://login.example.test/", name: "__Host-session", path: "/" })],
      [],
    );
    expect(cookieStores.get("/test/profiles/default")).toEqual([
      expect.objectContaining({
        name: "__Host-session",
        domain: "login.example.test",
        path: "/",
        secure: true,
      }),
    ]);
    await pool.close();
  });

  it("puts imported cookies on disk before importCookies returns for a profile without tabs", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.importCookies("work/team", [importedCookie({ name: "durable" })], []);
    opened[0]!.crash();
    expect(cookieStores.get("/test/profiles/work%2Fteam")?.map((cookie) => cookie.name)).toEqual([
      "durable",
    ]);
    const reopened = await pool.contextFor("work/team");
    expect(reopened).not.toBe(opened[0]);
    expect((await reopened.cookies()).map((cookie) => cookie.name)).toEqual(["durable"]);
    await pool.close();
  });

  it("leaves a profile with open tabs open after importing cookies into it", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    const context = await pool.contextFor("work/team");
    opened[0]!.openPages.push({});
    await pool.importCookies("work/team", [importedCookie({ name: "live" })], []);
    expect(opened[0]!.close).not.toHaveBeenCalled();
    expect(await pool.contextFor("work/team")).toBe(context);
    expect((await context.cookies()).map((cookie) => cookie.name)).toEqual(["live"]);
    await pool.close();
  });

  it("keeps imported cookies after the profile's context is closed and reopened", async () => {
    const opened = openCookieContexts();
    const pool = new ServerBrowserContexts(options());
    await pool.importCookies("work/team", [importedCookie({ name: "remembered" })], []);
    await opened[0]!.close();
    const reopened = await pool.contextFor("work/team");
    expect(reopened).not.toBe(opened[0]);
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    expect((await reopened.cookies()).map((cookie) => cookie.name)).toEqual(["remembered"]);
    await pool.close();
  });
});
