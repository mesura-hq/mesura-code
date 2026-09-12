import { describe, expect, it } from "vite-plus/test";

import {
  MonacoFileModelCache,
  monacoFileModelKey,
  type CachedModel,
  type ModelStore,
} from "./monacoFileModels";

class FakeModel implements CachedModel {
  #disposed = false;
  constructor(
    readonly key: string,
    readonly contents: string,
  ) {}
  dispose() {
    this.#disposed = true;
  }
  isDisposed() {
    return this.#disposed;
  }
  getValue() {
    return this.contents;
  }
}

function makeCache(limit?: number) {
  const created: string[] = [];
  const store: ModelStore<FakeModel> = {
    create: (key, contents) => {
      created.push(key);
      return new FakeModel(key, contents);
    },
  };
  const cache = new MonacoFileModelCache<FakeModel, string>(store, limit);
  return { cache, created };
}

/** Acquires and immediately releases, the way opening then leaving a file does. */
function visit(cache: MonacoFileModelCache<FakeModel, string>, key: string, contents = key) {
  const acquired = cache.acquire(key, contents, "plaintext");
  cache.release(key);
  return acquired;
}

describe("MonacoFileModelCache", () => {
  it("hands the same model back when the user returns to a file", () => {
    const { cache, created } = makeCache();

    const first = cache.acquire("a", "contents a", "typescript");
    cache.release("a");
    const second = cache.acquire("a", "contents a", "typescript");

    expect(second.reused).toBe(true);
    expect(second.model).toBe(first.model);
    expect(created).toEqual(["a"]);
  });

  it("builds a new model for a file it has not seen", () => {
    const { cache } = makeCache();

    expect(cache.acquire("a", "contents", "typescript").reused).toBe(false);
  });

  it("keeps each file's model apart", () => {
    const { cache } = makeCache();

    const a = cache.acquire("a", "contents a", "typescript");
    cache.release("a");
    const b = cache.acquire("b", "contents b", "typescript");

    expect(b.model).not.toBe(a.model);
    expect(cache.has("a")).toBe(true);
  });

  it("evicts the least recently used file once the limit is passed", () => {
    const { cache } = makeCache(2);

    visit(cache, "a");
    visit(cache, "b");
    visit(cache, "c");

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("counts a return visit as recent use", () => {
    const { cache } = makeCache(2);

    visit(cache, "a");
    visit(cache, "b");
    visit(cache, "a");
    visit(cache, "c");

    // `b` is now the oldest, because visiting `a` again moved it to the back.
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  it("disposes the model it evicts", () => {
    const { cache } = makeCache(1);

    const evicted = cache.acquire("a", "contents", "plaintext").model;
    cache.release("a");
    visit(cache, "b");

    expect(evicted.isDisposed()).toBe(true);
  });

  it("never evicts the file that is on screen", () => {
    const { cache } = makeCache(1);

    // `a` stays acquired: it is the open file, and the limit is already reached.
    const open = cache.acquire("a", "contents", "plaintext");
    visit(cache, "b");
    visit(cache, "c");

    expect(open.model.isDisposed()).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  it("builds a fresh model when the one it held was disposed elsewhere", () => {
    const { cache } = makeCache();

    const first = cache.acquire("a", "contents", "plaintext");
    cache.release("a");
    // Monaco can dispose a model without telling us; every call on it throws.
    first.model.dispose();

    const second = cache.acquire("a", "contents", "plaintext");
    expect(second.reused).toBe(false);
    expect(second.model).not.toBe(first.model);
  });

  it("carries the view state of a file across a visit to another one", () => {
    const { cache } = makeCache();

    cache.acquire("a", "contents", "plaintext");
    cache.saveViewState("a", "caret at line 40");
    cache.release("a");
    visit(cache, "b");

    expect(cache.viewStateFor("a")).toBe("caret at line 40");
  });

  it("has no view state for a file it never held", () => {
    const { cache } = makeCache();

    expect(cache.viewStateFor("never-opened")).toBeNull();
  });

  it("forgets the view state of an evicted file along with its model", () => {
    const { cache } = makeCache(1);

    cache.acquire("a", "contents", "plaintext");
    cache.saveViewState("a", "caret at line 40");
    cache.release("a");
    visit(cache, "b");

    expect(cache.viewStateFor("a")).toBeNull();
  });

  it("disposes every model it still holds when the panel goes away", () => {
    const { cache } = makeCache();

    const a = cache.acquire("a", "contents", "plaintext").model;
    cache.release("a");
    const b = cache.acquire("b", "contents", "plaintext").model;

    cache.disposeAll();

    expect([a.isDisposed(), b.isDisposed()]).toEqual([true, true]);
    expect(cache.size).toBe(0);
  });
});

describe("monacoFileModelKey", () => {
  it("keeps the same path in two projects apart", () => {
    expect(monacoFileModelKey("local", "/one", "src/a.ts")).not.toBe(
      monacoFileModelKey("local", "/two", "src/a.ts"),
    );
  });

  it("keeps the same path in two environments apart", () => {
    expect(monacoFileModelKey("local", "/repo", "src/a.ts")).not.toBe(
      monacoFileModelKey("remote", "/repo", "src/a.ts"),
    );
  });

  it("is a URI Monaco can parse, with the working directory escaped into one segment", () => {
    const key = monacoFileModelKey("local", "/home/dev/repo", "src/a.ts");

    expect(key).toBe("mesura-file:///local/%2Fhome%2Fdev%2Frepo/src/a.ts");
    expect(() => new URL(key)).not.toThrow();
  });

  it("does not let one project's path collide with another's", () => {
    // Without escaping, cwd `/a` + path `b/c.ts` and cwd `/a/b` + path `c.ts`
    // would produce the same string.
    expect(monacoFileModelKey("local", "/a", "b/c.ts")).not.toBe(
      monacoFileModelKey("local", "/a/b", "c.ts"),
    );
  });
});
