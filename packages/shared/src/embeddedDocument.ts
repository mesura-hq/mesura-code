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

// Register at capture time so the bubble listener follows the page's window listeners.
// Remove a stranded listener on the next key if the page stopped propagation.
export const EMBEDDED_DOCUMENT_EXIT_SCRIPT = `(() => {
  if (window.parent === window || window.__mesuraDocumentExit1) return;
  window.__mesuraDocumentExit1 = true;
  let pending;
  window.addEventListener("keydown", (event) => {
    if (pending) window.removeEventListener("keydown", pending);
    pending = undefined;
    if (event.key !== "Escape") return;
    if (!event.shiftKey && (event.ctrlKey || event.metaKey || event.altKey)) return;
    const finish = (received) => {
      window.removeEventListener("keydown", finish);
      pending = undefined;
      if (received !== event || (!event.shiftKey && event.defaultPrevented)) return;
      event.preventDefault();
      window.parent.postMessage({ jsonrpc: "2.0", method: ${JSON.stringify(EXIT_METHOD)} }, "*");
    };
    pending = finish;
    window.addEventListener("keydown", finish);
  }, true);
})();`;
