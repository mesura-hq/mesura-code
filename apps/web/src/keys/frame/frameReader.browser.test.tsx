// The Vim reader inside an embedded page: real keys go to the sandboxed frame, its agent posts
// them, and Vim runs in the app over the page's text.
import { EMBEDDED_DOCUMENT_AGENT_SCRIPT } from "@t3tools/shared/embeddedDocument";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  createWindowListenerFixture,
  registerTestComposerAdapter,
} from "~/test/keyBrowserFixtures";
import { appendBlockToComposer } from "../composer/composerSurface";
import { configureKeyEngine, installKeyEngine, registerKeySurface } from "../keyEngine";
import { readKeyEngineSnapshot } from "../keyEngineStore";
import { frameSurface, installFrameReader, pageQuote } from "./frameReader";

const engineListeners = createWindowListenerFixture(installKeyEngine);
const readerListeners = createWindowListenerFixture(installFrameReader);

/**
 * Reports the page's own keydowns, tells the test each time its reader starts, and on request
 * loses and regains window focus, as switching to another app and back does.
 */
const PAGE_HARNESS = `<script>
  window.addEventListener("keydown", (event) => parent.postMessage({ test: "page-key", key: event.key }, "*"));
  window.addEventListener("message", (event) => {
    if (event.data && event.data.method === "t3/reader/mode" && event.data.params.mode === "read") {
      setTimeout(() => parent.postMessage({ test: "reader-started" }, "*"));
    }
    if (event.data && event.data.test === "switch-away-and-back") {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    }
  });
  parent.postMessage({ test: "loaded" }, "*");
</script>`;

const PAGE = `<body>
<script>${EMBEDDED_DOCUMENT_AGENT_SCRIPT}</script>
<h1>Quarterly report</h1>
<p>Alpha   beta <b>gamma</b>.</p>
<p style="display:none">Hidden text.</p>
<table><tr><td>North</td><td>12</td></tr></table>
<details><summary>More</summary>Closed text<p>Closed block</p></details>
<p><input aria-label="Name"></p>
${PAGE_HARNESS}
</body>`;

async function mountReader(page = PAGE) {
  await using stack = new AsyncDisposableStack();
  const messages: Array<Record<string, unknown>> = [];
  const receive = (event: MessageEvent) => {
    if (event.data && typeof event.data === "object") messages.push(event.data);
  };
  window.addEventListener("message", receive);
  stack.defer(() => window.removeEventListener("message", receive));
  stack.use(engineListeners());
  stack.use(readerListeners());
  stack.defer(registerKeySurface(frameSurface));
  const quotes: string[] = [];
  stack.use(
    registerTestComposerAdapter({
      read: () => ({ prompt: "", cursor: 0 }),
      write: () => {},
      setCursor: () => {},
      editor: () => null,
      insertAtEnd: (markdown) => {
        quotes.push(markdown);
        return true;
      },
    }),
  );
  configureKeyEngine({ enabled: true });
  stack.defer(() => configureKeyEngine({ enabled: false }));
  const screen = stack.use(
    await render(
      <iframe
        data-mesura-chat-object-entry=""
        title="Report"
        sandbox="allow-scripts allow-forms"
        srcDoc={page}
      />,
    ),
  );
  await vi.waitFor(() => expect(messages).toContainEqual({ test: "loaded" }));
  const frame = screen.container.querySelector("iframe")!;
  frame.focus();
  await vi.waitFor(() => expect(messages).toContainEqual({ test: "reader-started" }));
  const environment = stack.move();
  return {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    frame,
    messages,
    quotes,
    pageKeys: () => messages.filter((message) => message.test === "page-key").map((m) => m.key),
    starts: () => messages.filter((message) => message.test === "reader-started").length,
  };
}

describe("the Vim reader in an embedded page", () => {
  it("selects page text by keyboard and quotes it into the composer", async () => {
    await using reader = await mountReader();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "frame", mode: "NORMAL" });

    await userEvent.keyboard("jvE");
    await vi.waitFor(() => expect(readKeyEngineSnapshot().mode).toBe("VISUAL"));
    await userEvent.keyboard("EE{Space}c");
    await vi.waitFor(() =>
      expect(reader.quotes).toEqual([pageQuote("Report", "Alpha beta gamma.")]),
    );
    expect(reader.pageKeys(), "the page never saw a reader key").toEqual([]);
  });

  it("yanks the visible text: hidden and closed text skipped, table cells joined by a tab", async () => {
    await using reader = await mountReader();
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await userEvent.keyboard("yG");
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Quarterly report\nAlpha beta gamma.\nNorth\t12\nMore\n",
      ),
    );
    expect(reader.pageKeys()).toEqual([]);
  });

  it("takes a mouse selection that ends the page as the visual selection", async () => {
    await using reader = await mountReader(
      `<body><script>${EMBEDDED_DOCUMENT_AGENT_SCRIPT}</script><p>Alpha beta.</p>${PAGE_HARNESS}</body>`,
    );
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await userEvent.tripleClick(reader.frame, { position: { x: 20, y: 16 } });
    await vi.waitFor(() => expect(readKeyEngineSnapshot().mode).toBe("VISUAL"));
    await userEvent.keyboard("y");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Alpha beta."));
  });

  it("reads again after the window loses and regains focus, in the mode it was in", async () => {
    await using reader = await mountReader();
    reader.frame.contentWindow!.postMessage({ test: "switch-away-and-back" }, "*");
    await vi.waitFor(() => expect(reader.starts()).toBe(2));
    await userEvent.keyboard("vE{Space}c");
    await vi.waitFor(() => expect(reader.quotes).toEqual([pageQuote("Report", "Quarterly")]));

    await userEvent.keyboard("i");
    await vi.waitFor(() => expect(readKeyEngineSnapshot().mode).toBe("INSERT"));
    reader.frame.contentWindow!.postMessage({ test: "switch-away-and-back" }, "*");
    await vi.waitFor(() => expect(reader.starts()).toBe(3));
    await vi.waitFor(() => expect(readKeyEngineSnapshot().mode).toBe("INSERT"));
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(reader.pageKeys()).toEqual(["x"]));
  });

  it("hands the keys to the page on i, takes them back on Escape, and exits on the next", async () => {
    await using reader = await mountReader();
    await userEvent.keyboard("i");
    await vi.waitFor(() => expect(readKeyEngineSnapshot().mode).toBe("INSERT"));
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(reader.pageKeys()).toEqual(["x"]));

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(readKeyEngineSnapshot().mode).toBe("NORMAL"));
    await userEvent.keyboard("j");
    expect(reader.pageKeys()).toEqual(["x", "Escape"]);

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(reader.messages).toContainEqual({ jsonrpc: "2.0", method: "t3/notifications/exit" }),
    );
  });

  it("appends a quote on a line of its own after a draft", () => {
    const inserted: string[] = [];
    for (const prompt of ["Draft", "Draft\n", ""]) {
      using _adapter = registerTestComposerAdapter({
        read: () => ({ prompt, cursor: 0 }),
        write: () => {},
        setCursor: () => {},
        editor: () => null,
        insertAtEnd: (markdown) => inserted.push(markdown) > 0,
      });
      appendBlockToComposer("> q\n");
    }
    expect(inserted).toEqual(["\n> q\n", "> q\n", "> q\n"]);
  });

  it("formats a quote with its page title, blank lines kept inside the quote", () => {
    expect(pageQuote(" Report ", "one\n\ntwo")).toBe('From the page "Report":\n> one\n>\n> two\n');
  });
});
