/**
 * Binding and unbinding a Unix socket listener, as promises; framing lives in `threadStream.ts`.
 * Only `node:net` here: diagnostics forbid node builtins where an Effect service exists, and none
 * exists for sockets.
 */
import * as NodeNet from "node:net";

/**
 * Rejects with the bind error instead of leaving it to the server's `error` handler. The handler
 * is removed on both paths: left attached, a later runtime error would reject a settled promise,
 * silently.
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
