// @effect-diagnostics nodeBuiltinImport:off - the confined store directory exists before any Effect runs
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";
import {
  decodeListReply,
  decodePreviewUrlReply,
  decodeRenameReply,
  decodeTransferReply,
} from "@symmetria/fm-core/contract";
import type { FileManagerEvent, FileManagerReply } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as FileManagerHost from "./FileManagerHost.ts";
import { createHostOperations, type SpawnHostProcess } from "./hostOperations.ts";

/**
 * The host commands the operations would run, recorded instead of spawned:
 * `trash` and `open` must never reach this machine's desktop from a test.
 */
const hostCommands: Array<{ command: string; args: readonly string[] }> = [];
const recordingSpawn: SpawnHostProcess = (command, args) => {
  hostCommands.push({ command, args });
  const process = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
    stderr: null;
    kill(): boolean;
    unref(): void;
  };
  process.stderr = null;
  process.kill = () => true;
  process.unref = () => undefined;
  queueMicrotask(() => {
    if (command === "gio") process.emit("close", 0, null);
    else process.emit("spawn");
  });
  return process;
};

/**
 * The bookmark and listing stores are confined here: the registry's defaults
 * are the operator's real file manager configuration, which a test must never
 * read or seed.
 */
const storeDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-fm-store-"));

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    FileManagerHost.layerWith({
      bookmarksPath: NodePath.join(storeDirectory, "bookmarks.json"),
      listingOptionsPath: NodePath.join(storeDirectory, "listing.json"),
      operations: createHostOperations({ spawn: recordingSpawn }),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const CLIENT = "client-a";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "mesura-file-manager-host-" });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (directory: string, name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(directory, name), name).pipe(Effect.orDie);
});

/** Opens a session for the scope and drains its pushes (after the ready marker) into a queue. */
const openSession = Effect.fn("openSession")(function* (sessionId: string, clientId = CLIENT) {
  const host = yield* FileManagerHost.FileManagerHost;
  const items = yield* host.openSession(clientId, { sessionId });
  const queue = yield* Queue.unbounded<FileManagerEvent>();
  const ready = yield* Deferred.make<void>();
  yield* Stream.runForEach(items, (item) =>
    "ready" in item ? Deferred.succeed(ready, undefined) : Queue.offer(queue, item),
  ).pipe(Effect.orDie, Effect.forkScoped);
  yield* Deferred.await(ready);
  return queue;
});

const listing = (path: string) => ({
  path,
  showHidden: false,
  sort: "alphabetical",
  reverse: false,
  stream: false,
  streamId: null,
});

function expectFailure(reply: FileManagerReply, code: string): string {
  expect(reply.ok).toBe(false);
  if (reply.ok) throw new Error("expected a failure");
  expect(reply.error.code).toBe(code);
  return reply.error.message;
}

it.layer(TestLayer, { excludeTestServices: true })("FileManagerHost", (it) => {
  describe("read channels", () => {
    it.effect("lists a directory in the shape fm-core decodes", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const root = yield* makeTempDir;
        yield* writeTextFile(root, "b.txt");
        yield* writeTextFile(root, "a.txt");
        yield* openSession("list");

        const reply = yield* host.query(CLIENT, {
          sessionId: "list",
          channel: "symmetria-fm:list",
          payload: listing(root),
        });

        expect(reply).toMatchObject({ ok: true });
        if (!reply.ok) return;
        const decoded = decodeListReply(reply.value);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.value.entries.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
      }),
    );

    it.effect("delivers a changed event for a watched directory on the session's stream", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const root = yield* makeTempDir;
        const events = yield* openSession("watch");

        const started = yield* host.query(CLIENT, {
          sessionId: "watch",
          channel: "symmetria-fm:watch",
          payload: { path: root, subscriptionId: "w1" },
        });
        expect(started.ok).toBe(true);
        yield* writeTextFile(root, "new.txt");

        const event = yield* Queue.take(events);
        expect(event.channel).toBe("symmetria-fm:changed");
        expect(event.payload).toMatchObject({ subscriptionId: "w1" });
      }),
    );

    it.effect("releases a session's watches when its event stream ends", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const scope = yield* Scope.make();
        const root = yield* makeTempDir.pipe(Scope.provide(scope));
        yield* openSession("ending").pipe(Scope.provide(scope));
        const started = yield* host.query(CLIENT, {
          sessionId: "ending",
          channel: "symmetria-fm:watch",
          payload: { path: root, subscriptionId: "w1" },
        });
        expect(started.ok).toBe(true);
        expect(yield* host.trackedSessions).toBe(1);

        yield* Scope.close(scope, Exit.void);

        expect(yield* host.trackedSessions).toBe(0);
        const after = yield* host.query(CLIENT, {
          sessionId: "ending",
          channel: "symmetria-fm:list",
          payload: listing(root),
        });
        expect(expectFailure(after, "invalid_request")).toBe("session not open");
      }),
    );

    it.effect("announces readiness first, and only once the session can answer", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const items = yield* host.openSession(CLIENT, { sessionId: "ready" });
        const first = yield* Stream.runHead(items.pipe(Stream.take(1)));

        expect(first).toEqual(Option.some({ ready: true }));
        const reply = yield* host.query(CLIENT, {
          sessionId: "ready",
          channel: "symmetria-fm:listing-read",
          payload: {},
        });
        expect(reply.ok).toBe(true);
      }),
    );

    it.effect("refuses a query for a session with no open event stream", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;

        const reply = yield* host.query(CLIENT, {
          sessionId: "never-opened",
          channel: "symmetria-fm:list",
          payload: listing("/"),
        });

        expect(expectFailure(reply, "invalid_request")).toBe("session not open");
        expect(yield* host.trackedSessions).toBe(0);
      }),
    );

    it.effect("refuses a query from a connection that did not open the session", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        yield* openSession("shared-name");

        const reply = yield* host.query("client-b", {
          sessionId: "shared-name",
          channel: "symmetria-fm:listing-read",
          payload: {},
        });

        expect(expectFailure(reply, "invalid_request")).toBe("session not open");
      }),
    );

    it.effect("fails a second stream for a session id this connection already holds", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        yield* openSession("twice");

        const exit = yield* Effect.exit(host.openSession(CLIENT, { sessionId: "twice" }));

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* host.trackedSessions).toBe(0);
        // The refusal left the first session in place.
        const stillOpen = yield* host.query(CLIENT, {
          sessionId: "twice",
          channel: "symmetria-fm:listing-read",
          payload: {},
        });
        expect(stillOpen.ok).toBe(true);
      }),
    );

    it.effect("says the finder is not available when no search pool is injected", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const root = yield* makeTempDir;
        yield* openSession("finder");

        const reply = yield* host.query(CLIENT, {
          sessionId: "finder",
          channel: "symmetria-fm:search-start",
          payload: { directory: root },
        });

        expect(expectFailure(reply, "read_failed")).toBe("the finder is not available here yet");
      }),
    );

    it.effect("reads and writes the bookmark store it was given, not the operator's", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        yield* openSession("bookmarks");

        const reply = yield* host.query(CLIENT, {
          sessionId: "bookmarks",
          channel: "symmetria-fm:bookmarks-read",
          payload: {},
        });

        expect(reply.ok).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(storeDirectory, "bookmarks.json"))).toBe(true);
      }),
    );

    it.effect(
      "grants preview URLs under the preview route's prefix, for a file and for its directory",
      () =>
        Effect.gen(function* () {
          const host = yield* FileManagerHost.FileManagerHost;
          const root = yield* makeTempDir;
          yield* writeTextFile(root, "doc.md");
          yield* openSession("previews");
          const query = (
            channel: "symmetria-fm:preview-url" | "symmetria-fm:preview-directory-url",
          ) =>
            host.query(CLIENT, {
              sessionId: "previews",
              channel,
              payload: { path: NodePath.join(root, "doc.md") },
            });

          const file = yield* query("symmetria-fm:preview-url");
          const directory = yield* query("symmetria-fm:preview-directory-url");

          for (const reply of [file, directory]) {
            expect(reply).toMatchObject({ ok: true });
            const decoded = decodePreviewUrlReply(reply.ok ? reply.value : null);
            if (!decoded.ok) throw new Error("undecodable preview url reply");
            const { url } = decoded.value;
            expect(url.startsWith(FileManagerHost.FILE_MANAGER_PREVIEW_ROUTE_PREFIX)).toBe(true);
            expect(
              url.slice(FileManagerHost.FILE_MANAGER_PREVIEW_ROUTE_PREFIX.length),
            ).not.toContain("/");
          }
        }),
    );

    it.effect("reports the server process's home directory", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        expect(yield* host.host).toEqual({ homePath: NodeOS.homedir() });
      }),
    );
  });

  describe("write channels", () => {
    it.effect("creates a file and a directory with parents, and renames in place", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir;
        yield* openSession("writes");
        const mutate = (channel: "symmetria-fm:create" | "symmetria-fm:rename", payload: unknown) =>
          host.mutate(CLIENT, { sessionId: "writes", channel, payload });

        const created = yield* mutate("symmetria-fm:create", {
          path: NodePath.join(root, "a/b/file.txt"),
          kind: "file",
        });
        const madeDirectory = yield* mutate("symmetria-fm:create", {
          path: NodePath.join(root, "dir"),
          kind: "directory",
        });
        const renamed = yield* mutate("symmetria-fm:rename", {
          path: NodePath.join(root, "a/b/file.txt"),
          name: "renamed.txt",
        });

        expect(created).toMatchObject({ ok: true });
        expect(madeDirectory).toMatchObject({ ok: true });
        expect(yield* fileSystem.exists(NodePath.join(root, "a/b/renamed.txt"))).toBe(true);
        if (!renamed.ok) throw new Error("rename failed");
        const decoded = decodeRenameReply(renamed.value);
        expect(decoded.ok && decoded.value.path).toBe(NodePath.join(root, "a/b/renamed.txt"));
      }),
    );

    it.effect("copies and moves with progress events on the session's stream", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir;
        yield* writeTextFile(root, "one.txt");
        yield* writeTextFile(root, "two.txt");
        yield* fileSystem.makeDirectory(NodePath.join(root, "copies"));
        yield* fileSystem.makeDirectory(NodePath.join(root, "moves"));
        const events = yield* openSession("transfer");
        const sources = [NodePath.join(root, "one.txt"), NodePath.join(root, "two.txt")];

        const copied = yield* host.mutate(CLIENT, {
          sessionId: "transfer",
          channel: "symmetria-fm:transfer",
          payload: {
            sources,
            destination: NodePath.join(root, "copies"),
            mode: "copy",
            overwrite: false,
            transferId: "t-copy",
          },
        });
        if (!copied.ok) throw new Error(copied.error.message);
        const copiedReply = decodeTransferReply(copied.value);
        expect(copiedReply.ok && copiedReply.value.moved).toBe(2);
        const first = yield* Queue.take(events);
        expect(first.channel).toBe("symmetria-fm:transfer-progress");
        expect(first.payload).toMatchObject({ transferId: "t-copy", done: 0, total: 2 });
        expect(yield* fileSystem.exists(NodePath.join(root, "copies/two.txt"))).toBe(true);

        const moved = yield* host.mutate(CLIENT, {
          sessionId: "transfer",
          channel: "symmetria-fm:transfer",
          payload: {
            sources,
            destination: NodePath.join(root, "moves"),
            mode: "move",
            overwrite: false,
            transferId: "t-move",
          },
        });
        expect(moved).toMatchObject({ ok: true, value: { moved: 2, conflicts: [] } });
        expect(yield* fileSystem.exists(NodePath.join(root, "one.txt"))).toBe(false);
        expect(yield* fileSystem.exists(NodePath.join(root, "moves/one.txt"))).toBe(true);
        // The copy's later ticks are still queued; the move's follow them.
        let tick = yield* Queue.take(events);
        while ((tick.payload as { transferId?: string }).transferId !== "t-move") {
          tick = yield* Queue.take(events);
        }
        expect(tick.channel).toBe("symmetria-fm:transfer-progress");
        expect(tick.payload).toMatchObject({ transferId: "t-move", total: 2 });
      }),
    );

    it.effect("cancels a running transfer between entries", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir;
        // Many sources, so the cancel lands while the loop still runs; the
        // strict proof of the abort is the operations' own test, which
        // cancels from inside the progress callback.
        const names = Array.from({ length: 64 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
        for (const name of names) yield* writeTextFile(root, name);
        yield* fileSystem.makeDirectory(NodePath.join(root, "into"));
        const events = yield* openSession("cancel");

        // Cancel as soon as the first progress tick arrives, from a fiber that
        // follows the stream while the transfer runs.
        const canceller = yield* Effect.forkScoped(
          Effect.gen(function* () {
            // A transfer that fails before its first tick must fail the test,
            // not hang it.
            yield* Queue.take(events).pipe(Effect.timeout("5 seconds"));
            yield* host.mutate(CLIENT, {
              sessionId: "cancel",
              channel: "symmetria-fm:cancel-transfer",
              payload: { transferId: "t-cancel" },
            });
          }),
        );
        const reply = yield* host.mutate(CLIENT, {
          sessionId: "cancel",
          channel: "symmetria-fm:transfer",
          payload: {
            sources: names.map((name) => NodePath.join(root, name)),
            destination: NodePath.join(root, "into"),
            mode: "copy",
            overwrite: false,
            transferId: "t-cancel",
          },
        });
        yield* Fiber.join(canceller);

        if (!reply.ok) throw new Error(reply.error.message);
        const outcome = decodeTransferReply(reply.value);
        if (!outcome.ok) throw new Error("undecodable transfer reply");
        expect(outcome.value.moved).toBeLessThanOrEqual(names.length);
        expect(outcome.value.conflicts).toEqual([]);
        const landed = yield* fileSystem.readDirectory(NodePath.join(root, "into"));
        expect(landed.length).toBe(outcome.value.moved);
      }),
    );

    it.effect("trashes through gio and opens through xdg-open on the host", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const root = yield* makeTempDir;
        yield* writeTextFile(root, "doomed.txt");
        yield* openSession("desktop");
        hostCommands.length = 0;

        const trashed = yield* host.mutate(CLIENT, {
          sessionId: "desktop",
          channel: "symmetria-fm:trash",
          payload: { paths: [NodePath.join(root, "doomed.txt")] },
        });
        const opened = yield* host.mutate(CLIENT, {
          sessionId: "desktop",
          channel: "symmetria-fm:open",
          payload: { path: NodePath.join(root, "doomed.txt") },
        });

        expect(trashed).toEqual({ ok: true, value: null });
        expect(opened).toEqual({ ok: true, value: null });
        expect(hostCommands).toEqual([
          { command: "gio", args: ["trash", NodePath.join(root, "doomed.txt")] },
          { command: "xdg-open", args: [NodePath.join(root, "doomed.txt")] },
        ]);
      }),
    );

    it.effect("answers the clipboard channel as unavailable: the browser owns it", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        yield* openSession("clipboard");

        const reply = yield* host.mutate(CLIENT, {
          sessionId: "clipboard",
          channel: "symmetria-fm:clipboard",
          payload: { kind: "text", text: "hello" },
        });

        expect(expectFailure(reply, "write_failed")).toBe(
          "the clipboard is not available in this host",
        );
      }),
    );
  });
});
