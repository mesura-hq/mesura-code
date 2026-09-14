/**
 * @vitest-environment happy-dom
 *
 * An HTML file, shown as the page it is.
 *
 * ── What this file can and cannot prove ─────────────────────────────────────
 * happy-dom does not fetch a framed document and does not lay one out, so
 * nothing here can show that a page renders. What it CAN show is everything
 * this component actually decides: which element, which source, and — the part
 * that matters — the exact contents of the frame's permission list.
 *
 * There is deliberately no test claiming "a script did not run". happy-dom
 * would not have run it either way, so such a test passes for the wrong reason,
 * which is worse than no test. The attribute assertion is the real check, and
 * the running page was exercised by the verifier against a real browser.
 *
 * **Expect noise.** This suite prints a `DOMException` per render — happy-dom
 * cannot fetch the application's own URL scheme and says so. The tests pass
 * regardless: it is the frame's `src` and permissions that are asserted, never
 * what loading it produces. Nothing is wrong when you see it.
 */
import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HtmlPreview } from "../../src/components/preview/HtmlPreview.tsx";
import { inertBridge } from "./support.ts";

/**
 * The DIRECTORY grant, as the main process would name it.
 *
 * The frame is addressed as `<directory grant>/<file name>`, one level down,
 * so an ordinary relative reference inside the page resolves to a sibling
 * under the same grant. A file grant would put the document AT the token, and
 * a browser resolving `./style.css` against that drops the token and asks for
 * something that is not a grant at all.
 */
const grantFor = (path: string) =>
  `symmetria-fm://app/__preview/token${path.slice(0, path.lastIndexOf("/"))}`;

/** Where the frame should end up pointing for a given file. */
const urlFor = (path: string) => `${grantFor(path)}/${path.slice(path.lastIndexOf("/") + 1)}`;

/** Held until released, for the state before the main process has answered. */
let release: (() => void) | null = null;

function installBridge(options: { readonly hold?: boolean } = {}): void {
  const bridge: Bridge = {
    ...inertBridge(),
    previewDirectoryUrl: (request) => {
      // SAFETY: the request came from this renderer's own `bridge.ts`, which
      // builds it from a typed argument.
      const { path } = request as { path: string };
      const answer = { ok: true as const, value: { url: grantFor(path) } };
      if (options.hold !== true) return Promise.resolve(answer);

      return new Promise((resolve) => {
        release = () => resolve(answer);
      });
    },
  };

  Object.defineProperty(window, BRIDGE_KEY, { value: bridge, configurable: true, writable: true });
}

beforeEach(() => {
  release = null;
  installBridge();
});
afterEach(cleanup);

async function frame(): Promise<HTMLElement> {
  return await screen.findByTestId("preview-html-frame");
}

describe("what the frame is pointed at", () => {
  it("loads the file from the application's own scheme", async () => {
    render(<HtmlPreview path="/home/jc/page.html" />);

    expect((await frame()).getAttribute("src")).toBe(urlFor("/home/jc/page.html"));
  });

  it("addresses the file UNDER its directory grant, not at a grant of its own", async () => {
    // Found by verification from outside, after every unit test passed. A file
    // grant addresses `…/__preview/<token>` with nothing after it, so a
    // browser resolving `./style.css` inside the page drops the LAST SEGMENT —
    // the token — and asks for `…/__preview/style.css`, which is not a grant
    // and answers 404. Every sibling a page references was lost that way: the
    // stylesheet, the images, the fonts, silently, with the page rendering
    // unstyled and nothing saying why.
    render(<HtmlPreview path="/home/jc/docs/page.html" />);

    const src = (await frame()).getAttribute("src") ?? "";

    // One level down from the grant, so `./style.css` is a sibling under it.
    expect(src.endsWith("/page.html")).toBe(true);
    expect(src.slice(0, src.lastIndexOf("/"))).toBe(grantFor("/home/jc/docs/page.html"));
    // And the grant was asked for by FILE path — the main process takes the
    // parent, so the renderer never names a root of its own.
    expect(src).toContain("/home/jc/docs");
  });

  it("shows the same loading state as every other preview until the URL arrives", async () => {
    // The main process authorises each path before naming an address for it.
    // Until it answers there is nothing to point a frame at, and an empty
    // frame would flash a white rectangle over the column.
    installBridge({ hold: true });
    render(<HtmlPreview path="/home/jc/page.html" />);

    expect(screen.getByTestId("preview-loading")).toBeDefined();
    expect(screen.queryByTestId("preview-html-frame")).toBeNull();

    release?.();
    expect(await frame()).toBeDefined();
  });

  it("follows the cursor to another file and never keeps the old one", async () => {
    // A frame left pointing at the previous file is the worst shape this can
    // fail in: it shows a real page beside the wrong file name.
    const view = render(<HtmlPreview path="/home/jc/docs/first.html" />);
    await waitFor(async () =>
      expect((await frame()).getAttribute("src")).toBe(urlFor("/home/jc/docs/first.html")),
    );

    view.rerender(<HtmlPreview path="/home/jc/docs/second.html" />);

    await waitFor(async () =>
      expect((await frame()).getAttribute("src")).toBe(urlFor("/home/jc/docs/second.html")),
    );
  });
});

describe("what the frame is permitted to do", () => {
  /** The permission list, as the set of tokens it actually grants. */
  async function permissions(): Promise<string[]> {
    const value = (await frame()).getAttribute("sandbox") ?? "";
    return value.split(/\s+/).filter((token) => token !== "");
  }

  it("grants nothing that lets a script run", async () => {
    // THE assertion of this file. A previewed page is a stranger's file, and
    // the dangerous combination in a frame is `allow-scripts` together with
    // `allow-same-origin`: together they let framed code reach the parent
    // document, which holds the bridge to the filesystem. Apart they are safe,
    // and that is exactly the edit a future reader will be tempted to make.
    render(<HtmlPreview path="/home/jc/page.html" />);

    expect(await permissions()).not.toContain("allow-scripts");
  });

  it.each([
    ["top-level navigation", "allow-top-navigation"],
    ["navigation by user activation", "allow-top-navigation-by-user-activation"],
    ["popups", "allow-popups"],
    ["form submission", "allow-forms"],
    ["modal dialogs", "allow-modals"],
    ["downloads", "allow-downloads"],
    ["pointer lock", "allow-pointer-lock"],
    ["presentation", "allow-presentation"],
  ])("grants nothing that allows %s", async (_why, token) => {
    // This stays a preview. The Qt build reached the same posture by ignoring
    // every navigation that was not the initial load.
    render(<HtmlPreview path="/home/jc/page.html" />);

    expect(await permissions()).not.toContain(token);
  });

  it("grants same-origin alone, so the page's own stylesheet applies", async () => {
    // Without it the frame has an opaque origin, `'self'` in the content
    // policy the main process serves matches nothing, and every sibling asset
    // is blocked — the page renders unstyled, which is not a faithful render.
    // Safe precisely because scripts are withheld above.
    render(<HtmlPreview path="/home/jc/page.html" />);

    expect(await permissions()).toEqual(["allow-same-origin"]);
  });

  it("sends no referrer", async () => {
    // Nothing should leave the machine under the served content policy anyway.
    // A second lock on a bolted door costs one attribute.
    render(<HtmlPreview path="/home/jc/page.html" />);

    expect((await frame()).getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});
