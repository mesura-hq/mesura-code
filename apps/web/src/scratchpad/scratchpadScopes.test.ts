import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableScratchpadScopes,
  cycleScratchpadScope,
  initialScratchpadScope,
  scratchpadKeyAction,
  scratchpadPreviewLines,
  scratchpadRelativePath,
} from "./scratchpadScopes";

const owner = { projectId: ProjectId.make("p1"), threadId: ThreadId.make("t1") };
const projectless = { projectId: null, threadId: ThreadId.make("t1") };
const draft = { projectId: ProjectId.make("p1"), threadId: null };

describe("scratchpad scopes", () => {
  it("names one file per scope", () => {
    expect(scratchpadRelativePath("general", owner)).toBe("general.md");
    expect(scratchpadRelativePath("project", owner)).toBe("projects/p1.md");
    expect(scratchpadRelativePath("thread", owner)).toBe("threads/t1.md");
  });

  it("drops the project scope for a thread without a project and starts elsewhere", () => {
    const available = availableScratchpadScopes(projectless);
    expect(available).toEqual(["general", "thread"]);
    expect(initialScratchpadScope(available)).toBe("general");
    expect(initialScratchpadScope(availableScratchpadScopes(owner))).toBe("project");
  });

  it("wraps around in both directions", () => {
    const available = availableScratchpadScopes(owner);
    expect(cycleScratchpadScope("thread", available, 1)).toBe("general");
    expect(cycleScratchpadScope("general", available, -1)).toBe("thread");
    expect(cycleScratchpadScope("project", available, 1)).toBe("thread");
  });

  it("previews the first lines that carry text", () => {
    expect(scratchpadPreviewLines("\n# Notes\n\n- one\n- two\n- three\n")).toEqual([
      "# Notes",
      "- one",
      "- two",
    ]);
  });

  it("keeps ids with colons usable as file names", () => {
    const owner = {
      projectId: ProjectId.make("p1"),
      threadId: ThreadId.make("thread:project:p1:abc"),
    };
    expect(scratchpadRelativePath("thread", owner)).toBe("threads/thread_3aproject_3ap1_3aabc.md");
  });

  it("never gives two ids the same file, whatever their case or punctuation", () => {
    const pathFor = (id: string) =>
      scratchpadRelativePath("thread", { projectId: null, threadId: ThreadId.make(id) });
    const ids = ["a:b", "a_b", "A_b", "a_3ab", "Ab", "ab"];
    const paths = ids.map(pathFor);
    expect(new Set(paths.map((path) => path?.toLowerCase())).size).toBe(ids.length);
  });

  it("offers no thread scope to a draft, whose id can change when it is sent", () => {
    expect(availableScratchpadScopes(draft)).toEqual(["general", "project"]);
  });
});

describe("scratchpad keys", () => {
  const key = (name: string, extra: Partial<Parameters<typeof scratchpadKeyAction>[0]> = {}) => ({
    key: name,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...extra,
  });
  const normal = { hasTextFocus: true, restsInNormalMode: true };
  const insert = { hasTextFocus: true, restsInNormalMode: false };
  const unfocused = { hasTextFocus: false, restsInNormalMode: false };

  it("cycles scopes with Tab and Shift+Tab and closes with Escape in normal mode", () => {
    expect(scratchpadKeyAction(key("Tab"), normal)).toBe("next-scope");
    expect(scratchpadKeyAction(key("Tab", { shiftKey: true }), normal)).toBe("previous-scope");
    expect(scratchpadKeyAction(key("Escape"), normal)).toBe("close");
  });

  it("leaves Tab and Escape to Neovim outside plain normal mode", () => {
    expect(scratchpadKeyAction(key("Tab"), insert)).toBeNull();
    expect(scratchpadKeyAction(key("Escape"), insert)).toBeNull();
  });

  it("acts when the editor lacks focus, and ignores chords and other keys", () => {
    expect(scratchpadKeyAction(key("Escape"), unfocused)).toBe("close");
    expect(scratchpadKeyAction(key("Tab", { ctrlKey: true }), normal)).toBeNull();
    expect(scratchpadKeyAction(key("Tab", { isComposing: true }), normal)).toBeNull();
    expect(scratchpadKeyAction(key("j"), normal)).toBeNull();
  });
});
