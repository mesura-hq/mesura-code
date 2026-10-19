import type { EditorSessionEvent } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Packr, Unpackr } from "msgpackr";

import { NvimAdapter, type NvimProcess, type NvimSpawnInput } from "./NvimAdapter.ts";
import * as EditorSessionManager from "./Manager.ts";

/**
 * A Neovim that is not there, for driving the manager.
 *
 * The fake answers msgpack-RPC rather than standing in for the bridge, so
 * everything between the manager and the wire — the framing, the mirror, the
 * launch resolution — is exercised too. What it cannot do is behave like
 * Neovim; that is the conformance harness's job, and the two are deliberately
 * separate. A fake that tried to be Neovim would be a second implementation of
 * it, and the tests would agree with whichever of the two was wrong.
 */

const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

/** What the fake answers for a method, beyond the handful it always knows. */
type Responder = (method: string, params: ReadonlyArray<unknown>) => unknown;

export class FakeNvim {
  readonly spawns: NvimSpawnInput[] = [];
  readonly calls: Array<{ method: string; params: ReadonlyArray<unknown> }> = [];
  readonly killed: string[] = [];
  #outbound: Queue.Queue<Uint8Array, Cause.Done> | null = null;
  #responder: Responder = () => null;
  /** The buffer the fake pretends the window is on, as `mesura.open` returns. */
  #nextBufferNumber = 1;
  lines: string[] = [];
  /** Where the fake says the cursor is, when the host reads or is told. */
  cursor = { line: 1, col: 1 };
  /** Replies to calls this matches wait in `#heldReplies` until released. */
  #holdMatch: ((method: string, params: ReadonlyArray<unknown>) => boolean) | null = null;
  #heldReplies: Uint8Array[] = [];

  /** Holds the replies to matching calls, the way a busy or stalled Neovim does. */
  holdReplies(match: (method: string, params: ReadonlyArray<unknown>) => boolean): void {
    this.#holdMatch = match;
  }

  /** Answers every held call, in order, and stops holding. */
  releaseReplies(): void {
    this.#holdMatch = null;
    const held = this.#heldReplies;
    this.#heldReplies = [];
    for (const reply of held) if (this.#outbound !== null) Queue.offerUnsafe(this.#outbound, reply);
  }

  /** Whether a reply is being held. */
  get holding(): number {
    return this.#heldReplies.length;
  }

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
        if (code.includes("mesura.cursor_state")) {
          return { line: this.cursor.line, col: this.cursor.col, mode: "n", window: 1000 };
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
    const reply = (method: string, params: ReadonlyArray<unknown>, bytes: Uint8Array) => {
      if (this.#holdMatch?.(method, params)) this.#heldReplies.push(bytes);
      else if (this.#outbound !== null) Queue.offerUnsafe(this.#outbound, bytes);
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
            reply(method, params, packr.pack([1, messageId, null, answer(method, params)]));
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

export const fakeAdapterLayer = (fake: FakeNvim) =>
  Layer.succeed(NvimAdapter, NvimAdapter.of({ spawn: (input) => fake.spawn(input) }));

/** A configuration directory that exists, so the real launch resolution runs. */
export const scratchConfig = Effect.fn("scratchConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "editor-manager-" });
  const configDirectory = `${root}/config`;
  yield* fs.makeDirectory(configDirectory, { recursive: true });
  yield* fs.writeFileString(`${configDirectory}/init.lua`, "-- a configuration\n");
  return { root, configDirectory };
});

export interface Fixture {
  readonly manager: EditorSessionManager.EditorSessionManager["Service"];
  readonly fake: FakeNvim;
  readonly root: string;
}

export const createManager = (options: { readonly maxSessions?: number } = {}) =>
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

/**
 * Attaches through the websocket layer's stream and collects until it ends.
 * Returns once the attachment has its snapshot, so what follows happens to a
 * live attachment.
 */
export const attachUntilEnd = (
  manager: EditorSessionManager.EditorSessionManager["Service"],
  threadId: string,
) =>
  Effect.gen(function* () {
    const attached = yield* Deferred.make<void>();
    const collecting = yield* Stream.runCollect(
      EditorSessionManager.attachEventStream(manager, { threadId }).pipe(
        Stream.tap(() => Deferred.succeed(attached, undefined)),
      ),
    ).pipe(
      Effect.map((events) => [...events]),
      Effect.forkChild,
    );
    yield* Deferred.await(attached);
    return collecting;
  });

/** Collects everything an attachment reports, for the life of the scope. */
export const collect = (
  manager: EditorSessionManager.EditorSessionManager["Service"],
  threadId: string,
) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<EditorSessionEvent>>([]);
    const unsubscribe = yield* manager.attachStream({ threadId }, (event) =>
      Ref.update(events, (all) => [...all, event]),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    return events;
  });
