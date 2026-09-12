import { describe, expect, it } from "vite-plus/test";

import { FileEditorRetention } from "./fileEditorRetention";

describe("FileEditorRetention", () => {
  it("has no identity for a path it never saw", () => {
    const retention = new FileEditorRetention();

    expect(retention.identityFor("src/a.ts")).toBeUndefined();
    expect(retention.canReuse("src/a.ts", "contents")).toBe(false);
  });

  it("reuses a retained document when the query contents still match", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { cacheKey: "key-a", contents: "edited" });

    expect(retention.canReuse("src/a.ts", "edited")).toBe(true);
    expect(retention.identityFor("src/a.ts")).toEqual({ cacheKey: "key-a", contents: "edited" });
  });

  it("refuses reuse when the file changed underneath the retained document", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { cacheKey: "key-a", contents: "edited" });

    // An agent rewrote the file while another file was open.
    expect(retention.canReuse("src/a.ts", "rewritten by the agent")).toBe(false);
  });

  it("keeps each path independent", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { cacheKey: "key-a", contents: "a" });
    retention.noteEditorFile("src/b.ts", { cacheKey: "key-b", contents: "b" });

    expect(retention.canReuse("src/a.ts", "a")).toBe(true);
    expect(retention.canReuse("src/b.ts", "b")).toBe(true);
    expect(retention.identityFor("src/b.ts")?.cacheKey).toBe("key-b");
  });

  it("overwrites the retained identity when the same path is noted again", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { cacheKey: "key-1", contents: "first" });
    retention.noteEditorFile("src/a.ts", { cacheKey: "key-2", contents: "second" });

    expect(retention.canReuse("src/a.ts", "first")).toBe(false);
    expect(retention.identityFor("src/a.ts")).toEqual({ cacheKey: "key-2", contents: "second" });
  });

  it("forgets one path without touching the others", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { cacheKey: "key-a", contents: "a" });
    retention.noteEditorFile("src/b.ts", { cacheKey: "key-b", contents: "b" });

    retention.forget("src/a.ts");

    expect(retention.identityFor("src/a.ts")).toBeUndefined();
    expect(retention.canReuse("src/a.ts", "a")).toBe(false);
    expect(retention.canReuse("src/b.ts", "b")).toBe(true);
  });

  it("clears every retained path", () => {
    const retention = new FileEditorRetention();
    retention.noteEditorFile("src/a.ts", { cacheKey: "key-a", contents: "a" });
    retention.noteEditorFile("src/b.ts", { cacheKey: "key-b", contents: "b" });

    retention.clear();

    expect(retention.identityFor("src/a.ts")).toBeUndefined();
    expect(retention.identityFor("src/b.ts")).toBeUndefined();
  });

  it("refuses reuse when the retained entry carries no cache key", () => {
    const retention = new FileEditorRetention();
    // Pierre attaches `cacheKey` when it adopts a document; before that it is absent.
    retention.noteEditorFile("src/a.ts", { contents: "edited" });

    expect(retention.canReuse("src/a.ts", "edited")).toBe(false);
  });
});
