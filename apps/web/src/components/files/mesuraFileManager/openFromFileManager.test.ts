import { describe, expect, it } from "vite-plus/test";

import { decideOpenFromFileManager } from "./openFromFileManager";

const cwd = "/home/dev/repos/app";

describe("decideOpenFromFileManager", () => {
  it("opens a file under the project in the editor, by its relative path", () => {
    expect(decideOpenFromFileManager(cwd, `${cwd}/src/index.ts`)).toEqual({
      kind: "editor",
      relativePath: "src/index.ts",
    });
  });

  it("hands a file outside the project to the host", () => {
    expect(decideOpenFromFileManager(cwd, "/home/dev/notes.md")).toEqual({ kind: "host" });
    // A sibling whose name merely starts with the project's is outside it.
    expect(decideOpenFromFileManager(cwd, `${cwd}-old/README.md`)).toEqual({ kind: "host" });
  });

  it("hands the project directory itself to the host", () => {
    expect(decideOpenFromFileManager(cwd, cwd)).toEqual({ kind: "host" });
  });
});
