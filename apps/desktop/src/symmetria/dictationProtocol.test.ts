import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { SymmetriaDictationSession } from "@symmetria/broker-contract";
import * as Schema from "effect/Schema";
import { assert, it } from "vite-plus/test";

import {
  createDictationSessionServer,
  hasRequiredDictationCapabilities,
} from "./dictationSocket.ts";
import {
  DICTATION_CAPABILITIES,
  formatDictationServerMessage,
  parseDictationClientLine,
  subscribeToOrderedRendererFrames,
} from "./dictationProtocol.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";

const session = Schema.decodeUnknownSync(SymmetriaDictationSession)({
  protocolVersion: { major: 1, minor: 2 },
  sessionId: "session-a",
  target: { kind: "thread", environmentId: "environment-a", threadId: "thread-a" },
  source: "shell",
  phase: "processing",
  mode: "submit",
  projectName: "Project A",
  startedAt: "2026-08-29T12:00:00.000Z",
  elapsedMs: 1500,
  audioLevel: null,
  graceRemainingMs: null,
  presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
});

it("parses the reservation request that precedes Shell audio capture", () => {
  const parsed = parseDictationClientLine(
    JSON.stringify({
      type: "dictation.reserve.request",
      protocolVersion: { major: 1, minor: 2 },
      sessionId: "session-a",
      commandId: "command-reserve",
      createdAt: "2026-08-29T12:00:00.000Z",
      source: "shell",
    }),
  );

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.message.type, "dictation.reserve.request");
});

it("refuses an unsupported protocol major during the handshake", () => {
  const parsed = parseDictationClientLine(
    JSON.stringify({
      type: "dictation.hello",
      protocolVersion: { major: 2, minor: 0 },
      capabilities: ["session-control"],
    }),
  );

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "unsupported_protocol");
});

it("formats each server message as exactly one JSON line", () => {
  const line = formatDictationServerMessage({ type: "dictation.snapshot", session });

  assert.equal(line.endsWith("\n"), true);
  assert.notInclude(line.slice(0, -1), "\n");
  assert.deepEqual(JSON.parse(line), { type: "dictation.snapshot", session });
});

it("requires the complete Shell capability set", () => {
  assert.isFalse(hasRequiredDictationCapabilities(["session-control"]));
  assert.isTrue(hasRequiredDictationCapabilities(DICTATION_CAPABILITIES));
});

it("announces Shell availability only after a valid capability handshake", async () => {
  const socketPath = `${NodeOS.tmpdir()}/dictation-capability-${process.pid}.sock`;
  const availability: Array<boolean> = [];
  const server = createDictationSessionServer({
    snapshot: () => null,
    subscribe: () => () => undefined,
    handle: async () => null,
    onCapabilityChange: (available) => availability.push(available),
  });
  await listenOnPath(server, socketPath);

  await new Promise<void>((resolve, reject) => {
    const client = NodeNet.createConnection(socketPath);
    client.resume();
    client.on("error", reject);
    client.on("close", resolve);
    client.on("connect", () => {
      client.write("not-json\n");
      assert.deepEqual(availability, []);
      client.write(
        `${JSON.stringify({
          type: "dictation.hello",
          protocolVersion: { major: 1, minor: 4 },
          capabilities: DICTATION_CAPABILITIES,
        })}\n`,
        () => client.end(),
      );
    });
  });

  assert.deepEqual(availability, [true, false]);
  await closeServer(server);
});

// Acceptance: a persistent Shell reconnect cannot observe a later event before
// it knows the complete held session.
it("sends the current snapshot first on every persistent Shell connection", async () => {
  const socketPath = `${NodeOS.tmpdir()}/dictation-session-${process.pid}.sock`;
  let publish: ((snapshot: typeof session) => void) | null = null;
  const server = createDictationSessionServer({
    snapshot: () => session,
    subscribe: (listener) => {
      publish = listener;
      return () => {
        publish = null;
      };
    },
    handle: async () => null,
  });
  await listenOnPath(server, socketPath);

  const received = await new Promise<Array<unknown>>((resolve, reject) => {
    const client = NodeNet.createConnection(socketPath);
    let buffered = "";
    const messages: Array<unknown> = [];
    client.setEncoding("utf8");
    client.on("error", reject);
    client.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        messages.push(JSON.parse(line));
        if (messages.length === 2) {
          client.end();
          resolve(messages);
        }
      }
    });
    client.on("connect", () => {
      publish?.({ ...session, mode: "inject" });
    });
  });

  assert.deepEqual(received, [
    { type: "dictation.snapshot", session },
    { type: "dictation.snapshot", session: { ...session, mode: "inject" } },
  ]);

  await closeServer(server);
});

it("orders a renderer reconnect snapshot before concurrent later events", async () => {
  const callbacks: {
    push?: (frame: { revision: number; session: typeof session }) => void;
    resolveOpening?: (frame: { revision: number; session: typeof session }) => void;
  } = {};
  const observed: Array<string> = [];
  const opening = new Promise<{ revision: number; session: typeof session }>((resolve) => {
    callbacks.resolveOpening = resolve;
  });

  const unsubscribe = subscribeToOrderedRendererFrames({
    load: () => opening,
    attach: (listener) => {
      callbacks.push = listener;
      return () => {
        delete callbacks.push;
      };
    },
    listener: (snapshot) => observed.push(snapshot?.mode ?? "idle"),
  });

  callbacks.push?.({ revision: 4, session: { ...session, mode: "inject" } });
  callbacks.resolveOpening?.({ revision: 3, session });
  await opening;
  await Promise.resolve();
  unsubscribe();

  assert.deepEqual(observed, ["submit", "inject"]);
});

it("uses queued complete frames when the renderer opening snapshot fails", async () => {
  const callbacks: {
    push?: (frame: { revision: number; session: typeof session }) => void;
    rejectOpening?: (error: Error) => void;
  } = {};
  const observed: Array<string> = [];
  const errors: Array<string> = [];
  const opening = new Promise<{ revision: number; session: typeof session }>((_resolve, reject) => {
    callbacks.rejectOpening = reject;
  });
  const unsubscribe = subscribeToOrderedRendererFrames({
    load: () => opening,
    attach: (listener) => {
      callbacks.push = listener;
      return () => {
        delete callbacks.push;
      };
    },
    listener: (snapshot) => observed.push(snapshot?.mode ?? "idle"),
    onError: (error) => errors.push(error.message),
  });

  callbacks.push?.({ revision: 4, session: { ...session, mode: "inject" } });
  callbacks.rejectOpening?.(new Error("renderer reloaded"));
  await opening.catch(() => undefined);
  await Promise.resolve();
  unsubscribe();

  assert.deepEqual(observed, ["inject"]);
  assert.deepEqual(errors, ["renderer reloaded"]);
});

it("closes a persistent connection when one command handler rejects", async () => {
  const socketPath = `${NodeOS.tmpdir()}/dictation-session-reject-${process.pid}.sock`;
  let handled = 0;
  const errors: Array<string> = [];
  const server = createDictationSessionServer({
    snapshot: () => session,
    subscribe: () => () => undefined,
    handle: async () => {
      handled += 1;
      throw new Error("renderer unavailable");
    },
    onError: (error) => errors.push(error.message),
  });
  await listenOnPath(server, socketPath);

  await new Promise<void>((resolve, reject) => {
    const client = NodeNet.createConnection(socketPath);
    client.resume();
    client.on("error", reject);
    client.on("close", () => resolve());
    client.on("connect", () => {
      const hello = JSON.stringify({
        type: "dictation.hello",
        protocolVersion: { major: 1, minor: 2 },
        capabilities: ["session-control"],
      });
      client.write(`${hello}\n${hello}\n`);
    });
  });

  assert.equal(handled, 1);
  assert.deepEqual(errors, ["renderer unavailable"]);
  await closeServer(server);
});
