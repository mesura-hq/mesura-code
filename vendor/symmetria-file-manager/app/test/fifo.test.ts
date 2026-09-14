import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CANCELLED_SENTINEL, selectionPayload } from "@symmetria/fm-core/command";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeToFifo } from "../src/main/fifo.ts";

const run = promisify(execFile);

/**
 * Answering a caller that is blocked on a named pipe.
 *
 * This is the half of the picker with no user interface and the half that
 * decides whether another application hangs. The portal opens the FIFO for
 * reading and blocks for up to five minutes; everything here is about making
 * sure something arrives before then, whatever the user does or fails to do.
 *
 * Driven against real FIFOs in a temporary directory. There is nothing to mock:
 * the behaviour under test IS the kernel's — a write-only open of a FIFO with no
 * reader fails `ENXIO` under `O_NONBLOCK` and blocks without it, and that
 * difference is the whole design.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fm-fifo-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A real FIFO, made the way the portal makes one. */
async function makeFifo(name: string): Promise<string> {
  const path = join(dir, name);
  await run("mkfifo", ["-m", "600", path]);
  return path;
}

/**
 * Read the FIFO to end-of-file, starting the read BEFORE the write.
 *
 * Returned unawaited on purpose: opening a FIFO for reading blocks until a
 * writer arrives, exactly as it does in the portal, so awaiting it here would
 * deadlock the test against the write that has not happened yet.
 */
function readerFor(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("what the reader receives", () => {
  it("gets the chosen paths, newline-separated", async () => {
    const fifo = await makeFifo("a");
    const reading = readerFor(fifo);

    const outcome = await writeToFifo(fifo, selectionPayload(["/home/jc/one.txt", "/tmp/two.pdf"]));

    expect(outcome.ok).toBe(true);
    // Parsed the way `portal/symmetria_portal.py` parses it: strip, split on
    // newlines, drop the empties. A payload that needs different parsing is a
    // payload the existing backend cannot read.
    const lines = (await reading)
      .trim()
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toEqual(["/home/jc/one.txt", "/tmp/two.pdf"]);
  });

  it("gets a single path with no stray separator", async () => {
    const fifo = await makeFifo("b");
    const reading = readerFor(fifo);

    await writeToFifo(fifo, selectionPayload(["/home/jc/only.txt"]));

    expect((await reading).trim()).toBe("/home/jc/only.txt");
  });

  it("gets exactly the cancellation sentinel when the user cancels", async () => {
    // The literal is a protocol constant shared with the Qt build and with the
    // portal — `host/standalone/main.qml` and `portal/symmetria_portal.py` both
    // spell it. A backend that read a different word would treat a cancel as a
    // chosen file named `__PICKER_CANCELLED__`.
    const fifo = await makeFifo("c");
    const reading = readerFor(fifo);

    await writeToFifo(fifo, CANCELLED_SENTINEL);

    expect((await reading).trim()).toBe("__PICKER_CANCELLED__");
  });
});

describe("a FIFO with no reader", () => {
  it("fails rather than blocking, and says the caller went away", async () => {
    // Nobody is reading. Under `O_NONBLOCK` a write-only open answers `ENXIO`
    // immediately; WITHOUT it the open blocks, and `fs.promises.open` would
    // park one of libuv's four threadpool threads for as long as that lasted.
    const fifo = await makeFifo("d");

    const started = Date.now();
    const outcome = await writeToFifo(fifo, "anything", { timeoutMs: 300, retryMs: 20 });

    expect(outcome.ok).toBe(false);
    // It gave up on its own deadline rather than being killed by the test's.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("keeps trying, and succeeds when the reader finally arrives", async () => {
    // The real sequence is the other way round — the portal is already blocked
    // reading before it ever sends the command — but a reader that is late must
    // not lose the answer.
    const fifo = await makeFifo("e");

    const writing = writeToFifo(fifo, "late reader", { timeoutMs: 5_000, retryMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reading = readerFor(fifo);

    expect((await writing).ok).toBe(true);
    expect((await reading).trim()).toBe("late reader");
  });

  it("leaves the process able to do other work while it waits", async () => {
    // Eight concurrent unanswered writes — twice libuv's default threadpool —
    // and an ordinary file read alongside them. A blocking open would starve
    // the pool and this read would not finish until the writes gave up.
    const fifos = await Promise.all(
      ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"].map((name) => makeFifo(name)),
    );
    const other = join(dir, "ordinary.txt");
    await writeFile(other, "still responsive");

    const waiting = Promise.all(
      fifos.map((path) => writeToFifo(path, "x", { timeoutMs: 2_000, retryMs: 20 })),
    );

    const started = Date.now();
    const read = await readFile(other, "utf8");
    const elapsed = Date.now() - started;

    expect(read).toBe("still responsive");
    expect(elapsed).toBeLessThan(500);
    await waiting;
  });
});

describe("what it refuses to write to", () => {
  it("refuses a path that is a regular file rather than a FIFO", async () => {
    // `/tmp` is world-writable, and any local process may name the path in a
    // `createPicker`. Without this check, one could have the file manager write
    // the user's chosen filenames into a file of its choosing. The portal
    // defends its READ side the same way, with an `fstat` after the open; this
    // is the mirror of it, and the Qt build does not have it.
    const ordinary = join(dir, "not-a-fifo");
    await writeFile(ordinary, "original contents");

    const outcome = await writeToFifo(ordinary, "should not land", { timeoutMs: 300 });

    expect(outcome.ok).toBe(false);
    expect(await readFile(ordinary, "utf8")).toBe("original contents");
  });

  it("refuses a symlink standing where the FIFO should be", async () => {
    // The substitution attack the check exists for: the attacker pre-creates
    // the path as a link to something they want overwritten. Checking the path
    // before opening it would lose the race; the open itself has to refuse.
    const target = join(dir, "victim.txt");
    await writeFile(target, "untouched");
    const link = join(dir, "link");
    await symlink(target, link);

    const outcome = await writeToFifo(link, "should not land", { timeoutMs: 300 });

    expect(outcome.ok).toBe(false);
    expect(await readFile(target, "utf8")).toBe("untouched");
  });

  it("refuses a path that is not there at all", async () => {
    const outcome = await writeToFifo(join(dir, "absent"), "x", { timeoutMs: 300 });

    expect(outcome.ok).toBe(false);
  });
});

describe("two answers at once", () => {
  it("delivers both, neither losing the other's path", async () => {
    // The Qt build needed a queue here: it had ONE writer process whose target
    // path was a mutable property, so two rejections in flight clobbered each
    // other. Each write below owns its own descriptor, so there is nothing to
    // clobber — this asserts that property rather than assuming it.
    const first = await makeFifo("g1");
    const second = await makeFifo("g2");
    const readingFirst = readerFor(first);
    const readingSecond = readerFor(second);

    await Promise.all([
      writeToFifo(first, selectionPayload(["/one"])),
      writeToFifo(second, CANCELLED_SENTINEL),
    ]);

    expect((await readingFirst).trim()).toBe("/one");
    expect((await readingSecond).trim()).toBe(CANCELLED_SENTINEL);
  });
});
