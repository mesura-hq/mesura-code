import { describe, expect, it, vi } from "vitest";

import {
  type BlockableSession,
  isDocumentRequest,
  mayNavigateTo,
  type NavigableContents,
  refuseDocumentRequestsOffScheme,
  refuseNavigationAwayFromApp,
} from "../src/main/frameNavigation.ts";

/**
 * A previewed document may be loaded. It may not go anywhere afterwards.
 *
 * Verification found the gap this closes: the preview frame withholds
 * `allow-top-navigation`, `allow-popups` and `allow-forms`, and all three hold
 * — but none of them covers the frame navigating ITSELF. A plain link click
 * inside a previewed page replaced the frame's document with a remote site,
 * observed as an error page only because the machine had no route to the
 * internet. On an ordinary machine it would have fetched the page: a request
 * leaving the machine because a cursor passed over a file.
 */

describe("where a frame may go", () => {
  it.each([
    ["the renderer's own entry point", "symmetria-fm://app/index.html"],
    ["a previewed file", "symmetria-fm://app/__preview/abc123"],
    ["a neighbour under a directory grant", "symmetria-fm://app/__preview/abc123/style.css"],
    [
      "Chromium's own PDF viewer, which an embed loads into a child frame",
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
    ],
  ])("permits %s", (_why, url) => {
    expect(mayNavigateTo(url)).toBe(true);
  });

  it("permits the built-in viewer and no other extension", () => {
    // The exception is one host, not a scheme. `chrome-extension:` opened as a
    // whole would admit anything a future `session.loadExtension` installed,
    // which is a wider grant than the PDF preview ever asked for.
    expect(mayNavigateTo("chrome-extension://someotherextensionidhere00000000/index.html")).toBe(
      false,
    );
  });

  it("does not admit an opaque origin as if it were the viewer", () => {
    // `chrome-extension` is not a special scheme, so `new URL(...).origin` is
    // the string "null" for every one of these. A guard written against
    // `origin` would therefore let each of them past.
    expect(mayNavigateTo("data:text/html,<h1>hi")).toBe(false);
    expect(mayNavigateTo("chrome-untrusted://print/")).toBe(false);
  });

  it.each([
    ["a remote page", "https://example.com/"],
    ["an insecure remote page", "http://example.com/"],
    ["the filesystem", "file:///etc/passwd"],
    ["a data url", "data:text/html,<h1>hi"],
    ["a script url", "javascript:alert(1)"],
    ["a blob", "blob:symmetria-fm://app/abc"],
    ["a mail client", "mailto:someone@example.com"],
    ["an arbitrary desktop handler", "tel:+123456"],
    ["something that is not a URL at all", "not a url"],
    ["nothing", ""],
  ])("refuses %s", (_why, url) => {
    expect(mayNavigateTo(url)).toBe(false);
  });

  it("names the scheme rather than listing what to block", () => {
    // An allow-list, not a deny-list. A scheme nobody thought of — one a future
    // Electron or a future handler introduces — is refused by default rather
    // than permitted until somebody notices.
    expect(mayNavigateTo("some-future-scheme://app/x")).toBe(false);
  });
});

/**
 * A `NavigableContents` under test, with the two questions to ask it.
 *
 * Named rather than written inline on the helper's return type: an anonymous
 * shape declared at a return says the same thing while discarding what the
 * body already proved, and it has nowhere to carry this sentence.
 */
interface ContentsSpy {
  readonly contents: NavigableContents;
  /** Drive one navigation and report whether it was prevented. */
  readonly navigate: (url: string) => boolean;
  /** Was a handler installed, and does it deny? */
  readonly openHandlerInstalled: () => boolean;
}

describe("what the window is told", () => {
  function spy(): ContentsSpy {
    let listener: ((d: { url: string; preventDefault(): void }) => void) | null = null;
    let openHandler: ((d: { url: string }) => { action: "deny" }) | null = null;

    const contents: NavigableContents = {
      on: (_event, l) => {
        listener = l;
        return contents;
      },
      setWindowOpenHandler: (h) => {
        openHandler = h;
      },
    };

    return {
      contents,
      navigate: (url) => {
        let prevented = false;
        listener?.({ url, preventDefault: () => (prevented = true) });
        return prevented;
      },
      openHandlerInstalled: () =>
        openHandler !== null && openHandler({ url: "x" }).action === "deny",
    };
  }

  it("prevents a navigation off the application's own scheme", () => {
    const { contents, navigate } = spy();
    refuseNavigationAwayFromApp(contents);

    expect(navigate("https://example.com/")).toBe(true);
  });

  it("lets the frame move between previewed documents", () => {
    // The frame's own initial load and every move from one previewed file to
    // the next go through this same event. Blocking those would block the
    // feature rather than the hole.
    const { contents, navigate } = spy();
    refuseNavigationAwayFromApp(contents);

    expect(navigate("symmetria-fm://app/__preview/token/page.html")).toBe(false);
  });

  it("listens on the FRAME event, not the top-level one", () => {
    // `will-navigate` fires only for the top frame, and the whole point here is
    // the child frame a previewed page lives in. A guard on the wrong event
    // passes every test that only checks a handler was installed.
    const on = vi.fn();
    refuseNavigationAwayFromApp({ on, setWindowOpenHandler: () => undefined });

    expect(on).toHaveBeenCalledWith("will-frame-navigate", expect.any(Function));
  });

  it("denies every request to open a window", () => {
    // The frame withholds `allow-popups`, so nothing should reach this. Denying
    // anyway means a later change to that permission list cannot open a window
    // by accident.
    const { contents, openHandlerInstalled } = spy();
    refuseNavigationAwayFromApp(contents);

    expect(openHandlerInstalled()).toBe(true);
  });
});

/**
 * The request-level block, which is the half that actually holds.
 *
 * The contents-level handler above was tried first and, measured against a
 * real Electron 41 twice, did not intercept a link click at all. Review found
 * the likely reason: Electron's pre-navigation events have a long-standing
 * defect where they do not fire for a window created with
 * `webPreferences.sandbox: true` — which this application sets deliberately.
 * `onBeforeRequest` runs beneath that layer and is not subject to it.
 */
/** A `BlockableSession` under test, with the one question to ask it. */
interface SessionSpy {
  readonly session: BlockableSession;
  /** Drive one request and report whether it was cancelled. */
  readonly request: (url: string, resourceType: string) => boolean;
}

describe("which requests are refused", () => {
  function session(): SessionSpy {
    let listener:
      | ((d: { url: string; resourceType: string }, cb: (r: { cancel?: boolean }) => void) => void)
      | null = null;

    return {
      session: { webRequest: { onBeforeRequest: (l) => (listener = l) } },
      request: (url, resourceType) => {
        let cancelled = false;
        listener?.({ url, resourceType }, (response) => {
          cancelled = response.cancel === true;
        });
        return cancelled;
      },
    };
  }

  it.each([
    ["a top-level document", "mainFrame"],
    ["a framed document", "subFrame"],
  ])("cancels %s leaving the application's scheme", (_why, resourceType) => {
    const { session: s, request } = session();
    refuseDocumentRequestsOffScheme(s);

    expect(request("https://example.com/", resourceType)).toBe(true);
  });

  it("lets a previewed document through", () => {
    const { session: s, request } = session();
    refuseDocumentRequestsOffScheme(s);

    expect(request("symmetria-fm://app/__preview/token/page.html", "subFrame")).toBe(false);
  });

  it("lets Chromium's own PDF viewer load", () => {
    // ── The regression this file exists to prevent a second time ────────────
    // An `<embed type="application/pdf">` is answered by loading an internal
    // extension page into a child frame. Blocking it cancelled that request
    // with `net::ERR_BLOCKED_BY_CLIENT` and left the PDF preview a blank
    // rectangle — with the embed element still present and correct, so nothing
    // in the DOM said anything was wrong.
    //
    // This test pins OUR rule, which is what broke. It cannot pin Chromium's
    // — if the viewer's extension id ever changes, the preview goes blank
    // again and this test still passes.
    const { session: s, request } = session();
    refuseDocumentRequestsOffScheme(s);

    expect(
      request("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html", "subFrame"),
    ).toBe(false);
  });

  it.each([
    ["an image", "image"],
    ["a stylesheet", "stylesheet"],
    ["a font", "font"],
    ["a script", "script"],
    ["a fetch", "xhr"],
  ])("leaves %s to the content policy rather than cancelling it here", (_why, resourceType) => {
    // A subresource is already governed by the policy the main process serves
    // with each document, which refuses every remote origin. Cancelling them
    // here as well would be a second, blunter copy of a rule that already
    // lives somewhere better — and it would be the copy that drifts.
    const { session: s, request } = session();
    refuseDocumentRequestsOffScheme(s);

    expect(request("https://example.com/tracker.png", resourceType)).toBe(false);
  });

  it("knows which request types replace a document", () => {
    expect(isDocumentRequest("mainFrame")).toBe(true);
    expect(isDocumentRequest("subFrame")).toBe(true);
    expect(isDocumentRequest("image")).toBe(false);
    expect(isDocumentRequest("stylesheet")).toBe(false);
  });
});
