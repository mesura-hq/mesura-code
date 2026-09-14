import { describe, expect, it } from "vitest";

import {
  CHROME_EXTENSIONS,
  chromeIconFor,
  extensionCandidates,
  iconTokenFor,
} from "../src/icons/resolve.ts";

/**
 * The cascade, and the one property that matters most: it never fails.
 *
 * A file manager that showed nothing for an unrecognised file would show
 * nothing for most of a source tree.
 */

describe("extensionCandidates", () => {
  it("lists every dot-suffix, longest first", () => {
    expect(extensionCandidates("component.spec.ts")).toEqual(["spec.ts", "ts"]);
  });

  it("treats a dotfile's leading dot as a hidden marker, not a separator", () => {
    // `.env.local` is an environment file. Splitting on the leading dot would
    // make the first candidate the empty string and lose the pairing.
    expect(extensionCandidates(".env.local")).toEqual(["env.local", "local"]);
  });

  it("has no candidates for a name with no dot", () => {
    expect(extensionCandidates("Makefile")).toEqual([]);
  });
});

describe("iconTokenFor", () => {
  it.each([
    ["main.rs", "rust"],
    ["App.tsx", "react"],
    ["index.js", "javascript"],
    ["style.scss", "sass"],
    ["photo.PNG", "image"],
    ["archive.tar.gz", "zip"],
  ])("resolves %s to %s", (name, token) => {
    expect(iconTokenFor(name)).toBe(token);
  });

  it("matches the LONGEST suffix, not the first one it finds", () => {
    // `component.spec.ts` is a test before it is TypeScript. Matching the
    // shortest suffix first resolves it to the wrong symbol.
    expect(iconTokenFor("component.spec.ts")).toBe("typescript");
    expect(iconTokenFor("Button.spec.tsx")).toBe("react");
  });

  it("prefers a whole name over its extension", () => {
    // `package.json` is npm's, not JSON's, and a reader scanning a directory
    // is helped more by the former.
    expect(iconTokenFor("package.json")).toBe("npm");
    expect(iconTokenFor("data.json")).toBe("json");
  });

  it("folds case, because an extension is not case-sensitive to a reader", () => {
    expect(iconTokenFor("README.MD")).toBe("markdown");
    expect(iconTokenFor("Dockerfile")).toBe("docker");
  });

  it("never fails: an unknown extension gets the default symbol", () => {
    expect(iconTokenFor("mystery.qqqq")).toBe("default");
    expect(iconTokenFor("no-extension-at-all")).toBe("default");
    expect(iconTokenFor("")).toBe("default");
  });
});

describe("chromeIconFor", () => {
  it("covers the gaps the borrowed set does not fill", () => {
    // Folder, video, audio and document have no drawing in the file-type set —
    // they are chrome, not file types.
    expect(chromeIconFor("directory", null)).toBe("folder");
    expect(chromeIconFor("file", "video/mp4")).toBe("video");
    expect(chromeIconFor("file", "audio/flac")).toBe("audio");
    expect(chromeIconFor("file", "application/pdf")).toBe("document");
    expect(chromeIconFor("other", null)).toBe("binary");
  });

  it("defers to the file-type set for everything it does cover", () => {
    expect(chromeIconFor("file", "text/plain")).toBeNull();
    expect(chromeIconFor("file", null)).toBeNull();
  });
});

describe("chromeIconFor, from a name when there is no MIME type", () => {
  it("draws a video, an audio file and a document from their extensions", () => {
    // The finder's rows come from a search index that carries no type at all,
    // and a listing row has none until it has been described. Without this
    // they draw the blank `default` symbol, which reads as a broken icon.
    expect(chromeIconFor("file", null, "holiday.mp4")).toBe("video");
    expect(chromeIconFor("file", null, "track.flac")).toBe("audio");
    expect(chromeIconFor("file", null, "invoice.pdf")).toBe("document");
  });

  it("still answers nothing for a name the file-type set covers", () => {
    // Paired with the case above, so a fallback that answered something for
    // every name could not pass both. The second assertion of each pair is
    // what makes this about PRECEDENCE rather than about absence: without it,
    // an unknown extension like `.zzzz` would satisfy the test identically.
    expect(chromeIconFor("file", null, "index.ts")).toBeNull();
    expect(iconTokenFor("index.ts")).toBe("typescript");
    expect(chromeIconFor("file", null, "notes.md")).toBeNull();
    expect(iconTokenFor("notes.md")).toBe("markdown");
  });

  it("lets a known MIME type overrule the name, never the other way round", () => {
    // A name is an inference; a MIME type is what the filesystem established.
    expect(chromeIconFor("file", "text/plain", "holiday.mp4")).toBeNull();
    expect(chromeIconFor("file", "video/mp4", "notes.md")).toBe("video");
  });

  it("is unchanged for a caller that passes no name at all", () => {
    expect(chromeIconFor("file", null)).toBeNull();
    expect(chromeIconFor("directory", null)).toBe("folder");
  });
});

describe("a MIME type that says nothing", () => {
  it("is treated as no type at all, so the name still answers", () => {
    // `""` and `application/octet-stream` are the database saying it
    // recognised nothing. Reading them as an established fact is what sent a
    // `.pdf` it could not type to the blank default symbol — and `classify` in
    // `mime.ts` already treats both the same way.
    expect(chromeIconFor("file", "", "holiday.mp4")).toBe("video");
    expect(chromeIconFor("file", "application/octet-stream", "invoice.pdf")).toBe("document");
  });

  it("still lets a real type win, so the fix did not invert the rule", () => {
    // Paired with the case above: a guard that ignored EVERY MIME type would
    // satisfy it, and this is what refuses that.
    expect(chromeIconFor("file", "text/plain", "holiday.mp4")).toBeNull();
  });
});

describe("the two extension tables", () => {
  it("never claim the same extension", () => {
    // `FileIcon` asks `chromeIconFor` first, so an extension present in both
    // tables would silently draw the chrome symbol and the file-type symbol a
    // maintainer had just added would never appear. Nothing else would notice.
    const contested = CHROME_EXTENSIONS.filter(
      (extension) => iconTokenFor(`x.${extension}`) !== "default",
    );
    expect(contested).toEqual([]);
  });

  it("has extensions to check, so this cannot pass by finding nothing", () => {
    expect(CHROME_EXTENSIONS.length).toBeGreaterThan(20);
  });

  it("answers a chrome symbol for every one of them", () => {
    const missing = CHROME_EXTENSIONS.filter(
      (extension) => chromeIconFor("file", null, `x.${extension}`) === null,
    );
    expect(missing).toEqual([]);
  });
});
