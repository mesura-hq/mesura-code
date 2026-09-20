import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FOREIGN_DOCUMENT_STYLE } from "@symmetria/fm-core/scrollbar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileResponse } from "../src/main/fileResponse.ts";

/**
 * Serving a real file, against real bytes.
 *
 * `protocol.ts` imports `electron` at module scope and so cannot be reached
 * from a test at all. That is why the response building lives in its own
 * module: everything below runs against a temporary file on disk, which is the
 * only way the range arithmetic gets checked rather than asserted.
 *
 * What this cannot show is the thing that started it — whether Chromium's media
 * pipeline accepts the result. That was measured directly (a real H.264 file
 * played to `readyState 4` once these headers were present, and raised
 * `MEDIA_ELEMENT_ERROR: Format error` without them) and belongs to the
 * verifier, which drives a real Electron.
 */

let directory: string;
let path: string;
let empty: string;
let page: string;
let utf16Page: string;

/** Distinct bytes, so a wrong slice is a wrong VALUE and not merely a wrong length. */
const CONTENT = "0123456789abcdefghij";

/** A document, complete with the closing tag the style is appended after. */
const PAGE = "<!doctype html><html><head></head><body>hello</body></html>";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "fm-file-response-"));
  path = join(directory, "clip.mp4");
  empty = join(directory, "empty.mp4");
  page = join(directory, "page.html");
  utf16Page = join(directory, "utf16.html");
  writeFileSync(path, CONTENT);
  writeFileSync(empty, "");
  writeFileSync(page, PAGE);
  // A real byte order mark, which is what decides the encoding whatever the
  // response says. `utf16le` gives Node's own BOM-less encoding, so the mark is
  // written explicitly.
  writeFileSync(
    utf16Page,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PAGE, "utf16le")]),
  );
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("a whole-file answer", () => {
  it("declares its length and that it may be seeked", async () => {
    // The two headers whose absence made a valid video unplayable.
    const response = fileResponse(path, CONTENT.length, "video/mp4", null);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("20");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe(CONTENT);
  });

  it("serves an empty file as an empty body rather than as the whole file", async () => {
    // `createReadStream` given an `end` of -1 reads to the END of the file, so
    // the naive expression turns a zero-byte file into a whole-file read. Here
    // that is invisible; on a real empty file it is a body that should not
    // exist.
    const response = fileResponse(empty, 0, "video/mp4", null);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });
});

describe("a partial answer", () => {
  it("returns exactly the bytes asked for", async () => {
    const response = fileResponse(path, CONTENT.length, "video/mp4", "bytes=5-9");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("56789");
    expect(response.headers.get("content-range")).toBe("bytes 5-9/20");
    expect(response.headers.get("content-length")).toBe("5");
  });

  it("answers the opening request a media element makes", async () => {
    // `bytes=0-` names no end, and it is the first thing Chromium sends.
    const response = fileResponse(path, CONTENT.length, "video/mp4", "bytes=0-");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(CONTENT);
    expect(response.headers.get("content-range")).toBe("bytes 0-19/20");
  });

  it("returns the LAST bytes for a suffix range", async () => {
    // The direction that is easy to get backwards, and the one that decides
    // whether a container's index is found.
    const response = fileResponse(path, CONTENT.length, "video/mp4", "bytes=-4");

    expect(await response.text()).toBe("ghij");
    expect(response.headers.get("content-range")).toBe("bytes 16-19/20");
  });

  it("returns one byte for a one-byte range", async () => {
    const response = fileResponse(path, CONTENT.length, "video/mp4", "bytes=7-7");

    expect(await response.text()).toBe("7");
    expect(response.headers.get("content-length")).toBe("1");
  });
});

describe("a refusal", () => {
  it("answers 416 with no body and the real length", async () => {
    const response = fileResponse(path, CONTENT.length, "video/mp4", "bytes=99-");

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */20");
    expect(await response.text()).toBe("");
  });
});

/**
 * The content policy a served DOCUMENT carries.
 *
 * The Qt build reaches "it cannot phone home" by turning off remote URL access
 * in its browser engine. There is no engine to configure here: the frame is an
 * ordinary one, so the lock has to travel with the response. A page served
 * without this header could fetch a tracker, a remote font or a remote script
 * the moment it is framed.
 *
 * It is decided from the content type rather than passed in by the caller,
 * because `protocol.ts` imports `electron` at module scope and cannot be
 * reached from any test. A policy chosen there would be a security rule nobody
 * could check.
 */
describe("the document content policy", () => {
  const policyOf = (response: Response) => response.headers.get("content-security-policy");

  it.each([["text/html"], ["application/xhtml+xml"]])(
    "locks a %s response down to its own origin",
    (contentType) => {
      const policy = policyOf(fileResponse(path, CONTENT.length, contentType, null));

      expect(policy).not.toBeNull();
      // `default-src 'none'` is the whole of it: everything a page might reach
      // for is denied unless a later directive opens it, and none of them
      // names a remote origin.
      expect(policy).toContain("default-src 'none'");
      expect(policy).not.toMatch(/https?:/);
      expect(policy).not.toContain("*");
    },
  );

  it("permits a sibling stylesheet and a sibling image, and nothing further", () => {
    const policy = policyOf(fileResponse(path, CONTENT.length, "text/html", null)) ?? "";

    // A page whose own stylesheet is blocked renders unstyled, which is not a
    // faithful render. `'self'` is the document's own grant and reaches no
    // further than the directory it was issued for.
    expect(policy).toContain("img-src 'self'");
    expect(policy).toContain("style-src 'self'");
    // Scripts are refused twice over: the frame withholds the permission AND
    // the policy denies the source. Neither alone is stated anywhere a reader
    // of the other would see it.
    expect(policy).not.toContain("script-src");
  });

  it("names the two directives that do NOT fall back to default-src", () => {
    // A GUARD on a real finding. `img-src`, `style-src`, `font-src`,
    // `media-src`, `object-src` and `frame-src` all inherit from
    // `default-src`; `form-action` and `base-uri` do not. Without them
    // `default-src 'none'` still leaves a previewed page able to submit a form
    // to a remote host on a plain click, with no script involved.
    const policy = policyOf(fileResponse(path, CONTENT.length, "text/html", null)) ?? "";

    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it.each([["image/png"], ["video/mp4"], ["application/pdf"], ["text/plain"]])(
    "leaves a %s response exactly as it was",
    (contentType) => {
      expect(policyOf(fileResponse(path, CONTENT.length, contentType, null))).toBeNull();
    },
  );

  it("carries the policy on a partial response too", () => {
    // A framed document CAN be fetched by range. A policy applied only to the
    // 200 would be a lock on the front door with the window left open.
    //
    // XHTML rather than HTML, and the difference is real rather than
    // cosmetic: `text/html` is answered whole now, ranges ignored, because the
    // scrollbar rules are appended to it and its length is therefore not known
    // when the headers are written. XHTML takes no rules, stays rangeable, and
    // is what keeps this assertion about something that can still happen.
    const partial = fileResponse(path, CONTENT.length, "application/xhtml+xml", "bytes=0-4");

    expect(partial.status).toBe(206);
    expect(policyOf(partial)).toContain("default-src 'none'");
  });
});

/**
 * The scrollbar, carried into a document that has never heard of this panel.
 *
 * A previewed HTML file is a SECOND document with its own cascade: it cannot
 * see one declaration of the panel's stylesheet, so it drew Chromium's white
 * default with arrow buttons beside a panel that draws a thin dim lane. A
 * screenshot caught three of them at once inside one preview.
 *
 * The rules travel as text appended to the served document. What cannot be
 * shown here is that Chromium then applies them — the HTML parser's reparenting
 * of trailing content is a browser behaviour, and it belongs to a verifier
 * driving a real one. What IS shown here is everything this module decides:
 * which responses carry the rules, which are left exactly as they were, and
 * that the document's own bytes come through untouched.
 */
describe("the scrollbar a framed document is given", () => {
  const bodyOf = async (response: Response) => await response.text();

  it("appends the panel's rules to an HTML document", async () => {
    const body = await bodyOf(fileResponse(page, PAGE.length, "text/html", null));

    expect(body).toContain("::-webkit-scrollbar");
    expect(body).toContain("--scrollbar-thumb");
  });

  it("appends the SHARED text, not a second copy of the rules", async () => {
    // The one definition. If this module ever grows rules of its own, the
    // panel and the preview become two scrollbars that merely resemble each
    // other — which is the state this whole change exists to end.
    const body = await bodyOf(fileResponse(page, PAGE.length, "text/html", null));

    expect(body).toBe(`${PAGE}</textarea></title></script>${FOREIGN_DOCUMENT_STYLE}`);
  });

  it("closes the elements that would swallow the rules as text", async () => {
    // A file whose bytes end inside `<textarea>`, `<title>` or `<script>`
    // leaves the tokenizer in a state where what follows is TEXT, not markup —
    // and the first two DRAW it, so a truncated fragment would show this
    // stylesheet's source at the foot of the preview. Each closer is dropped by
    // the parser when its element is not open, so a well-formed document is
    // unaffected; `</textarea>` leads because it is the only token that ends
    // `textarea` content.
    const body = await bodyOf(fileResponse(page, PAGE.length, "text/html", null));
    const appended = body.slice(PAGE.length);

    expect(appended.startsWith("</textarea></title></script>")).toBe(true);
    expect(appended.indexOf("</textarea>")).toBeLessThan(appended.indexOf("</script>"));
  });

  it("leaves the document's own bytes first and unaltered", async () => {
    // Appended, never spliced. Anything inserted ahead of the doctype would put
    // the page into quirks mode and change the layout of the very thing being
    // previewed.
    const body = await bodyOf(fileResponse(page, PAGE.length, "text/html", null));

    expect(body.startsWith(PAGE)).toBe(true);
  });

  it("declares no length, and offers no ranges", async () => {
    // Required rather than lazy: whether the style is appended is decided
    // inside the stream, from the first chunk, so the final length is not known
    // when the headers are written. A length wrong by 400 bytes leaves Chromium
    // waiting for a body that never finishes.
    const response = fileResponse(page, PAGE.length, "text/html", null);

    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBe("none");
  });

  it("still carries the content policy", async () => {
    // The policy and the style are independent decisions about the same
    // response, and the second must not have dropped the first.
    const response = fileResponse(page, PAGE.length, "text/html", null);

    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-type")).toBe("text/html");
  });

  it("appends nothing to XHTML, which is parsed as XML", async () => {
    // Trailing content after the root element is a fatal error in XML, not
    // something a parser reparents. Chromium would show a parse failure in
    // place of the page: a wrong scrollbar is a blemish, a page that will not
    // parse is a broken feature.
    const body = await bodyOf(fileResponse(page, PAGE.length, "application/xhtml+xml", null));

    expect(body).toBe(PAGE);
  });

  it("appends nothing to a document that declares itself UTF-16", async () => {
    // A byte order mark beats every other encoding signal, so UTF-8 bytes
    // appended to such a file decode as a line of rubbish at the foot of the
    // page — visible, unexplained, and worse than the scrollbar it replaces.
    const size = 2 + Buffer.from(PAGE, "utf16le").length;
    const served = await fileResponse(utf16Page, size, "text/html", null).arrayBuffer();

    expect(served.byteLength).toBe(size);
  });

  it.each([["video/mp4"], ["image/png"], ["text/plain"], ["application/pdf"]])(
    "leaves a %s response byte-identical",
    async (contentType) => {
      // Everything that is not a framed document is served exactly as before,
      // length and seekability included. A stray `<style>` in a PNG is a
      // corrupt PNG.
      const response = fileResponse(path, CONTENT.length, contentType, null);

      expect(await response.text()).toBe(CONTENT);
      expect(response.headers.get("content-length")).toBe(String(CONTENT.length));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
    },
  );

  it("ignores a range on a styled document rather than serving a slice", async () => {
    // The answer declares `accept-ranges: none`, so a compliant client does not
    // ask — and answering one anyway would make this module say two
    // incompatible things about one resource, and hand back a document with
    // the appended rules cut off. A 200 in reply to a range request is legal.
    const response = fileResponse(page, PAGE.length, "text/html", "bytes=0-4");

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("none");
    expect(await response.text()).toContain("::-webkit-scrollbar");
  });

  it("still answers a range on XHTML, which takes no rules", async () => {
    // The other half of the rule above. Only the styled type gives up ranges;
    // everything else, framed or not, keeps them.
    const response = fileResponse(page, PAGE.length, "application/xhtml+xml", "bytes=0-4");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(PAGE.slice(0, 5));
  });

  it("still answers an empty HTML file", async () => {
    // No byte to stream, so the appended style is the whole body. The branch
    // exists because `createReadStream` given an `end` of -1 reads to the end
    // of the file rather than reading nothing.
    const emptyPage = join(directory, "blank.html");
    writeFileSync(emptyPage, "");

    expect(await bodyOf(fileResponse(emptyPage, 0, "text/html", null))).toContain(
      FOREIGN_DOCUMENT_STYLE,
    );
  });
});
