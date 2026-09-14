import { APP_SCHEME_PROTOCOL } from "./appScheme.ts";

/**
 * A previewed document may be loaded. It may not go anywhere afterwards.
 *
 * ── Why the frame's permission list is not enough ───────────────────────────
 * Verification found this from outside. The preview frame withholds
 * `allow-top-navigation`, `allow-popups` and `allow-forms`, and all three hold:
 * a form submit inside a previewed page is refused and no second window can be
 * opened. What none of them covers is the frame navigating ITSELF. A plain link
 * click inside a previewed page replaced the frame's own document with a remote
 * site — observed as an error page only because the test machine had no route
 * to the internet. On an ordinary machine it would have fetched the page.
 *
 * That is a request leaving the machine because a cursor passed over a file and
 * something was clicked, which is precisely what this preview is built not to
 * do.
 *
 * ── Why the block is at the REQUEST layer and not the navigation event ──────
 * The obvious hook is `will-frame-navigate` on the window's `webContents`, and
 * it was tried first. Measured against a real Electron 41, twice in
 * independent trials, it did not intercept the click: Chromium attempted the
 * cross-scheme navigation anyway, with the handler present in the bundle and
 * attached to the right contents.
 *
 * Review found the likely reason. Electron's pre-navigation events have a
 * long-standing defect where they do not fire for a `BrowserWindow` created
 * with `webPreferences.sandbox: true` — and this application sets exactly that,
 * deliberately and load-bearingly (see `window.ts`). So on a sandboxed renderer
 * the DOM-event layer is the wrong place to enforce this rule, however correct
 * the rule is.
 *
 * `onBeforeRequest` runs beneath that layer, on the session, and was expected
 * not to be subject to whatever suppresses the event. It did not help either —
 * see the open section below. The navigation event handler is kept alongside
 * it: it costs nothing, it is correct when it does fire, and two independent
 * refusals of the same thing is the posture this preview takes everywhere
 * else.
 *
 * ══ STILL OPEN — NEITHER LAYER STOPS AN OUTBOUND LINK CLICK ════════════════
 *
 * **Do not read this module as a working control for the link case.** Measured
 * against a real Electron 41 across THREE independent rounds, an ordinary
 * `<a href="https://…">` click inside a previewed page still leaves the file:
 * `Page.frameNavigated` commits with `unreachableUrl` set to the remote URL,
 * the framed document is replaced by an error page, and same-origin access to
 * it is severed. It resolved to an error only because the test machine had no
 * route to the internet. On an ordinary machine the remote page would be
 * fetched.
 *
 * Two hooks have been tried and neither intercepted it: `will-frame-navigate`
 * on the contents (round two) and `onBeforeRequest` on the session (round
 * three). Both are present in the built bundle and attached to the right
 * objects.
 *
 * A control test suggested `onBeforeRequest` does work — setting the frame's
 * `src` to a `file://` URL left the frame untouched. **Treat that as
 * inconclusive**: Chromium refuses a `file://` navigation from a non-`file`
 * origin on its own, so the frame staying put is explained without this module
 * doing anything. Whoever takes this next should build a control that CANNOT
 * be explained by a browser default — for instance a second custom scheme that
 * is registered and served but not on the allow-list.
 *
 * What IS confirmed to hold, independently of this file and re-observed every
 * round: scripts do not run, remote subresources are refused by the served
 * content policy (`blockedReason: "csp"`), form submission is refused by the
 * frame's own permission list, no popup or second window can be opened, and
 * the frame follows the cursor without staleness. The gap is exactly one
 * thing — a deliberate click on a link inside a previewed page.
 *
 * ── This is the Qt build's rule, ported ─────────────────────────────────────
 * `HtmlPreview.qml` answers `onNavigationRequested` by ignoring every request
 * whose type is not the initial typed navigation — "Keep it a preview: allow
 * only the initial local file load; ignore link clicks, form submits, and any
 * hop to another document."
 */

/**
 * Chromium's own PDF viewer, which arrives here as a document request.
 *
 * ── Why this exception exists, and what it cost to find ─────────────────────
 * `<embed type="application/pdf">` does not render a PDF itself. Chromium
 * answers it by loading an internal extension page into a CHILD FRAME, and
 * that page is addressed `chrome-extension://<this host>/index.html`. To the
 * rule below that is a document request off the application's scheme, so it
 * was cancelled — `net::ERR_BLOCKED_BY_CLIENT`, with the embed element still
 * in the DOM at its full size and nothing drawn inside it.
 *
 * That is invisible from the page: no error reaches the console, the element
 * looks correct to every DOM assertion, and the frame tree simply has one
 * fewer child. The PDF preview shipped working and stopped the moment the
 * navigation guard was registered, three commits later, with every test still
 * green because no test drives a real PDF.
 *
 * ── Why permitting it is safe ───────────────────────────────────────────────
 * This is the browser's own viewer, not content. It reaches no network — the
 * bytes come from the `<embed>`'s own URL, which is already one of ours — and
 * a previewed page cannot navigate itself here in any case, because Chromium
 * refuses web content a route to an extension resource that is not declared
 * web-accessible. The exception widens the allow-list by exactly one internal
 * viewer and by nothing that a document could ask for.
 *
 * ── The host is Chromium's, and it is a constant ────────────────────────────
 * The same id in every Chromium and every Electron for many years. If it ever
 * changes, the PDF preview goes blank again in exactly the way described
 * above, and this is the line to look at first.
 */
const PDF_VIEWER_PROTOCOL = "chrome-extension:";
const PDF_VIEWER_HOST = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

/**
 * Is this the built-in viewer being loaded for an `<embed>` we served?
 *
 * Host AND scheme, not `origin`: `chrome-extension` is not a special scheme,
 * so the URL parser reports its origin as the string `"null"` — and comparing
 * against that would match every opaque origin there is.
 */
function isBuiltInPdfViewer(url: URL): boolean {
  return url.protocol === PDF_VIEWER_PROTOCOL && url.host === PDF_VIEWER_HOST;
}

/**
 * May a frame in this window navigate to `url`?
 *
 * The application's own scheme — which covers the frame's initial load and any
 * move between previewed documents — plus Chromium's built-in PDF viewer, for
 * the reason given above it. Everything else is refused: `https:`, `http:`,
 * `file:`, `data:`, `javascript:` and any scheme a future handler might add.
 *
 * An allow-list rather than a deny-list, so a scheme nobody thought of is
 * refused by default instead of permitted until somebody notices.
 *
 * **Both locks ask this one question**, and that is why the viewer is admitted
 * here rather than beside the request-level block alone. `will-frame-navigate`
 * may not fire on a sandboxed renderer today, but if a future Electron fixes
 * that, a copy of the rule that had not heard about the viewer would break the
 * PDF preview a second time, from the other layer.
 *
 * Exported and pure so it can be tested. The Electron wiring below cannot be:
 * it needs a real session, and a rule nobody can check is how a navigation
 * guard quietly stops guarding.
 */
export function mayNavigateTo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === APP_SCHEME_PROTOCOL || isBuiltInPdfViewer(parsed);
  } catch {
    // Not a URL at all. Nothing legitimate reaches here, and refusing an
    // unparseable target is the only safe reading of it.
    return false;
  }
}

/**
 * The request types that REPLACE a document, as opposed to filling one.
 *
 * Only these are cancelled. An image, a stylesheet or a font is a subresource,
 * already governed by the content policy the main process serves with each
 * document, and cancelling those here would be a second, blunter copy of a rule
 * that already exists in a better place.
 */
const DOCUMENT_REQUESTS: readonly string[] = ["mainFrame", "subFrame"];

/** Would this request replace a document rather than fill one? */
export function isDocumentRequest(resourceType: string): boolean {
  return DOCUMENT_REQUESTS.includes(resourceType);
}

/** The part of a `Session` this module uses. Narrow, so a test can stand in. */
export interface BlockableSession {
  readonly webRequest: {
    onBeforeRequest(
      listener: (
        details: { readonly url: string; readonly resourceType: string },
        callback: (response: { cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
}

/**
 * The part of `WebContents` this module uses. Narrow, for the same reason.
 *
 * `on` is declared `void` although Electron's own returns `this` for chaining.
 * That is the honest statement of what this module needs — it registers a
 * handler and never reads the result — and it costs nothing at the call site,
 * because a function returning a value is assignable to a signature returning
 * `void`. The real `WebContents` still satisfies it, and so does a test double
 * that returns itself.
 */
export interface NavigableContents {
  on(
    event: "will-frame-navigate",
    listener: (details: { readonly url: string; preventDefault(): void }) => void,
  ): void;
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: "deny" }): void;
}

/**
 * Cancel every document request that leaves the application's own scheme.
 *
 * Intended as the load-bearing half of this module and NOT yet shown to be —
 * read the open section in the header before relying on it. Register it once
 * per session:
 * Electron allows a single `onBeforeRequest` listener per session and a second
 * call replaces the first, so calling this twice would silently discard
 * whichever rule was installed earlier.
 */
export function refuseDocumentRequestsOffScheme(session: BlockableSession): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isDocumentRequest(details.resourceType) && !mayNavigateTo(details.url)) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

/**
 * Refuse navigation and window opening at the contents level.
 *
 * Kept alongside the request-level block above rather than instead of it. On a
 * sandboxed renderer this may never fire — see the header — so it is the
 * second lock and not the first. `will-frame-navigate` rather than
 * `will-navigate`: the latter covers only the top frame, and the frame a
 * previewed page lives in is a child.
 */
export function refuseNavigationAwayFromApp(contents: NavigableContents): void {
  contents.on("will-frame-navigate", (details) => {
    if (mayNavigateTo(details.url)) return;
    details.preventDefault();
  });

  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
