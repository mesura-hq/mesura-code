/**
 * Binding and unbinding a Unix socket server, as promises.
 *
 * Extracted from `SttSocket.ts` when a second socket appeared. Both of these
 * are about the LISTENER and know nothing about what is served over it, which
 * is why they extract cleanly and `createSttServer` does not: that one encodes
 * dictation's one-line-in-one-line-out shape, and the thread publisher pushes
 * instead of answering. Two servers, one way to bind.
 *
 * Only `node:net` here, for the same reason `socketFiles.ts` holds no net: the
 * repository's diagnostics forbid node builtins wherever an Effect service
 * exists, and there is none for sockets.
 */
import * as NodeNet from "node:net";

/**
 * Resolves once the server is listening, and rejects with the bind error
 * rather than leaving it to the server's own `error` handler.
 *
 * The handler is removed on both paths. Leaving it attached would make a later
 * runtime error — a peer resetting a connection, say — reject a promise that
 * has already settled, which is silent.
 */
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
