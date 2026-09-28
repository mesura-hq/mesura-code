// Entry point: the page `buildMermaidPageHtml` hands the WebView, its render
// script run against a stand-in DOM and Mermaid. Only the emulator shows the
// real Chromium layout and the CDN load; this pins what the page reports.
import { describe, expect, it } from "vite-plus/test";

import { buildMermaidPageHtml } from "./mermaidPage";

function renderScriptOf(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const script = scripts.at(-1)?.[1];
  expect(script, "Expected the page's inline render script").toBeDefined();
  return script!;
}

function runPage(options: { readonly mermaidLoaded: boolean }) {
  const html = buildMermaidPageHtml({ source: "flowchart LR\n  A --> B", appearance: "dark" });
  const config = /<script type="application\/json" id="diagram-config">([\s\S]*?)<\/script>/.exec(
    html,
  )![1]!;
  const posted: unknown[] = [];
  const layout = { host: 16, svg: 0 };
  let observed: (() => void) | null = null;
  let rendered: Promise<void> = Promise.resolve();
  const host = {
    innerHTML: "",
    querySelector: (selector: string) =>
      selector === "svg" && host.innerHTML !== ""
        ? { getBoundingClientRect: () => ({ height: layout.svg }) }
        : null,
    getBoundingClientRect: () => ({ height: layout.host }),
  };
  const document = {
    getElementById: (id: string) => (id === "diagram-config" ? { textContent: config } : host),
  };
  const window = {
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
    ResizeObserver: class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe() {}
    },
    addEventListener: () => undefined,
    mermaid: options.mermaidLoaded
      ? {
          initialize: () => undefined,
          render: () => {
            const result = Promise.resolve({ svg: "<svg></svg>" });
            rendered = result.then(() => Promise.resolve());
            return result;
          },
        }
      : undefined,
  };
  new Function("window", "document", renderScriptOf(html))(window, document);
  return {
    posted,
    layout,
    settled: () => rendered.then(() => Promise.resolve()),
    resize: () => observed?.(),
  };
}

describe("the Mermaid page's height report", () => {
  it("reports no height while the drawn SVG has none, then the drawn height once layout gives it one", async () => {
    const page = runPage({ mermaidLoaded: true });
    await page.settled();
    // The WebView has not laid out: the host is only its padding.
    expect(page.posted).toEqual([]);

    page.layout.svg = 231;
    page.layout.host = 247;
    page.resize();
    page.resize();
    expect(page.posted).toEqual([{ type: "height", height: 247 }]);

    page.layout.svg = 300;
    page.layout.host = 316;
    page.resize();
    expect(page.posted).toEqual([
      { type: "height", height: 247 },
      { type: "height", height: 316 },
    ]);
  });

  it("reports a load failure when Mermaid did not arrive from the network", () => {
    const page = runPage({ mermaidLoaded: false });
    expect(page.posted).toEqual([{ type: "error", message: "Mermaid did not load" }]);
  });
});
