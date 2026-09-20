/**
 * The pool: one index per directory, retired when it goes idle.
 *
 * Acceptance criteria 1, 3 and 4. The spawn is injected, so this exercises the
 * lifetime rules — keying, reuse, retirement, restart — without needing a
 * process. `topology.test.ts` covers the part that genuinely needs two.
 *
 * Time is injected too, and retirement is swept explicitly rather than by a
 * timer. A test that waits on a real clock is a test that is slow when it
 * passes and flaky when it does not.
 */
import { describe, expect, it } from "vitest";

import { createIndexPool, type IndexWorker, type SearchReply } from "../src/main/pool.ts";

/** A worker that records what happened to it, and never spawns anything. */
function fakeWorker(directory: string, log: string[], ready?: Promise<void>): IndexWorker {
  log.push(`spawn:${directory}`);
  return {
    directory,
    ready: ready ?? Promise.resolve(),
    search: (query: string): Promise<SearchReply> =>
      Promise.resolve({ rows: [], matchedQuery: query, truncated: false, cap: 200 }),
    record: (query: string, chosenPath: string) =>
      log.push(`record:${directory}:${query}:${chosenPath}`),
    refresh: () => log.push(`refresh:${directory}`),
    close: () => log.push(`close:${directory}`),
  };
}

function poolWith(log: string[], clock: { value: number }) {
  return createIndexPool({
    spawn: (directory) => fakeWorker(directory, log),
    idleMs: 1000,
    now: () => clock.value,
  });
}

describe("one index per directory", () => {
  it("spawns a worker the first time a directory is asked for", () => {
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/a");
    expect(log).toEqual(["spawn:/a"]);
    expect(pool.size()).toBe(1);
  });

  it("reuses the same worker for the same directory", () => {
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    const first = pool.acquire("/a");
    const second = pool.acquire("/a");
    expect(second).toBe(first);
    expect(log).toEqual(["spawn:/a"]);
  });

  it("keeps a separate worker per directory, both alive at once", () => {
    // The store refuses a second open inside ONE process, which is why the
    // unit of isolation is the process and the key is the directory.
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/a");
    pool.acquire("/b");
    expect(pool.size()).toBe(2);
    expect(log).toEqual(["spawn:/a", "spawn:/b"]);
  });
});

describe("retiring an idle index", () => {
  it("closes a worker that has not been searched for its idle timeout", () => {
    const log: string[] = [];
    const clock = { value: 0 };
    const pool = poolWith(log, clock);
    pool.acquire("/a");

    clock.value = 1001;
    pool.sweep();

    expect(log).toContain("close:/a");
    expect(pool.size()).toBe(0);
  });

  it("keeps a worker that is still inside its timeout", () => {
    const log: string[] = [];
    const clock = { value: 0 };
    const pool = poolWith(log, clock);
    pool.acquire("/a");

    clock.value = 999;
    pool.sweep();

    expect(log).not.toContain("close:/a");
    expect(pool.size()).toBe(1);
  });

  it("counts a search as activity, so a busy index is never retired", async () => {
    const log: string[] = [];
    const clock = { value: 0 };
    const pool = poolWith(log, clock);
    pool.acquire("/a");

    clock.value = 900;
    await pool.search("/a", "q");
    clock.value = 1500;
    pool.sweep();

    expect(log).not.toContain("close:/a");
    expect(pool.size()).toBe(1);
  });

  it("retires only the idle one when two are open", async () => {
    const log: string[] = [];
    const clock = { value: 0 };
    const pool = poolWith(log, clock);
    pool.acquire("/a");
    pool.acquire("/b");

    clock.value = 900;
    await pool.search("/b", "q");
    clock.value = 1500;
    pool.sweep();

    expect(log).toContain("close:/a");
    expect(log).not.toContain("close:/b");
    expect(pool.size()).toBe(1);
  });
});

describe("after a retirement", () => {
  it("gives a fresh worker when the directory is searched again", async () => {
    const log: string[] = [];
    const clock = { value: 0 };
    const pool = poolWith(log, clock);
    pool.acquire("/a");
    clock.value = 1001;
    pool.sweep();

    const reply = await pool.search("/a", "q");

    expect(log).toEqual(["spawn:/a", "close:/a", "spawn:/a"]);
    expect(reply.matchedQuery).toBe("q");
  });
});

describe("releasing and closing", () => {
  it("closes the worker for a directory that is released", () => {
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/a");
    pool.release("/a");
    expect(log).toContain("close:/a");
    expect(pool.size()).toBe(0);
  });

  it("ignores a release for a directory it never opened", () => {
    // Paired with a release that DOES close, so a `release` that does nothing
    // at all cannot pass this test.
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/opened");
    expect(() => pool.release("/never")).not.toThrow();
    expect(log).toEqual(["spawn:/opened"]);
    pool.release("/opened");
    expect(log).toEqual(["spawn:/opened", "close:/opened"]);
  });

  it("closes every worker on shutdown, so none outlives its owner", () => {
    // A leaked worker is the failure that takes the resident daemon with it.
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/a");
    pool.acquire("/b");
    pool.closeAll();
    expect(log).toContain("close:/a");
    expect(log).toContain("close:/b");
    expect(pool.size()).toBe(0);
  });
});

describe("the reply a search returns", () => {
  it("names the query it answered, so a stale reply can be discarded", async () => {
    // Without this the highlighter runs against half-typed input: the reply to
    // "fo" arrives after the user has typed "form" and is drawn against it.
    const pool = poolWith([], { value: 0 });
    const reply = await pool.search("/a", "form");
    expect(reply.matchedQuery).toBe("form");
  });

  it("says whether the list was truncated, and at what cap", async () => {
    // The Qt finder shows "200 results" whether there are 200 or 20,000.
    const pool = poolWith([], { value: 0 });
    const reply = await pool.search("/a", "e");
    expect(reply.truncated).toBe(false);
    expect(reply.cap).toBe(200);
  });
});

describe("starting an index that cannot open", () => {
  it("rejects, rather than reporting a start that did not happen", async () => {
    const log: string[] = [];
    const pool = createIndexPool({
      spawn: (directory) =>
        fakeWorker(directory, log, Promise.reject(new Error("permission denied"))),
      idleMs: 1000,
      now: () => 0,
    });
    await expect(pool.start("/a")).rejects.toThrow("permission denied");
  });

  it("drops the failed worker, so the next start spawns a fresh one", async () => {
    // Kept in the map, a worker whose index never opened answers every later
    // search with the same stale reason and nothing ever replaces it — a
    // directory that was merely slow to mount would look permanently broken.
    const log: string[] = [];
    let attempt = 0;
    const pool = createIndexPool({
      spawn: (directory) => {
        attempt += 1;
        return fakeWorker(
          directory,
          log,
          attempt === 1 ? Promise.reject(new Error("nope")) : undefined,
        );
      },
      idleMs: 1000,
      now: () => 0,
    });

    await expect(pool.start("/a")).rejects.toThrow("nope");
    expect(pool.size()).toBe(0);

    // The second attempt succeeds and IS kept — paired so a pool that dropped
    // every worker could not pass the assertion above for free.
    await expect(pool.start("/a")).resolves.toBeUndefined();
    expect(pool.size()).toBe(1);
    expect(log).toEqual(["spawn:/a", "close:/a", "spawn:/a"]);
  });

  it("leaves a healthy worker alone when a different directory fails", async () => {
    const log: string[] = [];
    const pool = createIndexPool({
      spawn: (directory) =>
        fakeWorker(
          directory,
          log,
          directory === "/bad" ? Promise.reject(new Error("nope")) : undefined,
        ),
      idleMs: 1000,
      now: () => 0,
    });
    await pool.start("/good");
    await expect(pool.start("/bad")).rejects.toThrow("nope");
    expect(pool.size()).toBe(1);
    expect(pool.acquire("/good").directory).toBe("/good");
  });
});

describe("starting an index that opens", () => {
  it("reuses the worker a plain acquire already spawned, and re-scans it", async () => {
    // The re-scan is the point rather than an accident: `acquire` left an index
    // whose snapshot is however old that call was, and `start` is the moment a
    // user is about to read it. One worker, not two.
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/a");
    await pool.start("/a");
    expect(log).toEqual(["spawn:/a", "refresh:/a"]);
    expect(pool.size()).toBe(1);
  });
});

describe("recording which file a query chose", () => {
  it("passes the query and the chosen path to that directory's worker", () => {
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/a");
    pool.record("/a", "fmt", "/a/src/format.ts");
    expect(log).toEqual(["spawn:/a", "record:/a:fmt:/a/src/format.ts"]);
  });

  it("says nothing for a directory with no open index", () => {
    // Spawning a whole process to write a statistic nobody reads is a worse
    // trade than losing the statistic. Paired with a directory that IS open, so
    // a `record` that did nothing at all could not pass this.
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    pool.acquire("/open");
    expect(() => pool.record("/closed", "q", "/closed/a.ts")).not.toThrow();
    expect(log).toEqual(["spawn:/open"]);
    pool.record("/open", "q", "/open/a.ts");
    expect(log).toEqual(["spawn:/open", "record:/open:q:/open/a.ts"]);
  });
});

describe("starting an index that is already warm", () => {
  it("asks the engine to re-scan, because the open one is a snapshot", async () => {
    // The defect this exists for. Closing the finder deliberately does NOT
    // release the index, so reopening reuses a scan taken whenever the index
    // opened — verification watched a file's modification time stay at its
    // pre-edit value across a close and a reopen.
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    await pool.start("/a");
    await pool.start("/a");
    expect(log).toEqual(["spawn:/a", "refresh:/a"]);
  });

  it("does not re-scan an index it has only just opened", async () => {
    // A worker spawned now has nothing to refresh: its scan is the one `ready`
    // waited for. Paired with the case above, so a `start` that refreshed
    // unconditionally could not pass both.
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    await pool.start("/a");
    expect(log).toEqual(["spawn:/a"]);
  });

  it("re-scans only the directory being started", async () => {
    const log: string[] = [];
    const pool = poolWith(log, { value: 0 });
    await pool.start("/a");
    await pool.start("/b");
    await pool.start("/a");
    expect(log).toEqual(["spawn:/a", "spawn:/b", "refresh:/a"]);
  });

  it("re-scans nothing after the worker was retired, and spawns instead", async () => {
    const log: string[] = [];
    const clock = { value: 0 };
    const pool = poolWith(log, clock);
    await pool.start("/a");
    clock.value = 1001;
    pool.sweep();
    await pool.start("/a");
    expect(log).toEqual(["spawn:/a", "close:/a", "spawn:/a"]);
  });
});
