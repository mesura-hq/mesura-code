/** Drains browser tasks without waiting for elapsed time or animation frames. */
export function flushBrowserTasks(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener(
      "message",
      () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      },
      { once: true },
    );
    channel.port1.start();
    channel.port2.postMessage(null);
  });
}
