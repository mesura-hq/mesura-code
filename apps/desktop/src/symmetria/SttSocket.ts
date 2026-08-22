/**
 * The Unix socket Symmetria Shell writes a dictation to.
 *
 * One line in, one line out, on the same connection, written only after the
 * delivery attempt resolves. The ordering is the contract rather than a detail:
 * the shell reads that line to decide whether the dictation survived, and in
 * socket mode it keeps no clipboard copy, so a receipt written before the
 * attempt is a lie it has no way to detect.
 *
 * Only `node:net` here. The filesystem side lives in `sttSocketFiles.ts`, which
 * uses Effect's own APIs as the repository requires.
 */
import * as NodeNet from "node:net";

import { formatReceipt, parseSttRequest, type SttOutcome, type SttRequest } from "./sttProtocol.ts";

export type SttServerOptions = {
  readonly deliver: (request: SttRequest) => Promise<SttOutcome>;
  /** Called for anything a socket callback would otherwise swallow. */
  readonly onError?: (error: Error) => void;
};

export function createSttServer(options: SttServerOptions): NodeNet.Server {
  const { deliver, onError } = options;

  return NodeNet.createServer((connection) => {
    connection.setEncoding("utf8");
    let buffered = "";
    let answered = false;

    const answer = (outcome: SttOutcome): void => {
      if (answered) return;
      answered = true;
      connection.write(`${formatReceipt(outcome)}\n`, () => connection.end());
    };

    connection.on("error", (error) => onError?.(error));

    connection.on("data", (chunk: string) => {
      if (answered) return;
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      // The shell sends exactly one line and waits. Serve the first complete
      // line and ignore whatever follows on the same connection.
      if (newline === -1) return;
      const line = buffered.slice(0, newline);

      const parsed = parseSttRequest(line);
      if (!parsed.ok) {
        answer({ kind: "error", code: parsed.code, detail: parsed.detail });
        return;
      }

      deliver(parsed.request).then(answer, (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        onError?.(error);
        answer({ kind: "error", code: "invalid-request", detail: error.message });
      });
    });
  });
}

export function listenOnPath(server: NodeNet.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.on("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export function closeServer(server: NodeNet.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
