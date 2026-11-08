// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Isolated HTTP and Chromium fixtures; no Effect runtime in the browser harness.
/** Exercises openMesuraPage with real Chromium; no installed app, server, or profile is used. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { chromium, devices, type BrowserContext } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { MesuraPage } from "./mesura-browser.ts";

const FIXTURE_TOKEN = "fixture-only+token&value";
const THREAD_ROUTE = "/fixture-environment/fixture-thread";

// Like PairingRouteSurface, this form captures the token only when the document
// initializes. A later same-document hash navigation cannot populate that capture.
const PAIR_DOCUMENT = `<!doctype html>
<form id="pair-form"><input id="pairing-token"></form>
<script>
  const tokenAtMount = new URLSearchParams(location.hash.slice(1)).get("token");
  document.getElementById("pairing-token").value = tokenAtMount ?? "";
  if (tokenAtMount) {
    history.replaceState(null, "", location.pathname);
    fetch("/api/auth/browser-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: tokenAtMount })
    }).then(response => {
      if (response.ok) location.replace(${JSON.stringify(THREAD_ROUTE)});
    });
  }
</script>`;

describe("Mesura browser Chromium pairing recovery", () => {
  let isolatedHome: string;
  let baseDir: string;
  let origin: string;
  let server: NodeHttp.Server | undefined;
  let openMesuraPage: (typeof import("./mesura-browser.ts"))["openMesuraPage"];
  let opened: MesuraPage | undefined;
  let contexts: BrowserContext[];
  let pairDocuments: number;
  let unauthenticatedThreads: number;
  let credentials: unknown[];
  let mintPairingUrl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    isolatedHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-browser-auth-"));
    baseDir = NodePath.join(isolatedHome, "fixture-server-home");
    opened = undefined;
    contexts = [];
    pairDocuments = 0;
    unauthenticatedThreads = 0;
    credentials = [];

    server = NodeHttp.createServer(async (request, response) => {
      response.setHeader("cache-control", "no-store");
      if (request.url === "/api/auth/browser-session" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const credential = (JSON.parse(body) as { credential: unknown }).credential;
        credentials.push(credential);
        if (credential !== FIXTURE_TOKEN) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader(
          "set-cookie",
          "fixture-session=paired; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax",
        );
        response.writeHead(204).end();
      } else if (request.url === THREAD_ROUTE) {
        if (request.headers.cookie?.includes("fixture-session=paired")) {
          response.setHeader("content-type", "text/html");
          response.end('<main id="paired-thread">Fixture thread</main>');
        } else {
          unauthenticatedThreads += 1;
          response.writeHead(302, { location: "/pair" }).end();
        }
      } else if (request.url === "/pair") {
        pairDocuments += 1;
        response.setHeader("content-type", "text/html");
        response.end(PAIR_DOCUMENT);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Fixture has no port");
    origin = `http://127.0.0.1:${address.port}`;

    const launchPersistentContext = chromium.launchPersistentContext.bind(chromium);
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async (directory, options) => {
      const context = await launchPersistentContext(directory, options);
      contexts.push(context);
      return context;
    });
    mintPairingUrl = vi.fn(() => ({
      stdout: `Pair URL: http://minted-origin.invalid/pair#token=${encodeURIComponent(FIXTURE_TOKEN)}`,
      stderr: "",
    }));
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof NodeChildProcess>()),
      spawnSync: mintPairingUrl,
    }));
    vi.doMock("@t3tools/shared/devHome", () => ({
      resolveWorktreeT3Home: () => Effect.succeed(isolatedHome),
    }));
    vi.resetModules();
    ({ openMesuraPage } = await import("./mesura-browser.ts"));
  });

  afterEach(async () => {
    try {
      // Capture every actual launch, including a context setup fails to return.
      for (const context of contexts) await context.close();
    } finally {
      if (server !== undefined) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
        });
      }
      vi.doUnmock("node:child_process");
      vi.doUnmock("@t3tools/shared/devHome");
      vi.restoreAllMocks();
      NodeFS.rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("pairs after an empty pair redirect and reuses the resulting session in real Chromium", async () => {
    opened = await openMesuraPage({ baseDir, origin, route: THREAD_ROUTE, device: "phone" });
    expect(unauthenticatedThreads).toBe(1);
    expect(pairDocuments).toBe(2);
    expect(credentials).toEqual([FIXTURE_TOKEN]);
    expect(opened.origin).toBe(origin);
    expect(opened.page.url()).toBe(`${origin}${THREAD_ROUTE}`);
    expect(await opened.page.locator("#paired-thread").textContent()).toBe("Fixture thread");
    expect(await opened.page.locator("#pair-form").count()).toBe(0);
    expect(opened.page.viewportSize()).toEqual(devices["Pixel 7"].viewport);
    expect(await opened.page.evaluate('matchMedia("(prefers-color-scheme: dark)").matches')).toBe(
      true,
    );
    expect(mintPairingUrl).toHaveBeenCalledExactlyOnceWith(
      "node",
      ["apps/server/src/bin.ts", "pair", "--base-dir", baseDir],
      expect.objectContaining({ encoding: "utf8" }),
    );
    await opened.close();

    // Reopen the same isolated persistent profile without supplying its origin.
    opened = await openMesuraPage({
      baseDir,
      route: THREAD_ROUTE,
      device: "desktop",
      theme: "light",
    });
    expect(opened.page.url()).toBe(`${origin}${THREAD_ROUTE}`);
    expect(await opened.page.locator("#paired-thread").textContent()).toBe("Fixture thread");
    expect(opened.page.viewportSize()).toEqual({ width: 1440, height: 900 });
    expect(await opened.page.evaluate('matchMedia("(prefers-color-scheme: light)").matches')).toBe(
      true,
    );
    expect(mintPairingUrl).toHaveBeenCalledTimes(1);
    expect(unauthenticatedThreads).toBe(1);
    expect(pairDocuments).toBe(2);
    expect(credentials).toEqual([FIXTURE_TOKEN]);
    await opened.close();
  });

  it("releases the real Chromium profile when pairing setup fails before returning a close handle", async () => {
    mintPairingUrl.mockImplementationOnce(() => {
      throw new Error("Fixture token mint failed");
    });
    await expect(openMesuraPage({ baseDir, origin, route: THREAD_ROUTE })).rejects.toThrow(
      "Fixture token mint failed",
    );
    expect(contexts.at(-1)?.browser()?.isConnected()).toBe(false);
    expect(credentials).toEqual([]);

    opened = await openMesuraPage({ baseDir, origin, route: THREAD_ROUTE });
    expect(opened.page.url()).toBe(`${origin}${THREAD_ROUTE}`);
    expect(await opened.page.locator("#paired-thread").textContent()).toBe("Fixture thread");
    expect(credentials).toEqual([FIXTURE_TOKEN]);
    await opened.close();
  });
});
