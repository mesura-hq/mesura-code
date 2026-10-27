import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EditorSessionManager from "./Manager.ts";
import {
  FakeNvim,
  attachUntilEnd,
  collect,
  createManager,
  fakeAdapterLayer,
  scratchConfig,
} from "./Manager.testkit.ts";

/**
 * The manager, driven against the msgpack-RPC fake Neovim in `Manager.testkit.ts`.
 * Neovim's own behaviour belongs to the conformance harness, not to this fake.
 */

const layer = NodeServices.layer;

it.layer(layer, { excludeTestServices: true })("EditorSessionManager", (it) => {
  it.effect("starts Neovim in the thread's project, not the server's directory", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({ threadId: "thread-cwd", cwd: root, relativePath: "a.ts", lines: [""] });
      // Plugins root themselves at Neovim's working directory. Left at the
      // server's own, neo-tree watched the whole home directory.
      assert.strictEqual(fake.spawns[0]?.cwd, root);
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a Neovim that exited, and the attachment keeps working", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      fake.lines = ["const a = 1;"];
      yield* manager.open({
        threadId: "thread-exit",
        cwd: root,
        relativePath: "a.ts",
        lines: ["const a = 1;"],
      });
      const restarted = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.attachStream({ threadId: "thread-exit" }, (event) =>
        event.type === "message" && event.text.includes("restarted")
          ? Deferred.succeed(restarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      // `:q` typed into the editor, or the process killed: either way the
      // output ends. Before, every later call on the thread waited forever.
      fake.crash();
      yield* Deferred.await(restarted);

      assert.strictEqual(fake.spawns.length, 2, "a second Neovim was started");
      assert.strictEqual(fake.spawns[1]?.cwd, root, "in the same project");
      const reopen = fake.calls.findLast(
        (call) => call.method === "nvim_exec_lua" && String(call.params[0]).includes("mesura.open"),
      );
      assert.isDefined(reopen, "the file was reopened");
      assert.deepStrictEqual(
        (reopen.params[1] as ReadonlyArray<unknown>)[1],
        ["const a = 1;"],
        "with the text the mirror held",
      );
      // And the thread answers again.
      yield* manager.input({ threadId: "thread-exit", keys: "j" });
    }).pipe(Effect.scoped),
  );

  it.effect("gives up after three restarts, and tells the attachment why", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-loop",
        cwd: root,
        relativePath: "a.ts",
        lines: [""],
      });
      const messages = yield* Queue.make<string>();
      const ends = yield* Queue.make<string | undefined>();
      const unsubscribe = yield* manager.attachStream({ threadId: "thread-loop" }, (event) => {
        if (event.type === "message") return Queue.offer(messages, event.text).pipe(Effect.asVoid);
        if (event.type === "exited") return Queue.offer(ends, event.reason).pipe(Effect.asVoid);
        return Effect.void;
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      for (let restart = 1; restart <= 3; restart += 1) {
        fake.crash();
        assert.include(yield* Queue.take(messages), "restarted");
      }
      // A configuration that kills Neovim at start would otherwise loop.
      fake.crash();
      assert.include(yield* Queue.take(messages), "exited 4 times");
      // Said as the reason the stream ends, so the client stops reopening a
      // Neovim that only exits again.
      assert.strictEqual(yield* Queue.take(ends), "gave-up");
      // Behind the thread's lock, so it runs once the drop has finished.
      const after = yield* Effect.result(manager.input({ threadId: "thread-loop", keys: "j" }));
      assert.isTrue(Result.isFailure(after), "the session is gone");
    }).pipe(Effect.scoped),
  );

  it.effect("fails an attachment to a thread with no session, rather than leaving it waiting", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      // What a client finds after a server restart: its thread's session went
      // with the old process. The failure used to happen inside the stream's
      // callback fiber, which nothing watched, so the stream stayed open and
      // silent and the client never learned it had to open the file again.
      const outcome = yield* Effect.result(
        Stream.runDrain(EditorSessionManager.attachEventStream(manager, { threadId: "nobody" })),
      );
      assert.isTrue(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "EditorSessionLookupError");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("ends an attachment with `exited` when its session is closed", () =>
    Effect.gen(function* () {
      const { manager, root } = yield* createManager();
      yield* manager.open({ threadId: "thread-end", cwd: root, relativePath: "a.ts", lines: [""] });
      const events = yield* attachUntilEnd(manager, "thread-end");

      yield* manager.closeThread({ threadId: "thread-end" });

      // The stream ends on its own; joining would wait forever otherwise.
      assert.deepStrictEqual((yield* Fiber.join(events)).at(-1), {
        type: "exited",
        code: null,
        reason: "closed",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("tells an attachment its session was replaced when the project moves", () =>
    Effect.gen(function* () {
      const { manager, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-swap",
        cwd: root,
        relativePath: "a.ts",
        lines: [""],
      });
      const events = yield* attachUntilEnd(manager, "thread-swap");

      yield* manager.open({
        threadId: "thread-swap",
        cwd: `${root}/worktree`,
        relativePath: "a.ts",
        lines: [""],
      });

      // `replaced`, not `closed`: the client attaches again and opens nothing.
      assert.deepStrictEqual((yield* Fiber.join(events)).at(-1), {
        type: "exited",
        code: null,
        reason: "replaced",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("tells attachments the server is stopping, and opens nothing after", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make();
      const { manager, root } = yield* createManager().pipe(Scope.provide(managerScope));
      yield* manager.open({
        threadId: "thread-stop",
        cwd: root,
        relativePath: "a.ts",
        lines: [""],
      });
      const events = yield* attachUntilEnd(manager, "thread-stop");

      yield* Scope.close(managerScope, Exit.void);

      // `stopping` makes the client wait for the reconnect rather than reopen
      // against a server on its way out.
      assert.deepStrictEqual((yield* Fiber.join(events)).at(-1), {
        type: "exited",
        code: null,
        reason: "stopping",
      });
      const late = yield* Effect.result(
        manager.open({ threadId: "thread-late", cwd: root, relativePath: "a.ts", lines: [""] }),
      );
      assert.isTrue(Result.isFailure(late), "an open after shutdown starts no Neovim");
    }).pipe(Effect.scoped),
  );

  it.effect("starts a new Neovim when the thread's project moves", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-move",
        cwd: root,
        relativePath: "a.ts",
        lines: [""],
      });
      const worktree = `${root}/worktree`;
      yield* manager.open({
        threadId: "thread-move",
        cwd: worktree,
        relativePath: "a.ts",
        lines: [""],
      });
      assert.deepStrictEqual(
        fake.spawns.map((spawn) => spawn.cwd),
        [root, worktree],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("points the mirror at the buffer it opened, before it answers", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();

      // Only this call moves the mirror onto the opened file. Without it `open` snapshots the
      // previous buffer's text under the new name, and the client writes that to disk.
      // The conformance helper repeats the call itself, so only this test catches its loss.
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["const a = 1;"],
      });

      const openAt = fake.calls.findIndex(
        (call) => call.method === "nvim_exec_lua" && String(call.params[0]).includes("mesura.open"),
      );
      assert.notStrictEqual(openAt, -1, "the file was never opened through the host plugin");

      // Counted from the open, because the session also attaches once at
      // startup — to whatever buffer Neovim happens to be on, which under a
      // real configuration is a dashboard.
      const attachOffset = fake.calls
        .slice(openAt)
        .findIndex((call) => call.method === "nvim_buf_attach");
      assert.notStrictEqual(attachOffset, -1, "the mirror was never pointed at the opened buffer");
      const attachAt = openAt + attachOffset;
      const settleAt = fake.calls.findIndex(
        (call, index) =>
          index > openAt &&
          call.method === "nvim_exec_lua" &&
          String(call.params[0]).includes("mesura_settled"),
      );
      assert.isBelow(
        attachAt,
        settleAt,
        "the mirror is pointed at the buffer after the settle, so the snapshot can be built from the previous buffer",
      );

      // The buffer the plugin answered with, not whatever was current. The
      // fake hands back a new number for every `mesura.open`.
      const attached = fake.calls[attachAt]?.params[0];
      assert.strictEqual(
        attached,
        2,
        "the mirror followed a buffer other than the one just opened",
      );
    }),
  );

  it.effect("spawns one Neovim for a thread and reuses it for a second file", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();

      const first = yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["const a = 1;"],
      });
      assert.strictEqual(first.relativePath, "a.ts");
      assert.lengthOf(fake.spawns, 1, "one Neovim");

      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "b.ts",
        lines: ["const b = 2;"],
      });
      assert.lengthOf(fake.spawns, 1, "and still one Neovim, not a second");

      // The second open has to put the window on another buffer, or the
      // developer would type into the file they just left.
      const opens = fake.calls.filter(
        (call) => call.method === "nvim_exec_lua" && String(call.params[0]).includes("mesura.open"),
      );
      assert.lengthOf(opens, 2, "each file was opened in the session");
    }).pipe(Effect.scoped),
  );

  it.effect("gives every attachment its own snapshot, then the same later events", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["one", "two"],
      });

      const first = yield* collect(manager, "thread-1");
      const second = yield* collect(manager, "thread-1");

      for (const events of [first, second]) {
        const seen = yield* Ref.get(events);
        assert.strictEqual(seen[0]?.type, "snapshot", "a snapshot arrives first");
      }

      fake.notify("mesura:write", [`${root}/a.ts`]);
      yield* manager.settleForTest({ threadId: "thread-1" });

      for (const events of [first, second]) {
        const seen = yield* Ref.get(events);
        assert.isTrue(
          seen.some((event) => event.type === "writeRequested"),
          "and both attachments see what happens next",
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("tells every attachment which file the session moved to", () =>
    Effect.gen(function* () {
      const { manager, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["one", "two"],
      });

      const events = yield* collect(manager, "thread-1");

      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "b.ts",
        lines: ["three"],
      });
      yield* manager.settleForTest({ threadId: "thread-1" });

      const seen = yield* Ref.get(events);
      const snapshots = seen.filter((event) => event.type === "snapshot");
      const last = snapshots[snapshots.length - 1];
      assert.strictEqual(
        last?.type === "snapshot" ? last.snapshot.relativePath : null,
        "b.ts",
        // Without this the client keeps applying line events to the file it
        // still believes is open, which is a different file's text.
        "and it names the file the session moved to",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a buffer's contents when the file's lines have moved on", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["one"],
      });

      const events = yield* collect(manager, "thread-1");
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["one", "two"],
      });

      // The lines go to Neovim as part of opening, in one change rather than a
      // sequence of edits: an agent's rewrite is one thing that happened.
      const opens = fake.calls.filter(
        (call) => call.method === "nvim_exec_lua" && String(call.params[0]).includes("mesura.open"),
      );
      const lastOpen = opens.at(-1);
      assert.deepStrictEqual(
        (lastOpen?.params[1] as ReadonlyArray<unknown>)?.[1],
        ["one", "two"],
        "the new lines were handed over",
      );
      assert.isAbove((yield* Ref.get(events)).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a write request once, for the path that asked", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "src/a.ts",
        lines: ["one"],
      });
      const events = yield* collect(manager, "thread-1");

      fake.notify("mesura:write", [`${root}/src/a.ts`]);
      yield* manager.settleForTest({ threadId: "thread-1" });

      const writes = (yield* Ref.get(events)).filter((event) => event.type === "writeRequested");
      assert.lengthOf(writes, 1, "exactly one");
      assert.deepStrictEqual(writes[0], {
        type: "writeRequested",
        relativePath: "src/a.ts",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("evicts the least recently used session, and never an attached one", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager({ maxSessions: 2 });

      const open = (threadId: string) =>
        manager.open({ threadId, cwd: root, relativePath: "a.ts", lines: ["one"] });

      yield* open("thread-1");
      // Attached, so it must survive being the oldest.
      yield* collect(manager, "thread-1");
      yield* open("thread-2");
      yield* open("thread-3");

      assert.lengthOf(fake.spawns, 3, "three sessions were started");
      assert.lengthOf(fake.killed, 1, "and one was evicted");
      assert.isTrue(yield* manager.hasSessionForTest({ threadId: "thread-1" }), "the attached one");
      assert.isFalse(
        yield* manager.hasSessionForTest({ threadId: "thread-2" }),
        "the oldest unattached one went",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("closes a thread's session, and every session when the scope ends", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["one"],
      });
      yield* manager.closeThread({ threadId: "thread-1" });
      assert.isFalse(yield* manager.hasSessionForTest({ threadId: "thread-1" }));
      assert.isAtLeast(fake.killed.length, 1, "the process was stopped");
    }).pipe(Effect.scoped),
  );

  it.effect("kills every Neovim when the manager's scope closes", () =>
    Effect.gen(function* () {
      const { root, configDirectory } = yield* scratchConfig();
      const fake = new FakeNvim();
      const scope = yield* Scope.make();

      const manager = yield* EditorSessionManager.makeWithOptions({
        configDirectory,
        stateDir: root,
      }).pipe(Effect.provide(fakeAdapterLayer(fake)), Scope.provide(scope));
      yield* manager.open({
        threadId: "thread-1",
        cwd: root,
        relativePath: "a.ts",
        lines: ["one"],
      });

      assert.lengthOf(fake.killed, 0, "still running while the server is");
      yield* Scope.close(scope, Effect.void as never);
      assert.isAtLeast(fake.killed.length, 1, "and stopped when it is not");
    }).pipe(Effect.scoped),
  );

  it.effect("reports why Neovim would not start, and records no session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "editor-manager-" });
      const fake = new FakeNvim();
      const manager = yield* EditorSessionManager.makeWithOptions({
        // A directory that is not there. The launch refuses before it spawns,
        // and a session that never started must not be remembered as one.
        configDirectory: `${root}/nowhere`,
        stateDir: root,
      }).pipe(Effect.provide(fakeAdapterLayer(fake)));

      const outcome = yield* manager
        .open({ threadId: "thread-1", cwd: root, relativePath: "a.ts", lines: ["one"] })
        .pipe(Effect.result);

      assert.isTrue(Result.isFailure(outcome));
      if (!Result.isFailure(outcome)) return;
      assert.strictEqual(outcome.failure._tag, "EditorSessionSpawnError");
      if (outcome.failure._tag !== "EditorSessionSpawnError") return;
      assert.strictEqual(outcome.failure.reason, "config-missing");
      assert.lengthOf(fake.spawns, 0, "nothing was spawned");
      assert.isFalse(yield* manager.hasSessionForTest({ threadId: "thread-1" }));
    }).pipe(Effect.scoped),
  );

  it.effect("applies a re-sent input batch once when its sequence was already applied", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({ threadId: "thread-seq", cwd: root, relativePath: "a.ts", lines: [""] });
      const inputs = () => fake.calls.filter((call) => call.method === "nvim_input");

      // The client lost the reply to batch 1 and sends it again, as it does
      // after a reconnect. Neovim already has those keys.
      yield* manager.input({
        threadId: "thread-seq",
        keys: "dw",
        sequence: { lane: "L", index: 1 },
      });
      yield* manager.input({
        threadId: "thread-seq",
        keys: "dw",
        sequence: { lane: "L", index: 1 },
      });
      yield* manager.input({
        threadId: "thread-seq",
        keys: "x",
        sequence: { lane: "L", index: 2 },
      });

      assert.deepStrictEqual(
        inputs().map((call) => call.params[0]),
        ["dw", "x"],
        "a batch the session already applied was given to Neovim a second time",
      );

      // Another client lane (a reload, a second window) starts its own count,
      // and is never held behind the first lane's numbers.
      yield* manager.input({
        threadId: "thread-seq",
        keys: "u",
        sequence: { lane: "M", index: 0 },
      });
      // A request without a sequence is applied as before.
      yield* manager.input({ threadId: "thread-seq", keys: "j" });
      assert.deepStrictEqual(
        inputs().map((call) => call.params[0]),
        ["dw", "x", "u", "j"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("applies a batch once when another window's input lands between its retries", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({ threadId: "thread-two", cwd: root, relativePath: "a.ts", lines: [""] });
      const inputs = () =>
        fake.calls.filter((call) => call.method === "nvim_input").map((call) => call.params[0]);

      // Window A lost its reply to batch 1; window B typed meanwhile.
      yield* manager.input({
        threadId: "thread-two",
        keys: "x",
        sequence: { lane: "A", index: 1 },
      });
      yield* manager.input({
        threadId: "thread-two",
        keys: "y",
        sequence: { lane: "B", index: 1 },
      });
      yield* manager.input({
        threadId: "thread-two",
        keys: "x",
        sequence: { lane: "A", index: 1 },
      });

      assert.deepStrictEqual(inputs(), ["x", "y"], "window A's batch was applied twice");
    }).pipe(Effect.scoped),
  );

  it.effect("records a batch Neovim accepted even when the request is interrupted", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({ threadId: "thread-cut", cwd: root, relativePath: "a.ts", lines: [""] });
      const inputs = () => fake.calls.filter((call) => call.method === "nvim_input");

      // The socket closes after Neovim has the keys and before its answer
      // comes back: the request's fiber is interrupted mid-call.
      fake.holdReplies((method) => method === "nvim_input");
      const first = yield* manager
        .input({ threadId: "thread-cut", keys: "x", sequence: { lane: "A", index: 1 } })
        .pipe(Effect.forkChild);
      yield* fake.awaitHeldReply();
      const interrupting = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      fake.releaseReplies();
      yield* Fiber.join(interrupting);

      // The client re-sends the batch it never heard back about.
      yield* manager.input({
        threadId: "thread-cut",
        keys: "x",
        sequence: { lane: "A", index: 1 },
      });
      assert.lengthOf(inputs(), 1, "the re-sent batch was given to Neovim a second time");
    }).pipe(Effect.scoped),
  );

  it.effect("sends the rest of a batch Neovim accepted only part of", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      yield* manager.open({
        threadId: "thread-part",
        cwd: root,
        relativePath: "a.ts",
        lines: [""],
      });
      // A full input buffer: Neovim takes three bytes, then the rest.
      let first = true;
      fake.respondWith((method, params) => {
        if (method !== "nvim_input") return null;
        const length = new TextEncoder().encode(String(params[0])).length;
        if (first) {
          first = false;
          return 3;
        }
        return length;
      });
      yield* manager.input({
        threadId: "thread-part",
        keys: "abcdef",
        sequence: { lane: "A", index: 1 },
      });
      assert.deepStrictEqual(
        fake.calls.filter((call) => call.method === "nvim_input").map((call) => call.params[0]),
        ["abcdef", "def"],
        "the keys Neovim did not take were dropped",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports a re-sent batch from before a Neovim restart as lost, not applied", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      fake.lines = ["one"];
      yield* manager.open({
        threadId: "thread-gen",
        cwd: root,
        relativePath: "a.ts",
        lines: ["one"],
      });
      const restarted = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.attachStream({ threadId: "thread-gen" }, (event) =>
        event.type === "message" && event.text.includes("restarted")
          ? Deferred.succeed(restarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      // Neovim accepted batch 1 and exited before running it; the reply was lost.
      yield* manager.input({
        threadId: "thread-gen",
        keys: "dd",
        sequence: { lane: "A", index: 1 },
      });
      fake.crash();
      yield* Deferred.await(restarted);
      const before = fake.calls.filter((call) => call.method === "nvim_input").length;

      const outcome = yield* manager
        .input({ threadId: "thread-gen", keys: "dd", sequence: { lane: "A", index: 1 } })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(outcome), "the retry claimed the keys were applied");
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "EditorSessionInputLostError");
      }
      assert.strictEqual(
        fake.calls.filter((call) => call.method === "nvim_input").length,
        before,
        "and nothing was typed into the new Neovim",
      );
      // A new batch goes to the new Neovim as usual.
      yield* manager.input({
        threadId: "thread-gen",
        keys: "j",
        sequence: { lane: "A", index: 2 },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("never sends an attachment a held insertion its snapshot already contains", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      fake.lines = ["old"];
      yield* manager.open({
        threadId: "thread-late",
        cwd: root,
        relativePath: "a.ts",
        lines: ["old"],
      });

      // An insertion arrives and is held for its frame.
      fake.notify("nvim_buf_lines_event", [2, 7, 0, 0, ["inserted"], false]);
      yield* manager.settleForTest({ threadId: "thread-late" }).pipe(Effect.ignore);
      // A window attaches in the meantime; its snapshot holds the insertion.
      const events = yield* collect(manager, "thread-late");
      fake.notify("redraw", [["flush"]]);
      yield* manager.settleForTest({ threadId: "thread-late" });

      const seen = yield* Ref.get(events);
      assert.deepStrictEqual(seen[0]?.type === "snapshot" ? seen[0].snapshot.lines : null, [
        "inserted",
        "old",
      ]);
      assert.deepStrictEqual(
        seen.filter((event) => event.type === "lines"),
        [],
        "the insertion was delivered again after the snapshot that holds it",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a path that climbs out of the project", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      const outcome = yield* manager
        .open({ threadId: "thread-1", cwd: root, relativePath: "../escape.ts", lines: [] })
        .pipe(Effect.result);

      assert.isTrue(Result.isFailure(outcome), "an escaping path is refused");
      assert.lengthOf(fake.spawns, 0, "before anything is started");
    }).pipe(Effect.scoped),
  );
});
