/**
 * @vitest-environment happy-dom
 *
 * A markdown file, read as a document.
 *
 * The point of the feature is that a specification or a set of notes stops
 * arriving as a wall of marked-up plain text. What that costs is a renderer
 * that turns somebody else's file into elements, so most of what is asserted
 * here is about what it REFUSES to turn into elements: raw HTML, a link, and
 * an image reaching outside the file's own directory.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownPreview } from "../../src/components/preview/MarkdownPreview.tsx";
import { forgetHighlighter } from "../../src/components/preview/useHighlighted.ts";
import { type BridgeLog, installBridge } from "./support.ts";

/**
 * A highlighter that answers, so the request/response pairing is exercised.
 *
 * Without one, `useHighlighted` takes its no-worker fallback and the id that
 * pairs a response with its request is never used — which is exactly how a
 * collision between two blocks sharing one worker went unnoticed. Every reply
 * wraps the text it was given, so a block showing another block's text is
 * visible in the output rather than inferred.
 */
class EchoingHighlighter extends EventTarget {
  postMessage(request: { id: number; text: string }) {
    // Asynchronous, like the real one: a synchronous reply would land before
    // the second block had even posted, and the collision needs them in flight
    // together to happen at all.
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          // A `span`, NOT a `b`. The raw-HTML test below asserts that no `b`
          // element exists anywhere in the document, and a stand-in that
          // emitted one made that test pass or fail depending on whether the
          // async highlight had landed yet — a flake, and one this fixture
          // created rather than found.
          data: {
            id: request.id,
            html: `<span class="hljs-stub">${request.text}</span>`,
            truncated: false,
          },
        }),
      );
    });
  }
  terminate() {}
}

const RICH = "/home/jc/projects/rich.md";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
  Object.defineProperty(globalThis, "Worker", {
    value: EchoingHighlighter,
    configurable: true,
    writable: true,
  });
  forgetHighlighter();
});
afterEach(() => {
  cleanup();
  forgetHighlighter();
});

/** Render the rich fixture and wait for the document to replace the loader. */
async function shown(path: string = RICH): Promise<HTMLElement> {
  render(<MarkdownPreview path={path} />);
  return await screen.findByTestId("preview-markdown");
}

describe("what a rendered document shows", () => {
  it("renders a heading, a list and a table as elements rather than as text", async () => {
    // The whole feature in one assertion: none of this is inside a `pre`.
    const doc = await shown();

    expect(within(doc).getByRole("heading", { name: "Title" })).toBeDefined();
    expect(
      within(doc)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["first", "second"]);
    expect(within(doc).getByRole("table")).toBeDefined();
    expect(
      within(doc)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["column", "other"]);
  });

  it("keeps the fenced block a code block, and records its language", async () => {
    const doc = await shown();
    const code = doc.querySelector("code.language-ts");

    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("const x: number = 1;");
  });

  it("gives each fenced block its own language and its own body", async () => {
    // TWO blocks, because one cannot collide with itself. They share a single
    // worker, so the id that pairs a response with its request has to be
    // unique across every block on the page — a per-component counter starts
    // at 1 in each of them and hands the second block the first one's answer.
    const doc = await shown();

    await waitFor(() => {
      const blocks = [...doc.querySelectorAll("pre code")];
      expect(blocks.map((b) => b.className.replace(/ ?hljs/, ""))).toEqual([
        "language-ts",
        "language-python",
      ]);
      // Each block shows ITS OWN source. Under a colliding id both showed
      // whichever answer arrived last.
      expect(blocks[0]?.textContent).toContain("const x: number = 1;");
      expect(blocks[0]?.textContent).not.toContain("def second");
      expect(blocks[1]?.textContent).toContain("def second(): return 2");
      expect(blocks[1]?.textContent).not.toContain("const x");
    });
  });

  it("shows raw HTML written in the file as text, not as an element", async () => {
    // A previewed file is somebody else's data. Markdown permits inline HTML
    // and this renderer does not: the tag is shown, never honoured.
    const doc = await shown();

    expect(doc.querySelector("b")).toBeNull();
    expect(doc.textContent).toContain("<b>raw html</b>");
  });

  it("shows a truncation marker when the read was capped", async () => {
    render(<MarkdownPreview path="/home/jc/projects/capped.md" />);
    await screen.findByTestId("preview-markdown");

    expect(screen.getByTestId("preview-truncated")).toBeDefined();
  });
});

describe("what a rendered document may reach", () => {
  it("resolves an image beside the file through the directory grant", async () => {
    const doc = await shown();
    const image = within(doc).getByRole("img", { name: "diagram" });

    // The grant's own prefix, which nothing else could have produced.
    expect(image.getAttribute("src")).toBe("test-grant://dir/home/jc/projects/assets/flow.png");
    // And the grant was asked for the file's PARENT, never for the file.
    expect(log.directoryGrants).toEqual(["/home/jc/projects"]);
  });

  it.each([
    ["one climbing out of the directory", "escaping"],
    ["one naming a remote host", "remote"],
    // Found by verification from OUTSIDE, after the unit tests were green: the
    // markdown pipeline percent-encodes a backslash to `%5C` before the image
    // component is handed the source, so a check for a literal backslash was
    // testing a string that no longer held one. Both of these loaded, and both
    // issued a real request that the main process then had to refuse.
    ["one climbing out with backslashes", "back"],
    ["one naming a UNC share", "unc"],
    // And this one slipped past every anchored check because the scheme was
    // not at the start of the string.
    ["one with whitespace in front of its scheme", "lead"],
  ])("shows %s as its alt text and never as an image", async (_why, alt) => {
    const doc = await shown();

    // Not an `<img>` with a blocked source — no element that could issue a
    // request at all. A browser fetches an `src` before any policy is
    // consulted, so refusing to write one is the only reliable refusal.
    expect(within(doc).queryByRole("img", { name: alt })).toBeNull();
    expect(doc.textContent).toContain(alt);
  });

  it("draws a link as a link but gives it nowhere to go", async () => {
    // The operator asked for links to LOOK like links. What keeps that from
    // being a lie is that there is no anchor at all — nothing to follow, and a
    // stray click opens nothing. The dotted underline and the arrow cursor
    // live in the stylesheet; what has to hold here is the absent element.
    const doc = await shown();

    expect(doc.querySelector("a")).toBeNull();
    expect(doc.textContent).toContain("a link");
  });

  it("shows a link's destination rather than letting it be followed", async () => {
    // Seeing where a reference points is the question a reader skimming a
    // document actually has, and it is what replaces being able to follow it.
    const doc = await shown();

    expect(doc.querySelector(".preview__markdown-link")?.getAttribute("title")).toBe(
      "https://example.com/page",
    );
  });
});
