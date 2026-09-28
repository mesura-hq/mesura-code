/**
 * The page the Architecture diagram draws in. Android has no DOM for Mermaid,
 * so a WebView loads it from the CDN at the version the web app pins, renders
 * the source, and posts one message back: the drawn height, or why it could
 * not draw.
 */
export const MERMAID_VERSION = "11.12.0";
export const MERMAID_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
/** The page's origin: an https base lets it load the script above. */
export const MERMAID_PAGE_BASE_URL = "https://cdn.jsdelivr.net/";

export type MermaidPageMessage =
  | { readonly type: "height"; readonly height: number }
  /** Mermaid did not load: the device has no network, or the CDN is unreachable. */
  | { readonly type: "error"; readonly message?: string }
  /** Mermaid loaded but could not parse or draw the source. */
  | { readonly type: "render-error"; readonly message: string };

/**
 * JSON that is inert inside a `<script type="application/json">` element: no
 * character in it can close the element or start markup.
 */
function jsonForScriptElement(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

// Runs after the Mermaid script: a failed load leaves `mermaid` undefined.
// The WebView can lay out after the diagram draws, and at zero width the SVG is
// 0 px tall, so one measurement at render time reported only the padding and
// pinned the view at 16 px. The page reports the drawn height whenever it
// changes, and never before the SVG has a height of its own.
const RENDER_SCRIPT = `
(function () {
  var post = function (message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  var config = JSON.parse(document.getElementById("diagram-config").textContent);
  if (typeof window.mermaid === "undefined") {
    post({ type: "error", message: "Mermaid did not load" });
    return;
  }
  var host = document.getElementById("diagram");
  var reported = 0;
  var report = function () {
    var svg = host.querySelector("svg");
    if (!svg || svg.getBoundingClientRect().height <= 0) return;
    var height = Math.ceil(host.getBoundingClientRect().height);
    if (height === reported) return;
    reported = height;
    post({ type: "height", height: height });
  };
  window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: config.theme });
  window.mermaid
    .render("factory-diagram", config.source)
    .then(function (result) {
      host.innerHTML = result.svg;
      report();
      if (typeof window.ResizeObserver === "function") {
        new window.ResizeObserver(report).observe(host);
      }
      window.addEventListener("resize", report);
    })
    .catch(function (error) {
      post({ type: "render-error", message: String((error && error.message) || error) });
    });
})();
`;

export function buildMermaidPageHtml(input: {
  readonly source: string;
  readonly appearance: "light" | "dark";
}): string {
  const config = jsonForScriptElement({
    source: input.source,
    theme: input.appearance === "dark" ? "dark" : "default",
  });
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    "<style>html,body{margin:0;padding:0;background:transparent}",
    "#diagram{display:flow-root;padding:8px 0}#diagram svg{display:block;max-width:100%;height:auto;margin:0 auto}</style>",
    "</head><body>",
    '<div id="diagram"></div>',
    `<script type="application/json" id="diagram-config">${config}</script>`,
    `<script src="${MERMAID_SCRIPT_URL}"></script>`,
    `<script>${RENDER_SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

export function parseMermaidPageMessage(data: string): MermaidPageMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.type === "height") {
    const height = record.height;
    return typeof height === "number" && Number.isFinite(height) && height > 0
      ? { type: "height", height }
      : null;
  }
  if (record.type === "error") return { type: "error" };
  if (record.type === "render-error") {
    return { type: "render-error", message: String(record.message ?? "") };
  }
  return null;
}
