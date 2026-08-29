import * as NodeNet from "node:net";

import type { SymmetriaDictationSession } from "@symmetria/broker-contract";

import {
  formatDictationServerMessage,
  parseDictationClientLine,
  type DictationClientMessage,
  type DictationServerMessage,
} from "./dictationProtocol.ts";

const MAX_INPUT_BYTES = 1024 * 1024;

export type DictationSessionServerOptions = {
  readonly snapshot: () => SymmetriaDictationSession | null;
  readonly subscribe: (listener: (snapshot: SymmetriaDictationSession) => void) => () => void;
  readonly subscribeReceipts?: (listener: (receipt: DictationServerMessage) => void) => () => void;
  readonly handle: (message: DictationClientMessage) => Promise<DictationServerMessage | null>;
  readonly onError?: (error: Error) => void;
};

export function createDictationSessionServer(
  options: DictationSessionServerOptions,
): NodeNet.Server {
  return NodeNet.createServer((connection) => {
    let buffered = "";
    let handling = Promise.resolve();
    let handlerFailed = false;
    connection.setEncoding("utf8");

    const write = (message: DictationServerMessage): void => {
      if (!connection.destroyed) connection.write(formatDictationServerMessage(message));
    };

    // The first frame is synchronous by contract. Subscribing after it keeps a
    // state change from overtaking the complete reconnect snapshot.
    write({ type: "dictation.snapshot", session: options.snapshot() });
    const unsubscribe = options.subscribe((session) =>
      write({ type: "dictation.snapshot", session }),
    );
    const unsubscribeReceipts = options.subscribeReceipts?.(write) ?? (() => undefined);

    connection.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_INPUT_BYTES) {
        write({
          type: "dictation.error",
          code: "malformed_input",
          detail: "message exceeds the input limit",
        });
        buffered = "";
        return;
      }

      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        handling = handling.then(async () => {
          if (handlerFailed) return;
          const parsed = parseDictationClientLine(line);
          if (!parsed.ok) {
            write({ type: "dictation.error", code: parsed.code, detail: parsed.detail });
            return;
          }
          const response = await options.handle(parsed.message);
          if (response !== null) write(response);
        });
        handling = handling.catch((cause) => {
          handlerFailed = true;
          options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
          connection.destroy();
        });
      }
    });
    connection.on("error", (error) => options.onError?.(error));
    connection.on("close", () => {
      unsubscribeReceipts();
      unsubscribe();
    });
  });
}
