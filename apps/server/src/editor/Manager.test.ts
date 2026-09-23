import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EditorSessionEvent } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Packr, Unpackr } from "msgpackr";

import { NvimAdapter, type NvimProcess, type NvimSpawnInput } from "./NvimAdapter.ts";
import * as EditorSessionManager from "./Manager.ts";

/**
 * The manager, driven against a Neovim that is not there.
 *
 * The fake answers msgpack-RPC rather than standing in for the bridge, so
 * everything between the manager and the wire — the framing from phase 1, the
 * mirror, the launch resolution from phase 2 — is exercised here too. What it
 * cannot do is behave like Neovim; that is the conformance harness's job, and
 * the two are deliberately separate. A fake that tried to be Neovim would be a
 * second implementation of it, and the tests would agree with whichever of the
 * two was wrong.
 */

const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

/** What the fake answers for a method, beyond the handful it always knows. */
type Responder = (method: string, params: ReadonlyArray<unknown>) => unknown;

class FakeNvim {
  readonly spawns: NvimSpawnInput[] = [];
  readonly calls: Array<{ method: string; params: ReadonlyArray<unknown> }> = [];
  readonly killed: string[] = [];
  #outbound: Queue.Queue<Uint8Array, Cause.Done> | null = null;
  #responder: Responder = () => null;
  /** The buffer the fake pretends the window is on, as `mesura.open` returns. */
  #nextBufferNumber = 1;
  lines: string[] = [];

  respondWith(responder: Responder): void {
    this.#responder = responder;
  }

  /** Ends the current process's output, which is how Neovim exiting looks. */
  crash(): void {
    if (this.#outbound !== null) Queue.endUnsafe(this.#outbound);
  }

  /** Pushes a notification at the host, the way a real Neovim would. */
  notify(method: string, params: ReadonlyArray<unknown>): void {
    if (this.#outbound === null) return;
    Queue.offerUnsafe(this.#outbound, packr.pack([2, method, params]));
  }

  #answer(method: string, params: ReadonlyArray<unknown>): unknown {
    switch (method) {
      case "nvim_get_api_info":
        return [1, { version: { major: 0, minor: 12, patch: 4 } }];
      case "nvim_buf_get_lines":
        return this.lines;
      case "nvim_replace_termcodes":
        return params[0];
      case "nvim_exec_lua": {
        const code = String(params[0]);
        if (code.includes("nvim_get_current_buf")) return 1;
        if (code.includes("nvim_win_get_cursor")) {
          return { line: 1, col: 1, mode: "n", window: 1000 };
        }
        if (code.includes("mesura.open")) {
          this.#nextBufferNumber += 1;
          return this.#nextBufferNumber;
        }
        if (code.includes("mesura_settled")) {
          // The settle marker goes back as a notification, exactly as the real
          // host plugin sends it, so the bridge's own barrier is exercised.
          const marker = (params[1] as ReadonlyArray<unknown>)[0];
          this.notify("mesura_settled", [marker]);
          return null;
        }
        return this.#responder(method, params);
      }
      default:
        return this.#responder(method, params);
    }
  }

  spawn(input: NvimSpawnInput): Effect.Effect<NvimProcess, never, Scope.Scope> {
    this.spawns.push(input);
    // The pieces this needs are taken out here rather than reaching back
    // through `this` inside the generator, which cannot see it.
    const { calls, killed } = this;
    const answer = (method: string, params: ReadonlyArray<unknown>) => this.#answer(method, params);
    const setOutbound = (queue: Queue.Queue<Uint8Array, Cause.Done>) => {
      this.#outbound = queue;
    };

    return Effect.gen(function* () {
      // Typed to end, so `crash` can close it the way a dead process closes stdout.
      const outbound = yield* Queue.make<Uint8Array, Cause.Done>();
      setOutbound(outbound);
      return {
        pid: 4242,
        write: (bytes: Uint8Array) => {
          unpackr.unpackMultiple(bytes, (frame) => {
            const [kind, messageId, method, params] = frame as [
              number,
              number,
              string,
              ReadonlyArray<unknown>,
            ];
            if (kind !== 0) return;
            calls.push({ method, params });
            Queue.offerUnsafe(outbound, packr.pack([1, messageId, null, answer(method, params)]));
          });
        },
        stdout: Stream.fromQueue(outbound),
        stderr: Stream.empty,
        exitCode: Effect.succeed(0),
        kill: (signal?: string) =>
          Effect.sync(() => {
            killed.push(signal ?? "SIGTERM");
          }),
      } satisfies NvimProcess;
    });
  }
}

const fakeAdapterLayer = (fake: FakeNvim) =>
  Layer.succeed(NvimAdapter, NvimAdapter.of({ spawn: (input) => fake.spawn(input) }));

/** A configuration directory that exists, so the real launch resolution runs. */
const scratchConfig = Effect.fn("scratchConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "editor-manager-" });
  const configDirectory = `${root}/config`;
  yield* fs.makeDirectory(configDirectory, { recursive: true });
  yield* fs.writeFileString(`${configDirectory}/init.lua`, "-- a configuration\n");
  return { root, configDirectory };
});

interface Fixture {
  readonly manager: EditorSessionManager.EditorSessionManager["Service"];
  readonly fake: FakeNvim;
  readonly root: string;
}

const createManager = (options: { readonly maxSessions?: number } = {}) =>
  Effect.gen(function* () {
    const { root, configDirectory } = yield* scratchConfig();
    const fake = new FakeNvim();
    const manager = yield* EditorSessionManager.makeWithOptions({
      configDirectory,
      stateDir: root,
      ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    }).pipe(Effect.provide(fakeAdapterLayer(fake)));
    return { manager, fake, root } satisfies Fixture;
  });

/** Collects everything an attachment reports, for the life of the scope. */
const collect = (manager: EditorSessionManager.EditorSessionManager["Service"], threadId: string) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<EditorSessionEvent>>([]);
    const unsubscribe = yield* manager.attachStream({ threadId }, (event) =>
      Ref.update(events, (all) => [...all, event]),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    return events;
  });

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
      const attached = yield* Deferred.make<void>();
      const collecting = yield* Stream.runCollect(
        EditorSessionManager.attachEventStream(manager, { threadId: "thread-end" }).pipe(
          Stream.tap(() => Deferred.succeed(attached, undefined)),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(attached);

      yield* manager.closeThread({ threadId: "thread-end" });

      // The stream ends on its own; joining would wait forever otherwise.
      const events = [...(yield* Fiber.join(collecting))];
      assert.deepStrictEqual(events.at(-1), { type: "exited", code: null, reason: "closed" });
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

      // Nothing else moves the mirror. The `BufEnter` announcement that used
      // to was removed — Neovim announces a plugin's picker exactly the way it
      // announces a file — so this call is the *only* thing that puts the
      // mirror on the file the client asked for. Without it `open` answers
      // with a snapshot built from whichever buffer the mirror was left on:
      // the new file's name over the previous file's text, which the client
      // then writes to disk. That happened to three real files.
      //
      // The conformance suite cannot hold this. Its own helper does the
      // following itself, so deleting this call from the manager leaves every
      // conformance test green.
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
