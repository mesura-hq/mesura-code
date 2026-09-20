// @effect-diagnostics nodeBuiltinImport:off - the operations are the file manager's promise-based surface
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  createHostOperations,
  type SpawnedHostProcess,
  type SpawnHostProcess,
  TRASH_BATCH_SIZE,
} from "./hostOperations.ts";

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
  unrefCalls: number;
  killCalls: number;
}

class FakeProcess extends NodeEvents.EventEmitter implements SpawnedHostProcess {
  stderr: NodeStream.Readable | null = new NodeStream.PassThrough();
  private readonly record: Spawned;
  constructor(record: Spawned) {
    super();
    this.record = record;
  }
  kill(): boolean {
    this.record.killCalls += 1;
    return true;
  }
  unref(): void {
    this.record.unrefCalls += 1;
  }
}

/**
 * A spawner that never runs anything: it records the invocation and lets the
 * test script the process's close, stderr, spawn or error.
 */
function fakeSpawner(script: (spawned: Spawned, process: FakeProcess) => void = () => undefined) {
  const spawned: Spawned[] = [];
  const spawn: SpawnHostProcess = (command, args, options) => {
    const record: Spawned = {
      command,
      args,
      options: options as Record<string, unknown>,
      unrefCalls: 0,
      killCalls: 0,
    };
    const process = new FakeProcess(record);
    spawned.push(record);
    queueMicrotask(() => script(record, process));
    return process;
  };
  return { spawn, spawned };
}

/** Operations whose host commands are never reached: the filesystem cases. */
const operationsWithoutSpawning = () => createHostOperations({ spawn: fakeSpawner().spawn });

const enoent = (command: string) =>
  Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-host-ops-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("host operations", () => {
  it("trashes every path in one gio invocation and resolves the count", async () => {
    const { spawn, spawned } = fakeSpawner((_, process) => process.emit("close", 0, null));
    const operations = createHostOperations({ spawn });

    const count = await operations.trash(["/tmp/a", "/tmp/b"]);

    expect(count).toBe(2);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe("gio");
    expect(spawned[0]?.args).toEqual(["trash", "/tmp/a", "/tmp/b"]);
    expect(spawned[0]?.options).toEqual({ stdio: ["ignore", "ignore", "pipe"] });
  });

  it("trashes nothing for an empty selection and spawns nothing", async () => {
    const { spawn, spawned } = fakeSpawner();
    await expect(createHostOperations({ spawn }).trash([])).resolves.toBe(0);
    expect(spawned).toEqual([]);
  });

  it("splits a long selection into batches under the argument limit", async () => {
    const { spawn, spawned } = fakeSpawner((_, process) => process.emit("close", 0, null));
    const paths = Array.from({ length: TRASH_BATCH_SIZE + 1 }, (_, i) => `/tmp/file-${String(i)}`);

    const count = await createHostOperations({ spawn }).trash(paths);

    expect(count).toBe(paths.length);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.args).toHaveLength(TRASH_BATCH_SIZE + 1);
    expect(spawned[1]?.args).toEqual(["trash", `/tmp/file-${String(TRASH_BATCH_SIZE)}`]);
  });

  it("reports gio's stderr when it exits non-zero, read after the stream closed", async () => {
    const { spawn } = fakeSpawner((_, process) => {
      process.stderr?.push("gio: /tmp/a: No such file or directory\n");
      process.stderr?.push(null);
      // `close` follows the streams; the message must be complete by then.
      setImmediate(() => process.emit("close", 1, null));
    });

    await expect(createHostOperations({ spawn }).trash(["/tmp/a"])).rejects.toThrow(
      "gio: /tmp/a: No such file or directory",
    );
  });

  it("falls back to the exit code when there is no stderr to read", async () => {
    const { spawn } = fakeSpawner((_, process) => {
      process.stderr = null;
      process.emit("close", 2, null);
    });

    await expect(createHostOperations({ spawn }).trash(["/tmp/a"])).rejects.toThrow(
      "gio exited with code 2",
    );
  });

  it("says gio is missing when it cannot be spawned", async () => {
    const { spawn } = fakeSpawner((_, process) => process.emit("error", enoent("gio")));

    await expect(createHostOperations({ spawn }).trash(["/tmp/a"])).rejects.toThrow(
      "gio is not installed on the host",
    );
  });

  it("kills and reports a host command that never finishes", async () => {
    vi.useFakeTimers();
    const { spawn, spawned } = fakeSpawner();
    const operations = createHostOperations({ spawn, commandTimeoutMs: 1_000 });

    const pending = operations.trash(["/tmp/a"]);
    const outcome = expect(pending).rejects.toThrow("gio did not finish within 1 seconds");
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;

    expect(spawned[0]?.killCalls).toBe(1);
  });

  it("opens a path on the host desktop detached and without waiting for it", async () => {
    // The script emits `spawn` and never `close`: a desktop program may run for hours.
    const { spawn, spawned } = fakeSpawner((_, process) => process.emit("spawn"));
    const operations = createHostOperations({ spawn });

    const route = await operations.open("/tmp/a.pdf");

    expect(route).toBe("desktop");
    expect(spawned[0]?.command).toBe("xdg-open");
    expect(spawned[0]?.args).toEqual(["/tmp/a.pdf"]);
    expect(spawned[0]?.options).toEqual({ detached: true, stdio: "ignore" });
    expect(spawned[0]?.unrefCalls).toBe(1);
  });

  it("rejects open when the opener cannot be spawned", async () => {
    const { spawn } = fakeSpawner((_, process) => process.emit("error", enoent("xdg-open")));

    await expect(createHostOperations({ spawn }).open("/tmp/a.pdf")).rejects.toThrow(
      "xdg-open is not installed on the host",
    );
  });

  it("creates files and directories with their parents, and renames in place", async () => {
    const operations = operationsWithoutSpawning();

    await operations.create(NodePath.join(root, "deep/er/file.txt"), "file");
    await operations.create(NodePath.join(root, "dir/child"), "directory");
    const renamed = await operations.rename(NodePath.join(root, "deep/er/file.txt"), "moved.txt");

    expect(NodeFS.statSync(NodePath.join(root, "dir/child")).isDirectory()).toBe(true);
    expect(renamed).toBe(NodePath.join(root, "deep/er/moved.txt"));
    expect(NodeFS.existsSync(renamed)).toBe(true);
  });

  it("copies with progress and cancels between entries", async () => {
    const operations = operationsWithoutSpawning();
    const sources = ["one", "two", "three"].map((name) => {
      const path = NodePath.join(root, name);
      NodeFS.writeFileSync(path, name);
      return path;
    });
    const destination = NodePath.join(root, "into");
    NodeFS.mkdirSync(destination);
    const ticks: Array<[number, number]> = [];

    const outcome = await operations.transfer(
      { sources, destination, mode: "copy", overwrite: false, transferId: "t1" },
      (done, total) => {
        ticks.push([done, total]);
        // Cancel after the first entry lands; the loop checks between entries.
        if (done === 1) operations.cancelTransfer("t1");
      },
    );

    expect(ticks[0]).toEqual([0, 3]);
    expect(outcome.moved).toBe(1);
    expect(outcome.conflicts).toEqual([]);
    expect(NodeFS.readdirSync(destination)).toEqual(["one"]);
    expect(NodeFS.existsSync(NodePath.join(root, "one"))).toBe(true);
  });

  it("moves entries and forgets a finished transfer's cancel handle", async () => {
    const operations = operationsWithoutSpawning();
    const source = NodePath.join(root, "gone.txt");
    NodeFS.writeFileSync(source, "x");
    const destination = NodePath.join(root, "into");
    NodeFS.mkdirSync(destination);

    const outcome = await operations.transfer(
      { sources: [source], destination, mode: "move", overwrite: false, transferId: "t2" },
      () => undefined,
    );

    expect(outcome.moved).toBe(1);
    expect(NodeFS.existsSync(source)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(destination, "gone.txt"))).toBe(true);
    // A cancel for a transfer that already finished is a no-op, never a throw.
    expect(() => operations.cancelTransfer("t2")).not.toThrow();
  });

  it("keeps the newest transfer under a reused id cancellable", async () => {
    const operations = operationsWithoutSpawning();
    const many = Array.from({ length: 40 }, (_, i) => {
      const path = NodePath.join(root, `f${String(i)}`);
      NodeFS.writeFileSync(path, "x");
      return path;
    });
    const first = NodePath.join(root, "firsts");
    const second = NodePath.join(root, "seconds");
    NodeFS.mkdirSync(first);
    NodeFS.mkdirSync(second);

    // The first transfer finishes while the second, under the same id, runs.
    const short = operations.transfer(
      {
        sources: many.slice(0, 1),
        destination: first,
        mode: "copy",
        overwrite: false,
        transferId: "same",
      },
      () => undefined,
    );
    const long = operations.transfer(
      { sources: many, destination: second, mode: "copy", overwrite: false, transferId: "same" },
      (done) => {
        if (done === 2) operations.cancelTransfer("same");
      },
    );
    await short;
    const outcome = await long;

    expect(outcome.moved).toBeLessThan(many.length);
  });
});
