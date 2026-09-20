import { describe, expect, it } from "vitest";

import type { MimeTables } from "../src/mime.ts";
import {
  languageFor,
  type PreviewTarget,
  renderableAs,
  routePreview,
} from "../src/preview/route.ts";

/**
 * The branch order, and what reaches each branch.
 *
 * The order is the whole point of having one router: a consumer that
 * re-implemented it would get the SVG case wrong, because an SVG genuinely is
 * text under the MIME inheritance rules.
 */

const tables: MimeTables = {
  globs: [],
  subclasses: new Map([
    ["image/svg+xml", ["application/xml"]],
    ["application/xml", ["text/plain"]],
    ["text/markdown", ["text/plain"]],
    ["application/json", ["application/javascript"]],
    ["application/javascript", ["text/plain"]],
    // These four are the REAL chains from /usr/share/mime/subclasses. An
    // earlier fixture had `x-compressed-tar` inheriting from `x-tar`, which it
    // does not — a `.tar.gz` is a gzip as far as the database is concerned,
    // and the archive routing branches on precisely that.
    ["application/x-compressed-tar", ["application/gzip"]],
    ["application/x-xz-compressed-tar", ["application/x-xz"]],
    ["application/x-bzip2-compressed-tar", ["application/x-bzip2"]],
    ["application/x-zstd-compressed-tar", ["application/zstd"]],
    // A .docx and a .jar really are subclasses of zip. Included because that
    // makes them list as archives now, which is a visible consequence.
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ["application/zip"],
    ],
    ["application/java-archive", ["application/zip"]],
  ]),
  aliases: new Map(),
};

/**
 * Built from character codes, not from `TextEncoder`.
 *
 * `fm-core` compiles with no environment at all — no DOM, no Node — precisely
 * so a `window` or a `node:fs` cannot creep into a package both processes
 * import. A test that reached for `TextEncoder` would be relying on an
 * environment the package does not have.
 */
const TEXT_HEAD = Uint8Array.from("hello, this is text\n", (c) => c.charCodeAt(0));
const BINARY_HEAD = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]);

function target(over: Partial<PreviewTarget>): PreviewTarget {
  return {
    name: "file.txt",
    path: "/tmp/file.txt",
    isDirectory: false,
    entryCount: 0,
    entries: [],
    size: 12,
    mime: "text/plain",
    head: TEXT_HEAD,
    ...over,
  };
}

describe("the branch order", () => {
  it("routes an SVG to the image branch, not the text branch", () => {
    // The case the order exists for. `image/svg+xml` inherits from
    // `application/xml`, which inherits from `text/plain`, so an SVG IS text
    // under the inheritance rules. Test text first and every SVG previews as
    // source code.
    const route = routePreview(tables, target({ name: "logo.svg", mime: "image/svg+xml" }));

    expect(route.kind).toBe("image");
  });

  it("shows nothing when there is nothing under the cursor", () => {
    expect(routePreview(tables, null).kind).toBe("none");
  });

  it("lists a directory's entries rather than trying to preview it", () => {
    const route = routePreview(tables, target({ isDirectory: true, entryCount: 42 }));

    expect(route).toEqual({ kind: "directory", entryCount: 42, entries: [] });
  });

  it("prefers the directory branch even for a directory with a known type", () => {
    // A `.app` or a `.git` directory still has a name an extension table would
    // happily claim.
    const route = routePreview(
      tables,
      target({ name: "bundle.json", mime: "application/json", isDirectory: true, entryCount: 3 }),
    );

    expect(route.kind).toBe("directory");
  });
});

describe("images and documents", () => {
  it.each(["image/png", "image/gif", "image/avif", "image/webp"])(
    "routes %s to the image branch",
    (mime) => {
      expect(routePreview(tables, target({ name: "a", mime })).kind).toBe("image");
    },
  );

  it("routes a PDF to the document branch, for Chromium's own viewer", () => {
    const route = routePreview(tables, target({ name: "paper.pdf", mime: "application/pdf" }));

    expect(route).toEqual({ kind: "document", mime: "application/pdf" });
  });
});

describe("video", () => {
  it.each(["video/mp4", "video/webm", "video/x-matroska", "video/quicktime"])(
    "routes %s to the video branch",
    (mime) => {
      // Every video type, not only the ones this browser can decode. Routing is
      // decided by the name; whether the bytes play is decided at the element,
      // which is the only place that can know.
      expect(routePreview(tables, target({ name: "clip", mime }))).toEqual({ kind: "video", mime });
    },
  );

  it("no longer reports video as a branch that is not built", () => {
    // The union `UnbuiltKind` is what makes a missing preview name itself, and
    // a member left in it after the branch exists lets the pane apologise for
    // something it can now do.
    const route = routePreview(tables, target({ name: "clip.mp4", mime: "video/mp4" }));

    expect(route.kind).not.toBe("unbuilt");
  });
});

describe("archives", () => {
  it.each([
    ["application/zip", "zip", "none"],
    ["application/java-archive", "zip", "none"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "zip", "none"],
    ["application/x-tar", "tar", "none"],
    ["application/x-compressed-tar", "tar", "gzip"],
  ])("routes %s as a %s archive, compression %s", (mime, format, compression) => {
    const route = routePreview(tables, target({ name: "thing", mime }));

    expect(route).toEqual({ kind: "archive", mime, format, compression });
  });

  it("routes a bare gzip as a compressed tar and lets the READER disagree", () => {
    // `notes.txt.gz` is a legitimate file to land on and it is not a tarball.
    // The router cannot tell — nothing but the bytes can — so it routes by
    // type and the reader answers `notAnArchive`. Sniffing here would mean
    // reading the file to decide what to show, which is the router's whole
    // point avoided.
    const route = routePreview(tables, target({ name: "notes.txt.gz", mime: "application/gzip" }));

    expect(route).toEqual({
      kind: "archive",
      mime: "application/gzip",
      format: "tar",
      compression: "gzip",
    });
  });
});

describe("branches this cycle keeps but does not build", () => {
  it.each([
    ["application/x-7z-compressed", "archive"],
    ["application/vnd.rar", "archive"],
    ["application/x-xz-compressed-tar", "archive"],
    ["application/x-bzip2-compressed-tar", "archive"],
    ["application/x-zstd-compressed-tar", "archive"],
  ])("names %s as %s rather than falling through", (mime, what) => {
    // The formats with no reader. Saying "no archive preview yet" is a
    // different statement from showing a size and hoping, and it stays TRUE
    // for these — which is the whole reason the union keeps a member.
    const route = routePreview(tables, target({ name: "thing", mime }));

    expect(route).toEqual({ kind: "unbuilt", what, mime });
  });
});

describe("audio", () => {
  it.each(["audio/flac", "audio/mpeg", "audio/ogg", "audio/x-wav"])(
    "routes %s to the audio branch",
    (mime) => {
      expect(routePreview(tables, target({ name: "song", mime }))).toEqual({ kind: "audio", mime });
    },
  );

  it("no longer reports audio as a branch that is not built", () => {
    expect(routePreview(tables, target({ name: "song.flac", mime: "audio/flac" })).kind).not.toBe(
      "unbuilt",
    );
  });

  it("still routes a video before an audio-only container is considered", () => {
    // `video/` is tested first, and an .mkv carrying only audio is still a
    // video type as far as the database is concerned. Routing by type is the
    // contract; the element decides what it can do with the bytes.
    expect(routePreview(tables, target({ name: "a.mkv", mime: "video/x-matroska" })).kind).toBe(
      "video",
    );
  });
});

describe("spreadsheets", () => {
  it.each([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/vnd.oasis.opendocument.spreadsheet",
  ])("routes %s to the spreadsheet branch", (mime) => {
    expect(routePreview(tables, target({ name: "precios", mime }))).toEqual({
      kind: "spreadsheet",
      mime,
    });
  });

  it("routes a csv to the spreadsheet branch and NOT to the text one", () => {
    // A csv IS text, so the order is what decides this: the spreadsheet test
    // runs before the content classification. It has routed here since before
    // there was a grid to route it to — do not "fix" it back to plain text.
    const route = routePreview(
      tables,
      target({ name: "lista.csv", mime: "text/csv", head: TEXT_HEAD }),
    );

    expect(route).toEqual({ kind: "spreadsheet", mime: "text/csv" });
  });

  it("no longer reports a zip as a branch that is not built", () => {
    // It was the last member of `UnbuiltKind` that a zip could reach. The
    // union keeps that member — 7z and rar still need it — but a zip has a
    // reader now and must stop apologising for something it can do.
    //
    // Deliberately a negative, matching "no longer reports video as a branch
    // that is not built" above. What a zip DOES route to is pinned in the
    // `archives` block; asserting the shape here as well would be one fact in
    // two places.
    const route = routePreview(tables, target({ name: "backup.zip", mime: "application/zip" }));

    expect(route.kind).not.toBe("unbuilt");
  });
});

describe("text and code", () => {
  it("renders a known language as code", () => {
    const route = routePreview(tables, target({ name: "main.rs", mime: "text/plain" }));

    expect(route).toEqual({ kind: "code", language: "rust" });
  });

  it.each([
    ["a markdown file", "NOTES.md", "markdown"],
    ["an HTML file", "index.html", "xml"],
  ])("still routes %s to plain code, with no extra field", (_why, name, language) => {
    // A GUARD on the shape, not on the language. `renderableAs` is deliberately
    // NOT part of the route, and `toEqual` is exact — so folding it in later,
    // which is the tempting simplification, fails here rather than silently
    // changing what every consumer of the router receives.
    expect(routePreview(tables, target({ name, mime: "text/plain" }))).toEqual({
      kind: "code",
      language,
    });
  });

  it("renders an unknown language as plain text rather than failing", () => {
    // A guess that is wrong is worse than no highlighting. Automatic detection
    // was measured at 35 times the explicit cost and misread JavaScript as a
    // DNS zone file.
    const route = routePreview(tables, target({ name: "notes.qqq", mime: "text/plain" }));

    expect(route.kind).toBe("text");
  });

  it("previews an extensionless config through the content sniff", () => {
    // No extension and no registered type: the content is the only evidence,
    // and it says text.
    const route = routePreview(tables, target({ name: "hostname", mime: null }));

    expect(route.kind).toBe("text");
  });

  it("falls back for a binary with no branch of its own", () => {
    const route = routePreview(tables, target({ name: "a.out", mime: null, head: BINARY_HEAD }));

    expect(route).toEqual({ kind: "fallback", mime: null });
  });
});

describe("languageFor", () => {
  it.each([
    ["App.tsx", "typescript"],
    ["main.rs", "rust"],
    ["build.gradle.kts", null],
    ["index.html", "xml"],
    ["config.toml", "ini"],
    ["README.md", "markdown"],
  ])("maps %s", (name, language) => {
    expect(languageFor(name)).toBe(language);
  });

  it("matches whole names that carry a language but no extension", () => {
    expect(languageFor("Makefile")).toBe("makefile");
    expect(languageFor("CMakeLists.txt")).toBe("cmake");
    expect(languageFor("PKGBUILD")).toBe("bash");
  });

  it("folds case, because an extension is not case-sensitive to a reader", () => {
    expect(languageFor("SCRIPT.PY")).toBe("python");
  });

  it("returns null for a dotfile with no extension of its own", () => {
    // `.gitignore` has one dot, at position zero, which is not an extension.
    expect(languageFor(".gitignore")).toBeNull();
  });
});

/**
 * The directory branch carries the listing, not only its size.
 *
 * A count is a fact about a directory; a listing is the directory. Miller
 * columns are three columns because the third one shows what entering would
 * reveal, and a caption saying "16 entries" shows none of it.
 */
describe("the directory branch", () => {
  it("carries the listed entries alongside the count", () => {
    const route = routePreview(tables, {
      ...target({}),
      name: "projects",
      path: "/home/jc/projects",
      isDirectory: true,
      entryCount: 2,
      entries: [
        { name: "alpha", kind: "directory" },
        { name: "beta.md", kind: "file" },
      ],
    });

    expect(route.kind).toBe("directory");
    if (route.kind !== "directory") return;
    expect(route.entryCount).toBe(2);
    expect(route.entries.map((e) => e.name)).toEqual(["alpha", "beta.md"]);
  });

  it("reports a count larger than the listing, so the cap is visible downstream", () => {
    // The main process caps what it sends and reports the true total. Losing
    // one of the two would leave the pane unable to say how many it is not
    // showing.
    const route = routePreview(tables, {
      ...target({}),
      isDirectory: true,
      entryCount: 900,
      entries: [{ name: "one", kind: "file" }],
    });

    expect(route.kind).toBe("directory");
    if (route.kind !== "directory") return;
    expect(route.entryCount).toBe(900);
    expect(route.entries).toHaveLength(1);
  });

  it("still routes to directory when the listing is empty", () => {
    const route = routePreview(tables, {
      ...target({}),
      isDirectory: true,
      entryCount: 0,
      entries: [],
    });

    expect(route.kind).toBe("directory");
  });
});

/**
 * Which files have a second presentation, and which do not.
 *
 * Deliberately NOT a member of `PreviewRoute`. The route union is a decision
 * tree over what KIND of thing a file is; whether that kind can also be shown
 * rendered is a different question, and two callers need the answer without
 * needing a route at all — the preview hook, which holds the name and the
 * resolved type, and the keybinding table, whose cursor entry holds both too.
 *
 * One function, because the alternative is a list of MIME strings in the panel
 * and another in the registry. The previous cycle lost a release to exactly
 * that shape.
 */
describe("renderableAs", () => {
  it.each([
    ["a .md file", "NOTES.md"],
    ["a .markdown file", "notes.markdown"],
    ["an upper-case extension", "README.MD"],
  ])("calls %s markdown from its name alone", (_why, name) => {
    // The name decides first, so a markdown file the database has no opinion
    // about still renders.
    expect(renderableAs(name, null)).toBe("markdown");
  });

  it("calls a file markdown from its type when the name says nothing", () => {
    // A README with no extension at all. The database knows; the name cannot.
    expect(renderableAs("README", "text/markdown")).toBe("markdown");
  });

  it.each([
    ["a .html file", "index.html", null],
    ["a .xhtml file", "page.xhtml", null],
    ["the html type", "page", "text/html"],
    ["the xhtml type", "page", "application/xhtml+xml"],
  ])("calls %s html", (_why, name, mime) => {
    expect(renderableAs(name, mime)).toBe("html");
  });

  it.each([
    ["a TypeScript file", "route.ts", "text/x-typescript"],
    ["a plain text file", "notes.txt", "text/plain"],
    ["a name with no extension and no type", "LICENCE", null],
    ["an image", "photo.png", "image/png"],
  ])("says %s has no rendered form", (_why, name, mime) => {
    expect(renderableAs(name, mime)).toBe(null);
  });

  it("prefers the name over a type that disagrees", () => {
    // A `.md` served as `text/plain` is still markdown. The name is the
    // stronger signal because the user chose it and the database guessed.
    expect(renderableAs("notes.md", "text/plain")).toBe("markdown");
  });
});

describe("a renderable file always has a source view worth showing", () => {
  // Rendering can be switched off, and what the user then sees is the
  // HIGHLIGHTED source. An extension that `renderableAs` claims but
  // `languageFor` does not know would make that fallback a downgrade to
  // uncoloured plain text — which is the one thing the toggle must not do.
  //
  // A new renderable format adds a row here. That is the point: it forces the
  // two tables to be extended together.
  it.each([["file.md"], ["file.markdown"], ["file.html"], ["file.xhtml"]])(
    "%s is renderable AND has a highlighting language",
    (name) => {
      expect(renderableAs(name, null)).not.toBe(null);
      expect(languageFor(name)).not.toBe(null);
    },
  );
});
