import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import { assert, it } from "vite-plus/test";

import { createSttServer } from "./SttSocket.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";
import type { SttOutcome, SttRequest } from "./sttProtocol.ts";

// os.tmpdir() exists, so binding straight into it needs no directory work —
// which keeps this file to `node:net` and `node:os`, the two builtins the
// repository does not route through Effect. The filesystem criteria live in
// socketFiles.test.ts.
let counter = 0;
const tempSocketPath = (): string =>
  `${NodeOS.tmpdir()}/stt-socket-${process.pid}-${(counter += 1)}.sock`;

// Write one line, read one line, close. Exactly what stt-inject.sh does.
const exchange = (socketPath: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const client = NodeNet.createConnection(socketPath);
    let received = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) {
        client.end();
        resolve(received.trim());
      }
    });
    client.on("error", reject);
    client.on("connect", () => client.write(`${line}\n`));
  });

it("answers with one refusal line after the compatibility endpoint resolves", async () => {
  const socketPath = tempSocketPath();
  const order: Array<string> = [];
  const server = createSttServer({
    deliver: async (request: SttRequest): Promise<SttOutcome> => {
      await Promise.resolve();
      order.push(`refused:${request.text}`);
      return {
        kind: "error",
        code: "reserved-session-required",
        detail: "Mesura requires a reserved dictation session",
      };
    },
  });
  await listenOnPath(server, socketPath);

  const reply = await exchange(
    socketPath,
    JSON.stringify({ type: "stt_inject", text: "hola", submit: false }),
  );
  order.push("replied");

  assert.deepEqual(order, ["refused:hola", "replied"]);
  assert.deepEqual(JSON.parse(reply), {
    ok: false,
    outcome: "reserved-session-required",
    detail: "Mesura requires a reserved dictation session",
  });

  await closeServer(server);
});

// Acceptance: malformed JSON returns a structured error receipt rather than
// closing the connection or hanging.
it("answers malformed input instead of closing the connection", async () => {
  const socketPath = tempSocketPath();
  let delivered = false;
  const server = createSttServer({
    deliver: async () => {
      delivered = true;
      return {
        kind: "error",
        code: "reserved-session-required",
        detail: "Mesura requires a reserved dictation session",
      };
    },
  });
  await listenOnPath(server, socketPath);

  const reply = await exchange(socketPath, "{ this is not json");
  const receipt = JSON.parse(reply) as { ok: boolean; outcome: string };

  assert.isFalse(receipt.ok);
  assert.equal(receipt.outcome, "malformed-json");
  assert.isFalse(delivered, "a request that did not parse must never reach delivery");

  await closeServer(server);
});

it("can refuse a destination-less request without applying an effect", async () => {
  const socketPath = tempSocketPath();
  let refusalAttempts = 0;
  const server = createSttServer({
    deliver: async () => {
      refusalAttempts += 1;
      return {
        kind: "error",
        code: "reserved-session-required",
        detail: "Mesura requires a reserved dictation session",
      };
    },
  });
  await listenOnPath(server, socketPath);

  const reply = await exchange(
    socketPath,
    JSON.stringify({ type: "stt_inject", text: "hola", submit: true }),
  );

  assert.equal(refusalAttempts, 1);
  assert.deepEqual(JSON.parse(reply), {
    ok: false,
    outcome: "reserved-session-required",
    detail: "Mesura requires a reserved dictation session",
  });

  await closeServer(server);
});
