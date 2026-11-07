import { describe, expect, it } from "vite-plus/test";

import { terminalPathPanelTarget } from "./terminalPathPanelTarget";

describe("terminalPathPanelTarget", () => {
  it("opens a relative link by its workspace path, with its line", () => {
    expect(terminalPathPanelTarget("src/app.ts:12:3", "/repo", "/repo")).toEqual({
      path: "src/app.ts",
      line: 12,
    });
  });

  it("resolves a link from a terminal in a subfolder against the workspace root", () => {
    expect(terminalPathPanelTarget("app.ts", "/repo/src", "/repo")).toEqual({
      path: "src/app.ts",
      line: undefined,
    });
  });

  it("opens an absolute path inside the workspace by its workspace path", () => {
    expect(terminalPathPanelTarget("/repo/README.md:4", "/repo", "/repo")).toEqual({
      path: "README.md",
      line: 4,
    });
  });

  it("opens a path outside the workspace as a host file", () => {
    expect(terminalPathPanelTarget("/etc/hosts", "/repo", "/repo")).toEqual({
      path: "/etc/hosts",
      line: undefined,
    });
  });
});
