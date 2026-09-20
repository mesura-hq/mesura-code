import { describe, expect, it } from "vitest";

import {
  classify,
  inheritsFrom,
  isImageMime,
  isTextMime,
  looksBinary,
  type MimeTables,
  resolveMimeType,
} from "../src/mime.ts";

/**
 * A miniature of the real XDG database, transcribed from this machine's
 * `/usr/share/mime/` so the fixture cannot drift into wishful thinking.
 *
 * The load-bearing row is `text/x-shellscript`: its ONLY entry in the real
 * `subclasses` file is `text/x-shellscript application/x-executable`. The table
 * never connects it to `text/plain`. An implementation that reads the table and
 * stops therefore decides a shell script is not text — and every shell script
 * in the file manager silently stops previewing.
 */
const tables: MimeTables = {
  globs: [
    { weight: 50, mime: "text/x-shellscript", pattern: "*.sh" },
    { weight: 50, mime: "image/svg+xml", pattern: "*.svg" },
    { weight: 50, mime: "text/plain", pattern: "*.txt" },
    { weight: 50, mime: "application/json", pattern: "*.json" },
    { weight: 50, mime: "image/png", pattern: "*.png" },
    { weight: 50, mime: "text/markdown", pattern: "*.md" },
    // Two patterns match `foo.tar.gz`; the longer one must win.
    { weight: 50, mime: "application/gzip", pattern: "*.gz" },
    { weight: 50, mime: "application/x-compressed-tar", pattern: "*.tar.gz" },
    // A whole-name match, not an extension.
    { weight: 50, mime: "text/x-makefile", pattern: "Makefile" },
  ],
  subclasses: new Map([
    ["text/x-shellscript", ["application/x-executable"]],
    ["text/markdown", ["text/plain"]],
    ["application/json", ["application/javascript"]],
    ["application/javascript", ["text/plain"]],
    ["image/svg+xml", ["application/xml"]],
    ["application/xml", ["text/plain"]],
  ]),
  aliases: new Map([["application/x-yaml", "application/yaml"]]),
};

describe("resolveMimeType", () => {
  it("matches a plain extension", () => {
    expect(resolveMimeType(tables, "notes.txt")).toBe("text/plain");
    expect(resolveMimeType(tables, "logo.png")).toBe("image/png");
  });

  it("prefers the longest matching pattern", () => {
    // `*.gz` and `*.tar.gz` both match. The archive type is the specific one.
    expect(resolveMimeType(tables, "backup.tar.gz")).toBe("application/x-compressed-tar");
  });

  it("matches a whole filename, not only an extension", () => {
    expect(resolveMimeType(tables, "Makefile")).toBe("text/x-makefile");
  });

  it("returns null for an unknown name rather than guessing", () => {
    expect(resolveMimeType(tables, "mystery")).toBeNull();
  });

  it("follows an alias to its canonical type", () => {
    // The real database renamed `application/x-yaml` to `application/yaml`.
    // The Qt version's hardcoded list predated that rename, which is why YAML
    // stopped previewing. Aliases are why this must not be a hardcoded list.
    expect(
      resolveMimeType(
        { ...tables, globs: [{ weight: 50, mime: "application/x-yaml", pattern: "*.yml" }] },
        "c.yml",
      ),
    ).toBe("application/yaml");
  });
});

describe("inheritsFrom — the two implicit rules", () => {
  it("walks the explicit subclasses table", () => {
    expect(inheritsFrom(tables, "text/markdown", "text/plain")).toBe(true);
  });

  it("walks a chain of several hops", () => {
    // json → javascript → plain
    expect(inheritsFrom(tables, "application/json", "text/plain")).toBe(true);
  });

  it("treats every text/* type as a subclass of text/plain, implicitly", () => {
    // THE trap. `text/x-shellscript` inherits only from
    // `application/x-executable` in the table. The spec's implicit rule is the
    // only thing that makes it text.
    expect(inheritsFrom(tables, "text/x-shellscript", "text/plain")).toBe(true);
  });

  it("treats every type as a subclass of application/octet-stream, implicitly", () => {
    expect(inheritsFrom(tables, "image/png", "application/octet-stream")).toBe(true);
  });

  it("does not invent an ancestry that is not there", () => {
    expect(inheritsFrom(tables, "image/png", "text/plain")).toBe(false);
  });

  it("terminates on a cycle instead of recursing forever", () => {
    const looped: MimeTables = {
      ...tables,
      subclasses: new Map([
        ["application/a", ["application/b"]],
        ["application/b", ["application/a"]],
      ]),
    };
    expect(inheritsFrom(looped, "application/a", "text/plain")).toBe(false);
  });
});

describe("isTextMime", () => {
  it("accepts a shell script", () => {
    expect(isTextMime(tables, "text/x-shellscript")).toBe(true);
  });

  it("accepts JSON, which reaches text/plain through two hops", () => {
    expect(isTextMime(tables, "application/json")).toBe(true);
  });

  it("rejects a PNG", () => {
    expect(isTextMime(tables, "image/png")).toBe(false);
  });
});

/**
 * ASCII to bytes, without `TextEncoder`.
 *
 * `fm-core` compiles with `lib: ["ES2023"]` and `types: []` — no DOM, no Node —
 * because both processes import it and neither owns it. `TextEncoder` is an
 * environment API rather than a language one, so reaching for it here would
 * assume an environment this package must not assume. The compiler caught it.
 */
const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("looksBinary — the content sniff", () => {
  it("calls a NUL-free head text", () => {
    expect(looksBinary(bytes("#!/bin/sh\necho hi\n"))).toBe(false);
  });

  it("calls a head containing a NUL binary", () => {
    expect(looksBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toBe(true);
  });

  it("only inspects the first eight kilobytes", () => {
    const head = new Uint8Array(9000);
    head.fill(0x41);
    head[8500] = 0x00; // past the window
    expect(looksBinary(head)).toBe(false);
  });

  it("calls an empty file text", () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
});

describe("classify — the order is a contract", () => {
  const head = bytes("<svg xmlns='http://www.w3.org/2000/svg'/>");

  it("calls an SVG an image, even though it is also text", () => {
    // `image/svg+xml` inherits from `application/xml`, which inherits from
    // `text/plain`, so it IS text under the inheritance rules. The image test
    // must run first or every SVG previews as source. That ordering is the
    // contract, not an accident.
    expect(isTextMime(tables, "image/svg+xml")).toBe(true);
    expect(classify(tables, "image/svg+xml", head)).toBe("image");
  });

  it("calls a shell script text", () => {
    expect(classify(tables, "text/x-shellscript", bytes("#!/bin/sh\n"))).toBe("text");
  });

  it("falls back to the content sniff when the type is unknown", () => {
    // An extensionless configuration file: no glob matches, the database has
    // nothing to say, and the absence of a NUL byte is the only evidence.
    expect(classify(tables, null, bytes("key = value\n"))).toBe("text");
  });

  it("falls back to the content sniff when the type is the generic fallback", () => {
    expect(classify(tables, "application/octet-stream", bytes("plain\n"))).toBe("text");
  });

  it("calls an unknown type with a NUL byte binary", () => {
    expect(classify(tables, null, new Uint8Array([0x00, 0x01, 0x02]))).toBe("binary");
  });

  it("recognises an image by type without reading content", () => {
    expect(isImageMime(tables, "image/png")).toBe(true);
    expect(classify(tables, "image/png", new Uint8Array(0))).toBe("image");
  });
});

/**
 * Guard for the defect verification found by comparing against
 * `Gio.content_type_guess()`, the reference implementation of this same spec.
 *
 * The real database writes each case-sensitive rule twice — once with `cs` and
 * once without — so that a parser ignorant of the flag still sees it. A parser
 * that honours the flag must skip the twin. Treating them as independent rows
 * made `main.c` resolve to `text/x-c++src`, and the same fault reproduced on
 * every one of the five `cs` pairs the database carries.
 */
describe("the cs duplicate-row convention", () => {
  const paired: MimeTables = {
    globs: [
      // Verbatim shape of the real rows, in the real file's order.
      { weight: 50, mime: "text/x-c++src", pattern: "*.C", caseSensitive: true },
      { weight: 50, mime: "text/x-c++src", pattern: "*.C" },
      { weight: 50, mime: "text/x-csrc", pattern: "*.c", caseSensitive: true },
      { weight: 50, mime: "text/x-csrc", pattern: "*.c" },
    ],
    subclasses: new Map(),
    aliases: new Map(),
  };

  it("resolves a lowercase C source to C, not to C++", () => {
    expect(resolveMimeType(paired, "main.c")).toBe("text/x-csrc");
  });

  it("resolves an uppercase C source to C++", () => {
    expect(resolveMimeType(paired, "main.C")).toBe("text/x-c++src");
  });

  it("still folds case for a pattern that has no cs row at all", () => {
    const ordinary: MimeTables = {
      globs: [{ weight: 50, mime: "image/jpeg", pattern: "*.jpg" }],
      subclasses: new Map(),
      aliases: new Map(),
    };
    expect(resolveMimeType(ordinary, "photo.JPG")).toBe("image/jpeg");
  });
});
