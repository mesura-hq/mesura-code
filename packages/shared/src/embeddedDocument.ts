const EXIT_METHOD = "t3/notifications/exit";

export function isEmbeddedDocumentExit(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  return (
    message.jsonrpc === "2.0" &&
    message.method === EXIT_METHOD &&
    Object.keys(message).every((key) => key === "jsonrpc" || key === "method")
  );
}

// Shift+Escape exits at capture time, before any page handler can stop it. Plain Escape waits
// for the page's own handlers, which may use it; a stranded listener goes on the next key.
export const EMBEDDED_DOCUMENT_EXIT_SCRIPT = `(() => {
  if (window.parent === window || window.__mesuraDocumentExit1) return;
  window.__mesuraDocumentExit1 = true;
  let pending;
  window.addEventListener("keydown", (event) => {
    if (pending) window.removeEventListener("keydown", pending);
    pending = undefined;
    if (event.key !== "Escape") return;
    const exit = () => window.parent.postMessage({ jsonrpc: "2.0", method: ${JSON.stringify(EXIT_METHOD)} }, "*");
    if (event.shiftKey) {
      event.preventDefault();
      exit();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const finish = (received) => {
      window.removeEventListener("keydown", finish);
      pending = undefined;
      if (received !== event || event.defaultPrevented) return;
      event.preventDefault();
      exit();
    };
    pending = finish;
    window.addEventListener("keydown", finish);
  }, true);
})();`;
