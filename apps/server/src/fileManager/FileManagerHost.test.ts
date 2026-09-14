// @effect-diagnostics nodeBuiltinImport:off - the confined store directory exists before any Effect runs
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { decodeListReply } from "@symmetria/fm-core/contract";
import type { FileManagerEvent, FileManagerReply } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as FileManagerHost from "./FileManagerHost.ts";

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

/** Opens a session for the scope and drains its pushes into a queue. */
const openSession = Effect.fn("openSession")(function* (sessionId: string, clientId = CLIENT) {
  const host = yield* FileManagerHost.FileManagerHost;
  const events = yield* host.openSession(clientId, { sessionId });
  const queue = yield* Queue.unbounded<FileManagerEvent>();
  yield* Stream.runForEach(events, (event) => Queue.offer(queue, event)).pipe(
    Effect.orDie,
    Effect.forkScoped,
  );
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

    it.effect("reports the server process's home directory", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        expect(yield* host.host).toEqual({ homePath: NodeOS.homedir() });
      }),
    );
  });

  describe("write channels", () => {
    it.effect("refuses a write while no operations are injected, and creates nothing", () =>
      Effect.gen(function* () {
        const host = yield* FileManagerHost.FileManagerHost;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempDir;
        yield* openSession("writes");
        const target = NodePath.join(root, "made.txt");

        const reply = yield* host.mutate(CLIENT, {
          sessionId: "writes",
          channel: "symmetria-fm:create",
          payload: { path: target, kind: "file" },
        });

        expect(expectFailure(reply, "write_failed")).toBe(
          "file operations are not available in this host",
        );
        expect(yield* fileSystem.exists(target)).toBe(false);
      }),
    );
  });
});
