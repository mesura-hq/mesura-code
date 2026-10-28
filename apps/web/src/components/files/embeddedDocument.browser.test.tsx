import { describe, expect, it, vi } from "vite-plus/test";
import { EMBEDDED_DOCUMENT_EXIT_SCRIPT } from "@t3tools/shared/embeddedDocument";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { injectMcpAppCsp, injectMcpAppThemeBootstrap } from "@t3tools/shared/mcpApp";
import { render } from "../../../test/render";

const exerciseKeys = `<script>
  const input = document.createElement("input");
  document.body.append(input);
  let handled = false;
  window.addEventListener("keydown", (event) => { if (handled) event.preventDefault(); });
  const press = (options = {}) => {
    const event = new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true, ...options});
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const plain = press();
  handled = true;
  press();
  const shifted = press({shiftKey: true});
  handled = false;
  press({ctrlKey: true});
  press({isComposing: true, shiftKey: true});
  const stop = (event) => event.stopPropagation();
  input.addEventListener("keydown", stop);
  press();
  input.removeEventListener("keydown", stop);
  press();
  window.parent.postMessage({test: "document-keys-done", plain, shifted}, "*");
</script>`;

describe("embedded document exit bootstrap", () => {
  it.each([
    ["HTML render", injectHtmlRenderBootstrap],
    ["MCP app", (html: string) => injectMcpAppThemeBootstrap(injectMcpAppCsp(html, undefined))],
  ] as const)(
    "runs after page handlers in a sandboxed %s without duplicate listeners",
    async (_name, inject) => {
      const messages: unknown[] = [];
      const receive = (event: MessageEvent) => {
        if (
          event.data?.method === "t3/notifications/exit" ||
          event.data?.test === "document-keys-done"
        ) {
          messages.push(event.data);
        }
      };
      window.addEventListener("message", receive);
      using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", receive) };
      await using screen = await render(
        <iframe
          title="Embedded test"
          sandbox="allow-scripts allow-forms"
          srcDoc={inject(
            `<body><script>${EMBEDDED_DOCUMENT_EXIT_SCRIPT}</script>${exerciseKeys}</body>`,
          )}
        />,
      );
      await vi.waitFor(() =>
        expect(messages).toEqual([
          { jsonrpc: "2.0", method: "t3/notifications/exit" },
          { jsonrpc: "2.0", method: "t3/notifications/exit" },
          { jsonrpc: "2.0", method: "t3/notifications/exit" },
          { jsonrpc: "2.0", method: "t3/notifications/exit" },
          { test: "document-keys-done", plain: true, shifted: true },
        ]),
      );
      expect(screen.container.querySelector("iframe")?.contentDocument).toBeNull();
    },
  );
});
