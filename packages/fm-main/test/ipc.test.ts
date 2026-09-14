import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BookmarksReply,
  DescribeReply,
  IpcReply,
  ListBatch,
  ListReply,
} from "@symmetria/fm-core/contract";

import type { FsEntry } from "@symmetria/fm-core/entry";
import { DEFAULT_LISTING_OPTIONS } from "@symmetria/fm-core/listingOptions";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNELS, REQUEST_CHANNELS } from "../src/ipc/channels.ts";
import { electronIpcSurface, type InvokeEvent } from "../src/ipc/electronSurface.ts";
import {
  createRegistry,
  type IpcHandler,
  type IpcSurface,
  MAX_DIRECTORY_PREVIEW_ENTRIES,
  type SenderHandle,
} from "../src/ipc/register.ts";

/**
 * The host's job, faked.
 *
 * `createRegistry` takes this rather than importing it: the URL carries
 * whichever private scheme the HOST serves its renderer from, and the
 * privileged half cannot know that. A deliberately unreal scheme here means an
 * assertion on a preview URL can only pass through the injected path.
 */
const previewUrlFor = (token: string) => `test-host://preview/${token}`;

/**
 * A stand-in for Electron's `ipcMain`.
 *
 * The registry is deliberately handed its transport rather than importing
 * `electron`, so the routing, decoding and error handling are testable in plain
 * Node — the same reasoning that keeps `buildWindowOptions` and
 * `resolveWithinRoot` free of a runtime Electron import.
 */
interface FakeIpc extends IpcSurface {
  invoke(channel: string, payload: unknown): Promise<IpcReply>;
  /** Everything the registry pushed back to the one window below. */
  readonly pushed: { channel: string; payload: unknown }[];
}

function fakeIpc(): FakeIpc {
  const handlers = new Map<string, IpcHandler>();
  const pushed: { channel: string; payload: unknown }[] = [];

  /**
   * The one window every test in this file drives.
   *
   * The registry routes by sender, and a window IS the thing you push to — so
   * this single handle is both the identity and the recorder. Every assertion
   * in this file is about one window, which is why one serves them all; the
   * two-window assertions live in `ipc-routing.test.ts`, where telling them
   * apart is the whole subject.
   */
  const onlyWindow: SenderHandle = {
    send: (channel, payload) => {
      pushed.push({ channel, payload });
    },
  };

  return {
    pushed,
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    invoke(channel, payload) {
      const handler = handlers.get(channel);
      if (!handler) return Promise.reject(new Error(`no handler for ${channel}`));
      return handler(payload, onlyWindow);
    },
  };
}

/** Names out of a successful list reply, sorted. */
function names(value: unknown): string[] {
  return (value as ListReply).entries.map((e: FsEntry) => e.name).sort();
}

let root: string;

/**
 * Two directories of their own, beside `root` rather than inside it.
 *
 * `root`'s listing is asserted exactly by the tests above it, so anything added
 * there would break them for no reason connected to what it is testing.
 */
let kinds: string;
/** More entries than the preview cap, so the cap is observable. */
let capped: string;
/** Mixed kinds and distinct sizes, for the ordering assertions. */
let ordered: string;
const BIG_COUNT = MAX_DIRECTORY_PREVIEW_ENTRIES + 37;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "symfm-ipc-"));
  await writeFile(join(root, "alpha.txt"), "twelve bytes");
  await writeFile(join(root, "beta.md"), "x");

  const scratch = await mkdtemp(join(tmpdir(), "symfm-dirs-"));
  kinds = join(scratch, "kinds");
  await mkdir(kinds);
  await writeFile(join(kinds, "alpha.txt"), "x");
  await mkdir(join(kinds, "sub"));
  // A symlink's own dirent type is neither file nor directory, so these three
  // are what prove the listing resolves the target rather than the link.
  await symlink(join(kinds, "sub"), join(kinds, "link-to-dir"));
  await symlink(join(kinds, "alpha.txt"), join(kinds, "link-to-file"));
  await symlink(join(kinds, "gone"), join(kinds, "link-broken"));

  // Distinct sizes and two directories, so every ordering question below has a
  // different right answer and none of them can be satisfied by accident.
  ordered = join(scratch, "ordered");
  await mkdir(ordered);
  await mkdir(join(ordered, "a-dir"));
  await mkdir(join(ordered, "z-dir"));
  await writeFile(join(ordered, "small.txt"), "x");
  await writeFile(join(ordered, "mid.txt"), "x".repeat(50));
  await writeFile(join(ordered, "big.txt"), "x".repeat(300));

  capped = join(scratch, "capped");
  await mkdir(capped);
  // Zero-padded so the names sort the way a person would expect them to.
  for (let i = 0; i < BIG_COUNT; i++) {
    await writeFile(join(capped, `f${String(i).padStart(4, "0")}.txt`), "x");
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the bridge returns what the main process produced", () => {
  it("lists a directory", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.list, { path: root });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(names(reply.value)).toEqual(["alpha.txt", "beta.md"]);
  });

  it("reports a failure as a value, never as a thrown error", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.list, { path: "/does/not/exist" });

    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("scan_failed");
  });
});

/**
 * Ordering, against the real handler.
 *
 * Not in the renderer suite, and not because it would be inconvenient there:
 * the renderer never orders anything. It sends a request and the main process
 * decides, so this is the only place the two halves meet on real files.
 *
 * `listing` keeps the returned order. The helper above it sorts, which is
 * exactly what an ordering assertion must not do.
 */
function listing(value: unknown): string[] {
  return (value as ListReply).entries.map((e: FsEntry) => e.name);
}

describe("the listing comes back in the order that was asked for", () => {
  it("puts the smallest file first when asked for the size order", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.list, { path: ordered, sort: "size" });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(listing(reply.value)).toEqual(["a-dir", "z-dir", "small.txt", "mid.txt", "big.txt"]);
  });

  it("puts the largest first when the order is reversed", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.list, {
      path: ordered,
      sort: "size",
      reverse: true,
    });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    // The directories are reversed among themselves and STAY ABOVE the files.
    // Reversing the finished array would have put `big.txt` first and the
    // directories last, which is the one thing every order holds against.
    expect(listing(reply.value)).toEqual(["z-dir", "a-dir", "big.txt", "mid.txt", "small.txt"]);
  });

  it("keeps directories above files in every order, reversed or not", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    for (const sort of ["alphabetical", "modified", "size", "extension", "natural"]) {
      for (const reverse of [false, true]) {
        const reply = await ipc.invoke(CHANNELS.list, { path: ordered, sort, reverse });
        expect(reply.ok).toBe(true);
        if (!reply.ok) return;

        const kinds = (reply.value as ListReply).entries.map((e: FsEntry) => e.kind);
        const lastDirectory = kinds.lastIndexOf("directory");
        const firstFile = kinds.indexOf("file");
        expect(lastDirectory, `${sort} reverse=${reverse}`).toBeLessThan(firstFile);
      }
    }
  });

  it("treats a missing reverse field as not reversed", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const withOut = await ipc.invoke(CHANNELS.list, { path: ordered, sort: "size" });
    const withFalse = await ipc.invoke(CHANNELS.list, {
      path: ordered,
      sort: "size",
      reverse: false,
    });

    expect(withOut.ok && withFalse.ok).toBe(true);
    if (!withOut.ok || !withFalse.ok) return;
    expect(listing(withOut.value)).toEqual(listing(withFalse.value));
  });
});

describe("the boundary rejects before the handler runs", () => {
  it("never enters the handler on a malformed payload", async () => {
    const scan = vi.fn();
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor, scanDirectory: scan });

    const reply = await ipc.invoke(CHANNELS.list, { path: 7 });

    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("invalid_request");
    // The point of decoding at the boundary: the handler is not merely given
    // bad input to cope with, it is never called at all.
    expect(scan).not.toHaveBeenCalled();
  });

  it("rejects a relative path without touching the filesystem", async () => {
    const scan = vi.fn();
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor, scanDirectory: scan });

    await ipc.invoke(CHANNELS.list, { path: "../../etc" });

    expect(scan).not.toHaveBeenCalled();
  });
});

describe("the channel surface is closed", () => {
  it("registers exactly the request channels, and nothing else", async () => {
    const registered: string[] = [];
    const ipc: IpcSurface = {
      handle(channel) {
        registered.push(channel);
      },
      removeHandler() {},
    };

    createRegistry(ipc, { previewUrlFor });

    // Request channels only. A push channel is sent to and never handled, and
    // conflating the two made this assertion fail for a correct registry.
    //
    // Three channels are subtracted because they are HOST channels, and the
    // reason is the same for all three: the registry is the privileged
    // FILESYSTEM half and a package an embedding editor will import, so a
    // window it must hide and a desktop portal it must answer are both things
    // that host could never satisfy. Their handlers are registered directly in
    // `main/index.ts`.
    //
    // Every OTHER request channel must still be here, which is what keeps this
    // assertion worth having — it caught the picker channels being added to the
    // shared map before this list knew about them.
    const hostOwned: readonly string[] = [
      REQUEST_CHANNELS.hideWindow,
      REQUEST_CHANNELS.pickerConfirm,
      REQUEST_CHANNELS.pickerCancel,
    ];
    const registryOwned = Object.values(REQUEST_CHANNELS).filter(
      (channel) => !hostOwned.includes(channel),
    );
    expect(registered.sort()).toEqual(registryOwned.sort());
  });

  it("declares every channel under one prefix, so a stray one is obvious", () => {
    for (const channel of Object.values(CHANNELS)) {
      expect(channel.startsWith("symmetria-fm:")).toBe(true);
    }
  });

  it("refuses to register the same channel twice", () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    expect(() => createRegistry(ipc, { previewUrlFor })).toThrow();
  });
});

describe("a large listing arrives in batches", () => {
  let big: string;

  beforeAll(async () => {
    big = await mkdtemp(join(tmpdir(), "symfm-ipc-big-"));
    await Promise.all(
      Array.from({ length: 10_000 }, (_, i) => writeFile(join(big, `e-${i}.txt`), "x")),
    );
  }, 180_000);

  afterAll(async () => {
    await rm(big, { recursive: true, force: true });
  });

  it("streams ten thousand entries as several messages, not one", async () => {
    // Transfer lists are NOT zero-copy in Electron: transfer and clone cost the
    // same, about 400 MB/s, so the entire cost of a large reply is copying. One
    // giant message blocks; batches let the first rows paint.
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.list, { path: big, stream: true });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect((reply.value as ListReply).total).toBe(10_000);

    const batches = ipc.pushed.filter((m) => m.channel === CHANNELS.listBatch);
    expect(batches.length).toBeGreaterThan(1);

    const streamed = batches.flatMap((m) => (m.payload as ListBatch).entries);
    expect(streamed).toHaveLength(10_000);
  });
});

describe("cancellation reaches the work", () => {
  it("stops a scan that is still running", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const started = performance.now();
    const pending = ipc.invoke(CHANNELS.list, { path: "/usr/lib", stream: true });
    await ipc.invoke(CHANNELS.cancel, { streamId: "all" });

    const reply = await pending;
    const elapsed = performance.now() - started;

    // Either it finished before the cancel arrived, or it was cancelled. What
    // must not happen is a cancel that is accepted and ignored.
    if (!reply.ok) expect(reply.error.code).toBe("cancelled");
    expect(elapsed).toBeLessThan(2000);
  });
});

/**
 * A guard for the mismatch the end-to-end smoke test found.
 *
 * `ipcMain.handle` calls its handler with `(event, ...args)`. The registry's
 * transport takes one argument. Wired directly, every handler received the
 * event where it expected the request and rejected it as `invalid_request` —
 * while these unit tests passed, because the fake transport encoded the
 * assumption rather than the API.
 */
describe("the Electron adapter", () => {
  it("passes the payload as the request and the event's sender as the window", async () => {
    // Electron's own shape: the invoke event first, then the payload.
    type ElectronHandler = (event: InvokeEvent, payload: unknown) => Promise<IpcReply>;
    const handlers = new Map<string, ElectronHandler>();
    const fakeIpcMain = {
      handle(channel: string, handler: ElectronHandler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel: string) {
        handlers.delete(channel);
      },
    };

    // No cast anywhere in this test, and that is the point of both narrow
    // types. `electronIpcSurface` asks for the two members of `ipcMain` it
    // uses and the two members of a renderer it uses, so the doubles satisfy
    // them structurally. The previous version needed `{} as IpcMainInvokeEvent`
    // and would have needed an assertion CHAIN once the event grew a sender —
    // which the anti-slop gate rejects outright, and rightly: a chain throws
    // away the evidence the double already has.
    const transport = electronIpcSurface(fakeIpcMain);
    const pushed: string[] = [];
    createRegistry(transport.surface, {
      previewUrlFor,
      watchDirectory: (_path, onChange) => {
        onChange([]);
        return Promise.resolve(async () => undefined);
      },
    });

    // Called the way Electron calls it: event first, payload second.
    const list = handlers.get(CHANNELS.list);
    expect(list).toBeDefined();
    if (!list) return;

    const event: InvokeEvent = {
      sender: {
        isDestroyed: () => false,
        send: (channel: string) => {
          pushed.push(channel);
        },
      },
    };

    const reply = await list(event, { path: root });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(names(reply.value)).toContain("alpha.txt");

    // The other half of the adapter: a push raised by this event's request
    // finds its way back to this event's own sender.
    const watch = handlers.get(CHANNELS.watch);
    expect(watch).toBeDefined();
    if (!watch) return;
    await watch(event, { path: root, subscriptionId: "s1" });

    expect(pushed).toContain(CHANNELS.changed);
  });

  it("mints one handle per renderer and returns that same handle every time", () => {
    // The registry uses the handle as a MAP KEY, so a fresh object per request
    // would file every request from one window under a new window and never
    // find any of them again — the streams map would grow without bound and
    // `cancel` would never match anything.
    //
    // Nothing else pins this: a per-call handle still pushes to the right
    // renderer, because it closes over that renderer. Only the identity breaks,
    // and only the registry can see it.
    const transport = electronIpcSurface({
      handle: () => undefined,
      removeHandler: () => undefined,
    });

    const rendererA = { isDestroyed: () => false, send: () => undefined };
    const rendererB = { isDestroyed: () => false, send: () => undefined };

    expect(transport.handleFor(rendererA)).toBe(transport.handleFor(rendererA));
    expect(transport.handleFor(rendererA)).not.toBe(transport.handleFor(rendererB));
  });
});

/**
 * The watch channels, which had NO coverage at all — and which is where two of
 * the review's findings lived.
 */
describe("watching", () => {
  it("reports a watch failure as watch_failed, not as scan_failed", async () => {
    // `guard` used to catch everything and report `scan_failed`, so a read
    // error and a watch error arrived under a code that named neither. A
    // failure that is a value but lies about itself is no better than a throw.
    const ipc = fakeIpc();
    createRegistry(ipc, {
      previewUrlFor,
      watchDirectory: () => Promise.reject(new Error("no such directory")),
    });

    const reply = await ipc.invoke(CHANNELS.watch, { path: "/nope", subscriptionId: "s" });

    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("watch_failed");
  });

  it("reports a read failure as read_failed", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.readText, { path: "/does/not/exist" });

    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("read_failed");
  });

  it("stops the first watch when the same id is claimed twice at once", async () => {
    // The race: both calls read an empty map before either wrote, so both
    // opened a real watch and the later silently overwrote the earlier —
    // leaking a watcher nothing could stop, and delivering duplicate events
    // under one id.
    const stops: string[] = [];
    let opened = 0;
    const ipc = fakeIpc();
    createRegistry(ipc, {
      previewUrlFor,
      watchDirectory: async (path) => {
        const mine = `${path}#${opened++}`;
        await new Promise((r) => setTimeout(r, 10));
        return async () => {
          stops.push(mine);
        };
      },
    });

    await Promise.all([
      ipc.invoke(CHANNELS.watch, { path: "/tmp", subscriptionId: "same" }),
      ipc.invoke(CHANNELS.watch, { path: "/tmp", subscriptionId: "same" }),
    ]);

    // Two watches were opened, and the first was released rather than orphaned.
    expect(opened).toBe(2);
    expect(stops).toHaveLength(1);
  });

  it("releases the watch on unwatch, without needing a path", async () => {
    let stopped = false;
    const ipc = fakeIpc();
    createRegistry(ipc, {
      previewUrlFor,
      watchDirectory: async () => async () => {
        stopped = true;
      },
    });

    await ipc.invoke(CHANNELS.watch, { path: "/tmp", subscriptionId: "s1" });
    // No `path` — `unwatch` used to reuse the watch decoder and demand one.
    const reply = await ipc.invoke(CHANNELS.unwatch, { subscriptionId: "s1" });

    expect(reply.ok).toBe(true);
    expect(stopped).toBe(true);
  });
});

describe("dispose", () => {
  it("releases every watch, so a closed window leaks nothing", async () => {
    // `dispose` existed and was never called from the application. Every watch
    // a session opened lived until the process exited.
    let stopped = 0;
    const ipc = fakeIpc();
    const registry = createRegistry(ipc, {
      previewUrlFor,
      watchDirectory: async () => async () => {
        stopped++;
      },
    });

    await ipc.invoke(CHANNELS.watch, { path: "/tmp", subscriptionId: "a" });
    await ipc.invoke(CHANNELS.watch, { path: "/var", subscriptionId: "b" });
    registry.dispose();
    await new Promise((r) => setTimeout(r, 20));

    expect(stopped).toBe(2);
  });
});

describe("a caller-named stream can be cancelled while it runs", () => {
  it("cancels by the id the caller chose, not one it can never learn", async () => {
    // The id used to be minted in the main process and returned in the reply,
    // which arrives only once the scan has finished — so cancelling one
    // specific running scan was structurally impossible and `"all"` was the
    // only lever that ever worked.
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const pending = ipc.invoke(CHANNELS.list, {
      path: "/usr/lib",
      stream: true,
      streamId: "mine",
    });
    await ipc.invoke(CHANNELS.cancel, { streamId: "mine" });

    const reply = await pending;
    if (!reply.ok) expect(reply.error.code).toBe("cancelled");
  });
});

describe("describing a directory", () => {
  it("carries the entries, not only how many there are", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.describe, { path: root });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const value = reply.value as DescribeReply;
    expect(value.isDirectory).toBe(true);
    expect(value.entries.map((e) => e.name).sort()).toEqual(["alpha.txt", "beta.md"]);
  });

  it("reports each entry's kind, so the listing can draw the right icon", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.describe, { path: kinds });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const byName = new Map(
      (reply.value as DescribeReply).entries.map((e) => [e.name, e.kind] as const),
    );
    expect(byName.get("alpha.txt")).toBe("file");
    expect(byName.get("sub")).toBe("directory");
  });

  it("reports a symlink by what it points at, not by being a link", async () => {
    // `readdir` returns `DT_LNK` for a symlink, so `isDirectory()` and
    // `isFile()` are both false and classifying from the dirent alone makes
    // every link `other` — the wrong icon here, while the same link draws
    // correctly two columns to the left, which is where a listing that
    // disagrees with the scan becomes visible.
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.describe, { path: kinds });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const byName = new Map(
      (reply.value as DescribeReply).entries.map((e) => [e.name, e.kind] as const),
    );
    expect(byName.get("link-to-dir")).toBe("directory");
    expect(byName.get("link-to-file")).toBe("file");
    // A link that resolves to nothing stays listed as `other`, matching the
    // scan. Dropping it would make it invisible.
    expect(byName.get("link-broken")).toBe("other");
  });

  it("caps the listing but reports the true total", async () => {
    // A directory of ten thousand entries would otherwise serialise ten
    // thousand strings across the bridge every time the cursor settled on it,
    // 150 ms apart. The cap bounds the payload; the count stays honest.
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.describe, { path: capped });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const value = reply.value as DescribeReply;
    expect(value.entryCount).toBe(BIG_COUNT);
    expect(value.entries).toHaveLength(MAX_DIRECTORY_PREVIEW_ENTRIES);
  });

  it("sends an empty listing for a file", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.describe, { path: join(root, "alpha.txt") });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect((reply.value as DescribeReply).entries).toEqual([]);
  });
});

describe("the bookmark channels", () => {
  /**
   * Driven through `createRegistry`, not through the store functions directly.
   *
   * The gap this closes let an unvalidated write reach the disk: the wire
   * decoder proves the payload is a list of letter-and-bookmark pairs, and knew
   * nothing about reserved letters or absolute paths. Nothing called the
   * handler with a bad payload, so nothing noticed.
   *
   * Every case points `SYMMETRIA_FM_BOOKMARKS` at a scratch file. The
   * operator's real store is the one their Qt file manager reads, and a test
   * that wrote to it would break a working application.
   */
  let store: string;
  let previousEnv: string | undefined;

  beforeAll(() => {
    previousEnv = process.env["SYMMETRIA_FM_BOOKMARKS"];
  });

  afterAll(() => {
    if (previousEnv === undefined) delete process.env["SYMMETRIA_FM_BOOKMARKS"];
    else process.env["SYMMETRIA_FM_BOOKMARKS"] = previousEnv;
  });

  beforeEach(async () => {
    store = join(await mkdtemp(join(tmpdir(), "symfm-marks-ipc-")), "bookmarks.json");
    process.env["SYMMETRIA_FM_BOOKMARKS"] = store;
  });

  it("answers the read with a seeded store on a first run", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.bookmarksRead, {});

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const letters = (reply.value as BookmarksReply).bookmarks.map((b) => b.letter).sort();
    expect(letters).toEqual(["c", "d", "h", "m", "o", "p", "r", "v"]);
  });

  it("refuses a reserved letter rather than writing one that would be dropped", async () => {
    // `g` is jump-to-top, so a bookmark on it could never fire. Persisting it
    // would look like a save that worked and be gone after a restart.
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    await ipc.invoke(CHANNELS.bookmarksWrite, {
      bookmarks: [
        { letter: "g", bookmark: { path: "/tmp", label: "tmp" } },
        { letter: "w", bookmark: { path: "/tmp", label: "tmp" } },
      ],
    });

    const back = JSON.parse(await readFile(store, "utf8")) as Record<string, unknown>;
    expect(Object.keys(back)).toEqual(["w"]);
  });

  it("refuses a relative path", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    await ipc.invoke(CHANNELS.bookmarksWrite, {
      bookmarks: [{ letter: "w", bookmark: { path: "relative/here", label: "here" } }],
    });

    const back = JSON.parse(await readFile(store, "utf8")) as Record<string, unknown>;
    expect(Object.keys(back)).toEqual([]);
  });

  it("never enters the handler on a malformed payload", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.bookmarksWrite, { bookmarks: "not a list" });

    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("invalid_request");
  });

  it("reads back what it wrote", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    await ipc.invoke(CHANNELS.bookmarksWrite, {
      bookmarks: [{ letter: "w", bookmark: { path: "/tmp/work", label: "work" } }],
    });
    const reply = await ipc.invoke(CHANNELS.bookmarksRead, {});

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    // The file is now the whole answer, so the seed is NOT merged back in.
    const pairs = (reply.value as BookmarksReply).bookmarks;
    expect(pairs.map((b) => b.letter)).toEqual(["w"]);
    expect(pairs[0]?.bookmark.path).toBe("/tmp/work");
  });
});

/**
 * The one dependency this package cannot supply for itself.
 *
 * The split that produced this package found `createRegistry` IMPORTING the
 * host's URL builder, which meant the privileged half could only ever have run
 * inside one application. It is injected now, and required rather than
 * defaulted — a default would have to name some host's scheme, and a registry
 * that quietly serves the wrong origin is worse than one that will not compile
 * without being told.
 *
 * Review pointed out that every call site passed the dependency and no test
 * ever read the value back, so nothing proved the reply was built from it. A
 * registry that ignored the injection and hardcoded a URL would have passed
 * every assertion in this file.
 */
/**
 * The directory grant is over the file's PARENT, and the handler decides that.
 *
 * The one safety property this channel exists to guarantee. The renderer sends
 * a FILE path and the main process takes its parent; a handler that passed
 * `request.path` straight through would grant a directory named after a file,
 * which resolves to nothing — or, for a path the renderer chose freely, exactly
 * as much as the renderer asked for. That is the shape the handler's own
 * comment calls load-bearing, and until this block existed it was checked only
 * by the token unit tests, which never call through the registry.
 */
describe("the directory preview URL comes from the host", () => {
  it("builds the reply with the injected function, not with one of its own", async () => {
    const file = join(root, "doc.md");
    await writeFile(file, "# hello");
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = (await ipc.invoke(CHANNELS.previewDirectoryUrl, { path: file })) as {
      ok: boolean;
      value: { url: string };
    };

    expect(reply.ok).toBe(true);
    expect(reply.value.url.startsWith("test-host://preview/")).toBe(true);
  });

  it("grants the directory, so two files beside each other share one token", async () => {
    // THE assertion of this block. Two different files, one parent — one token.
    // A handler that granted `request.path` would hand back two, because the
    // two paths differ.
    const first = join(root, "one.md");
    const second = join(root, "two.md");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const a = (await ipc.invoke(CHANNELS.previewDirectoryUrl, { path: first })) as {
      value: { url: string };
    };
    const b = (await ipc.invoke(CHANNELS.previewDirectoryUrl, { path: second })) as {
      value: { url: string };
    };

    expect(a.value.url).toBe(b.value.url);
  });

  it("puts neither the file name nor the directory in the URL", async () => {
    const file = join(root, "secret-document.md");
    await writeFile(file, "content");
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = (await ipc.invoke(CHANNELS.previewDirectoryUrl, { path: file })) as {
      value: { url: string };
    };

    expect(reply.value.url).not.toContain("secret-document");
    expect(reply.value.url).not.toContain(root);
  });

  it("refuses a path that is not there", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = (await ipc.invoke(CHANNELS.previewDirectoryUrl, {
      path: join(root, "no-such-document.md"),
    })) as { ok: boolean; error: { code: string } };

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("read_failed");
  });
});

describe("the preview URL comes from the host", () => {
  it("builds the reply with the injected function, not with one of its own", async () => {
    const file = join(root, "previewable.txt");
    await writeFile(file, "content");
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = (await ipc.invoke(CHANNELS.previewUrl, { path: file })) as {
      ok: boolean;
      value: { url: string };
    };

    expect(reply.ok).toBe(true);
    // The scheme is deliberately unreal, so this can only pass through the
    // injected path. A registry naming its own scheme would fail here.
    expect(reply.value.url.startsWith("test-host://preview/")).toBe(true);
  });

  it("issues a token rather than putting the path in the URL", async () => {
    // The URL reaches page code. A path in it would hand the renderer the one
    // thing the whole architecture exists to keep away from it.
    const file = join(root, "secret-name.txt");
    await writeFile(file, "content");
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = (await ipc.invoke(CHANNELS.previewUrl, { path: file })) as {
      ok: boolean;
      value: { url: string };
    };

    expect(reply.value.url).not.toContain("secret-name");
    expect(reply.value.url).not.toContain(root);
  });
});

/**
 * The listing order, across the boundary.
 *
 * The store itself is covered in `listingOptions.test.ts`; what is left here is
 * the pair of channels, and the one thing only this level can show — that a
 * malformed payload is refused before anything reaches the disk.
 */
describe("the listing order crosses the boundary", () => {
  let optionsDir: string;

  beforeEach(async () => {
    optionsDir = await mkdtemp(join(tmpdir(), "symfm-ipc-listing-"));
    // Never the operator's real configuration. The store honours this for
    // exactly that reason.
    process.env["SYMMETRIA_FM_LISTING"] = join(optionsDir, "listing.json");
  });

  afterEach(async () => {
    delete process.env["SYMMETRIA_FM_LISTING"];
    await rm(optionsDir, { recursive: true, force: true });
  });

  it("answers the default before anything has been written", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.listingRead, {});

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value).toEqual({ options: DEFAULT_LISTING_OPTIONS });
  });

  it("round-trips a whole options object", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });
    // WHOLE, as the name says: the decoder fills any field the payload omits,
    // so a partial object cannot round-trip to itself and never could.
    const options = {
      sort: "extension",
      reverse: false,
      showHidden: true,
      renderDocuments: false,
    };

    const written = await ipc.invoke(CHANNELS.listingWrite, { options });
    expect(written.ok).toBe(true);

    const read = await ipc.invoke(CHANNELS.listingRead, {});
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual({ options });
  });

  it("refuses a malformed payload before it reaches the disk", async () => {
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const reply = await ipc.invoke(CHANNELS.listingWrite, { options: "size" });

    expect(reply.ok).toBe(false);
    // And nothing was written: a rejected request must not leave a file
    // behind that the next start would read back.
    const read = await ipc.invoke(CHANNELS.listingRead, {});
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual({ options: DEFAULT_LISTING_OPTIONS });
  });

  it("refuses to write over a file it could not read", async () => {
    // Acceptance criterion 4, which had no automated coverage until review
    // said so. A file that exists and did not parse is the user's own data
    // mid-edit; saving over it destroys something they are in the middle of
    // fixing. Verification confirmed this by hand — that does not survive the
    // next refactor and this does.
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });
    const path = process.env["SYMMETRIA_FM_LISTING"] as string;
    await writeFile(path, "{ half a file", "utf8");

    const reply = await ipc.invoke(CHANNELS.listingWrite, {
      options: { sort: "size", reverse: false, showHidden: false },
    });

    expect(reply.ok).toBe(false);
    await expect(readFile(path, "utf8")).resolves.toBe("{ half a file");
  });

  it("stores the MEANING of a payload, not the payload", async () => {
    // Shape, then meaning — the same two-step the bookmark write does. A
    // caller must not be able to persist a value the next load would silently
    // discard, which is a setting that appears to save and is gone next time.
    const ipc = fakeIpc();
    createRegistry(ipc, { previewUrlFor });

    const written = await ipc.invoke(CHANNELS.listingWrite, {
      options: { sort: "cromulent", reverse: true, showHidden: false },
    });
    expect(written.ok).toBe(true);

    const read = await ipc.invoke(CHANNELS.listingRead, {});
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.value as { options: { sort: string } }).options.sort).toBe(
      DEFAULT_LISTING_OPTIONS.sort,
    );
  });
});
