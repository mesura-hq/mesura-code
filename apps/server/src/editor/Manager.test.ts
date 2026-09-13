import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EditorSessionEvent } from "@t3tools/contracts";
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
  #outbound: Queue.Queue<Uint8Array> | null = null;
  #responder: Responder = () => null;
  /** The buffer the fake pretends the window is on, as `mesura.open` returns. */
  #nextBufferNumber = 1;
  lines: string[] = [];

  respondWith(responder: Responder): void {
    this.#responder = responder;
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
    const setOutbound = (queue: Queue.Queue<Uint8Array>) => {
      this.#outbound = queue;
    };

    return Effect.gen(function* () {
      const outbound = yield* Queue.make<Uint8Array>();
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
