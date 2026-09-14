import { describe, expect, it } from "vitest";

import { clipboardText } from "../src/clipboard.ts";

/**
 * What each of the copy chord's four text destinations puts on the clipboard.
 *
 * The chord decides WHAT to copy and leaves WHICH entries to the host, which
 * applies the same rule every file operation uses: the marked entries when
 * there are any, otherwise the one under the cursor. So these take a list, and
 * a list of one is the ordinary case rather than a special one.
 */
const ONE = ["/home/jc/notes.txt"];
const SEVERAL = ["/home/jc/notes.txt", "/home/jc/todo.md", "/home/jc/archive"];

describe("copying one entry", () => {
  it("copies the whole path", () => {
    expect(clipboardText("path", ONE, "/home/jc")).toBe("/home/jc/notes.txt");
  });

  it("copies the filename alone", () => {
    expect(clipboardText("filename", ONE, "/home/jc")).toBe("notes.txt");
  });

  it("copies the name without its extension", () => {
    expect(clipboardText("nameWithoutExtension", ONE, "/home/jc")).toBe("notes");
  });

  it("copies the directory the entry is in", () => {
    expect(clipboardText("directory", ONE, "/home/jc")).toBe("/home/jc");
  });
});

describe("copying several entries", () => {
  it("puts one path per line", () => {
    // A line per entry, so pasting into a shell or an editor gives a list
    // rather than one unusable run-on string.
    expect(clipboardText("path", SEVERAL, "/home/jc")).toBe(
      "/home/jc/notes.txt\n/home/jc/todo.md\n/home/jc/archive",
    );
  });

  it("puts one filename per line", () => {
    expect(clipboardText("filename", SEVERAL, "/home/jc")).toBe("notes.txt\ntodo.md\narchive");
  });

  it("gives the directory once, however many are marked", () => {
    // They are all in the same directory — that is what a marked set is — so
    // repeating it per entry would be noise.
    expect(clipboardText("directory", SEVERAL, "/home/jc")).toBe("/home/jc");
  });
});

describe("names the extension rule has to get right", () => {
  it("treats a leading dot as part of the name, not as an extension", () => {
    // `.bashrc` is a hidden file called `.bashrc`, not a file with extension
    // `bashrc`. The rule is shared with the sort's extension mode rather than
    // written twice, so the two can never disagree about it.
    expect(clipboardText("nameWithoutExtension", ["/home/jc/.bashrc"], "/home/jc")).toBe(".bashrc");
  });

  it("leaves a name with no extension alone", () => {
    expect(clipboardText("nameWithoutExtension", ["/home/jc/Makefile"], "/home/jc")).toBe(
      "Makefile",
    );
  });

  it("strips only the last extension", () => {
    expect(clipboardText("nameWithoutExtension", ["/home/jc/archive.tar.gz"], "/home/jc")).toBe(
      "archive.tar",
    );
  });

  it("keeps a dot that is inside a directory name", () => {
    expect(clipboardText("filename", ["/home/jc/my.project/README"], "/home/jc/my.project")).toBe(
      "README",
    );
  });
});

describe("nothing to copy", () => {
  it("gives an empty string when no entry is selected", () => {
    expect(clipboardText("path", [], "/home/jc")).toBe("");
  });

  it("still gives the directory, which does not depend on an entry", () => {
    // The chord reaches `d` before it checks for a target, deliberately: the
    // directory you are in is copyable whether or not it holds anything.
    expect(clipboardText("directory", [], "/home/jc/empty")).toBe("/home/jc/empty");
  });
});
