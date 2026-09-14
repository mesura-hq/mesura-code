/** Hold an asynchronous boundary until the test explicitly releases it. */
export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
