import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import { assert, it } from "vite-plus/test";

import { closeServer, createSttServer, listenOnPath } from "./SttSocket.ts";
import type { SttOutcome, SttRequest } from "./sttProtocol.ts";

// os.tmpdir() exists, so binding straight into it needs no directory work —
// which keeps this file to `node:net` and `node:os`, the two builtins the
// repository does not route through Effect. The filesystem criteria live in
// sttSocketFiles.test.ts.
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

// Acceptance: the client receives one receipt line on the same connection,
// written after delivery was attempted and not before. The ordering is the
// whole contract: the shell decides whether the dictation survived by reading
// this line, so a receipt written before the attempt is a lie it cannot detect.
it("answers with one receipt line, written after the delivery attempt resolves", async () => {
  const socketPath = tempSocketPath();
  const order: Array<string> = [];
  const server = createSttServer({
    deliver: async (request: SttRequest): Promise<SttOutcome> => {
      await Promise.resolve();
      order.push(`delivered:${request.text}`);
      return { kind: "placed" };
    },
  });
  await listenOnPath(server, socketPath);

  const reply = await exchange(
    socketPath,
    JSON.stringify({ type: "stt_inject", text: "hola", submit: false }),
  );
  order.push("replied");

  assert.deepEqual(order, ["delivered:hola", "replied"]);
  assert.deepEqual(JSON.parse(reply), { ok: true, outcome: "placed" });

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
      return { kind: "placed" };
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

// Acceptance: the absence of a conversation reaches the shell as its own
// outcome rather than as a fault.
it("passes a no-conversation outcome through to the receipt", async () => {
  const socketPath = tempSocketPath();
  const server = createSttServer({ deliver: async () => ({ kind: "no-conversation" }) });
  await listenOnPath(server, socketPath);

  const reply = await exchange(
    socketPath,
    JSON.stringify({ type: "stt_inject", text: "hola", submit: false }),
  );

  assert.deepEqual(JSON.parse(reply), { ok: false, outcome: "no-conversation" });

  await closeServer(server);
});
