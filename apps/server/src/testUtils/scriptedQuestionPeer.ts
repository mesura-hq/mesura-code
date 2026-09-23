import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
type Message = ReturnType<typeof decodeMessage>;

/** A deterministic stdio peer. Provider runtimes still encode and decode native RPC messages. */
export const makeScriptedQuestionPeer = Effect.fn("makeScriptedQuestionPeer")(function* (
  replies: (message: Message) => ReadonlyArray<Message>,
) {
  const incoming = yield* Queue.unbounded<Uint8Array>();
  const received = yield* Queue.unbounded<Message>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let remainder = "";
  const send = (message: Message) =>
    Queue.offer(incoming, encoder.encode(`${JSON.stringify(message)}\n`));
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      remainder += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = remainder.indexOf("\n")) !== -1) {
        const message = decodeMessage(remainder.slice(0, newline));
        remainder = remainder.slice(newline + 1);
        yield* Queue.offer(received, message);
        for (const reply of replies(message)) yield* send(reply);
      }
    }),
  );
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin,
    stdout: Stream.fromQueue(incoming),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  return { send, received, spawner: ChildProcessSpawner.make(() => Effect.succeed(handle)) };
});
