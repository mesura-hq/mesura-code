import { describe, expect, it } from "vite-plus/test";

import { FileEditorRetention } from "./fileEditorRetention";

describe("FileEditorRetention", () => {
  it("refuses reuse for a path it never saw", () => {
    const retention = new FileEditorRetention();

    expect(retention.canReuse("src/a.ts", "contents")).toBe(false);
  });

  it("reuses a retained document when the query contents still match", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { contents: "edited" });

    expect(retention.canReuse("src/a.ts", "edited")).toBe(true);
  });

  it("refuses reuse when the file changed underneath the retained document", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { contents: "edited" });

    // An agent rewrote the file while another file was open.
    expect(retention.canReuse("src/a.ts", "rewritten by the agent")).toBe(false);
  });

  it("keeps each path independent", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { contents: "a" });
    retention.noteEditorFile("src/b.ts", { contents: "b" });

    expect(retention.canReuse("src/a.ts", "a")).toBe(true);
    expect(retention.canReuse("src/b.ts", "b")).toBe(true);
    expect(retention.canReuse("src/a.ts", "b")).toBe(false);
  });

  it("overwrites the retained document when the same path is noted again", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { contents: "first" });
    retention.noteEditorFile("src/a.ts", { contents: "second" });

    expect(retention.canReuse("src/a.ts", "first")).toBe(false);
    expect(retention.canReuse("src/a.ts", "second")).toBe(true);
  });

  it("forgets one path without touching the others", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { contents: "a" });
    retention.noteEditorFile("src/b.ts", { contents: "b" });

    retention.forget("src/a.ts");

    expect(retention.canReuse("src/a.ts", "a")).toBe(false);
    expect(retention.canReuse("src/b.ts", "b")).toBe(true);
  });

  it("clears every retained path", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { contents: "a" });
    retention.noteEditorFile("src/b.ts", { contents: "b" });

    retention.clear();

    expect(retention.canReuse("src/a.ts", "a")).toBe(false);
    expect(retention.canReuse("src/b.ts", "b")).toBe(false);
  });
});
