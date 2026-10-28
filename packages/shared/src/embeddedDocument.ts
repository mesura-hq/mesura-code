/**
 * The protocol between the app and a sandboxed page it embeds (HTML renders, MCP apps): the exit
 * notification, and the Vim reader. The page holds the text and paints; the app runs Vim on the
 * text, so a page cannot reach any command but its own reader's.
 */
export const EMBEDDED_DOCUMENT_METHODS = {
  exit: "t3/notifications/exit",
  /** App → page: the reader takes the keys (`read`), hands them to the page, or lets go. */
  readerMode: "t3/reader/mode",
  /** App → page: the cursor and the visual span, as offsets into the page's text. */
  readerPaint: "t3/reader/paint",
  /** App → page: focus the control under an offset and hand the keys to the page. */
  readerActivate: "t3/reader/activate",
  /** Page → app: the readable text, on start and after every change. */
  readerText: "t3/reader/text",
  readerKey: "t3/reader/key",
  /** Page → app: where the painted cursor is, in the page's viewport. */
  readerCursor: "t3/reader/cursor",
  /** Page → app: a mouse selection or click, as offsets. */
  readerSelect: "t3/reader/select",
  /** Page → app: the page changed the reader's mode (an unhandled Escape, an activated control). */
  readerState: "t3/reader/state",
  /** Page → app: a focused page loaded, and has no reader until the app starts one. */
  readerReady: "t3/reader/ready",
} as const;

/** The most text a page reports; a longer page is read up to here. */
export const EMBEDDED_READER_MAX_TEXT = 200_000;
const MAX_KEY_LENGTH = 32;

export function isEmbeddedDocumentExit(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  return (
    message.jsonrpc === "2.0" &&
    message.method === EMBEDDED_DOCUMENT_METHODS.exit &&
    Object.keys(message).every((key) => key === "jsonrpc" || key === "method")
  );
}

export type EmbeddedReaderMode = "off" | "read" | "interact";

export type EmbeddedReaderMessage =
  | {
      readonly kind: "text";
      readonly revision: number;
      readonly text: string;
      readonly firstVisible: number;
    }
  | {
      readonly kind: "key";
      readonly key: string;
      readonly code: string;
      readonly shiftKey: boolean;
    }
  | {
      readonly kind: "cursor";
      readonly revision: number;
      readonly top: number;
      readonly bottom: number;
    }
  | {
      readonly kind: "select";
      readonly revision: number;
      readonly anchor: number;
      readonly focus: number;
    }
  | { readonly kind: "state"; readonly mode: "read" | "interact"; readonly activated: boolean }
  | { readonly kind: "ready" };

const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1e9;
const isCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;

/** A page's reader message, checked field by field: the page is untrusted code. */
export function readEmbeddedReaderMessage(data: unknown): EmbeddedReaderMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0") return undefined;
  if (method === EMBEDDED_DOCUMENT_METHODS.readerReady) return { kind: "ready" };
  if (typeof params !== "object" || params === null) return undefined;
  const p = params as Record<string, unknown>;
  switch (method) {
    case EMBEDDED_DOCUMENT_METHODS.readerText:
      return isOffset(p.revision) &&
        typeof p.text === "string" &&
        p.text.length <= EMBEDDED_READER_MAX_TEXT &&
        isOffset(p.firstVisible)
        ? { kind: "text", revision: p.revision, text: p.text, firstVisible: p.firstVisible }
        : undefined;
    case EMBEDDED_DOCUMENT_METHODS.readerKey:
      return typeof p.key === "string" &&
        p.key.length > 0 &&
        p.key.length <= MAX_KEY_LENGTH &&
        typeof p.code === "string" &&
        p.code.length <= MAX_KEY_LENGTH
        ? { kind: "key", key: p.key, code: p.code, shiftKey: p.shiftKey === true }
        : undefined;
    case EMBEDDED_DOCUMENT_METHODS.readerCursor:
      return isOffset(p.revision) && isCoordinate(p.top) && isCoordinate(p.bottom)
        ? { kind: "cursor", revision: p.revision, top: p.top, bottom: p.bottom }
        : undefined;
    case EMBEDDED_DOCUMENT_METHODS.readerSelect:
      return isOffset(p.revision) && isOffset(p.anchor) && isOffset(p.focus)
        ? { kind: "select", revision: p.revision, anchor: p.anchor, focus: p.focus }
        : undefined;
    case EMBEDDED_DOCUMENT_METHODS.readerState:
      return p.mode === "read" || p.mode === "interact"
        ? { kind: "state", mode: p.mode, activated: p.activated === true }
        : undefined;
    default:
      return undefined;
  }
}

/** `leave` asks the page to post the exit notification, so the frame's own exit path runs. */
export function embeddedReaderModeMessage(mode: EmbeddedReaderMode | "leave", visibleTop = 0) {
  return {
    jsonrpc: "2.0",
    method: EMBEDDED_DOCUMENT_METHODS.readerMode,
    params: { mode, visibleTop },
  } as const;
}

export function embeddedReaderPaintMessage(paint: {
  readonly revision: number;
  readonly cursor: number;
  /** The visual span, end exclusive. */
  readonly visual: readonly [from: number, to: number] | null;
  readonly reveal: boolean;
}) {
  return { jsonrpc: "2.0", method: EMBEDDED_DOCUMENT_METHODS.readerPaint, params: paint } as const;
}

export function embeddedReaderActivateMessage(revision: number, offset: number) {
  return {
    jsonrpc: "2.0",
    method: EMBEDDED_DOCUMENT_METHODS.readerActivate,
    params: { revision, offset },
  } as const;
}

/**
 * Runs inside the page, serialized into its bootstrap, so it reads nothing from this module's
 * scope: every constant arrives as an argument.
 *
 * Exit: Shift+Escape exits at capture time, before any page handler can stop it. Plain Escape
 * waits for the page's own handlers, which may use it; a stranded listener goes on the next key.
 *
 * Reader: off until the app starts it. Reading, the page's keys go to the app and the page's own
 * handlers never see them, except in a text field, which keeps its keys. Interacting, the page
 * has every key; an unhandled Escape returns to reading.
 */
function embeddedDocumentAgent(methods: typeof EMBEDDED_DOCUMENT_METHODS, maxText: number): void {
  const flags = window as unknown as Record<string, unknown>;
  if (window.parent === window || flags.__mesuraDocumentAgent2) return;
  flags.__mesuraDocumentAgent2 = true;
  const post = (method: string, params?: object) =>
    window.parent.postMessage(
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
      "*",
    );

  let mode: "off" | "read" | "interact" = "off";
  let revision = 0;
  let text = "";
  /** Per character of `text`: its text node and offset there; null for an inserted break. */
  let charNodes: (Text | null)[] = [];
  let charOffsets: number[] = [];
  let nodeIndexes = new Map<Text, number[]>();
  let lineStarts: number[] = [0];
  let observer: MutationObserver | null = null;
  let reprojectTimer: ReturnType<typeof setTimeout> | undefined;
  let sheetInstalled = false;

  const SKIPPED = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "head",
    "title",
    "iframe",
    "textarea",
    "select",
    "object",
    "canvas",
  ]);
  const INTERACTIVE =
    'a[href],button,summary,label,input,select,textarea,[role="button"],[role="tab"],[role="link"],[role="checkbox"],[tabindex]:not([tabindex="-1"])';

  function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    return (
      target instanceof HTMLInputElement &&
      ![
        "button",
        "submit",
        "reset",
        "checkbox",
        "radio",
        "range",
        "color",
        "file",
        "image",
      ].includes(target.type)
    );
  }

  function project(): void {
    const chars: string[] = [];
    const nodes: (Text | null)[] = [];
    const offsets: number[] = [];
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (element: Element) => {
      let style = styles.get(element);
      if (!style) {
        style = getComputedStyle(element);
        styles.set(element, style);
      }
      return style;
    };
    const last = () => chars[chars.length - 1];
    const push = (character: string, node: Text | null, offset: number) => {
      chars.push(character);
      nodes.push(node);
      offsets.push(offset);
    };
    const trimSpace = () => {
      while (last() === " ") {
        chars.pop();
        nodes.pop();
        offsets.pop();
      }
    };
    const separate = (separator: "\n" | "\t") => {
      trimSpace();
      if (chars.length === 0 || last() === "\n") return;
      if (separator === "\t" && last() === "\t") return;
      push(separator, null, 0);
    };
    const addText = (node: Text, parent: Element) => {
      const style = styleOf(parent);
      if (style.visibility !== "visible") return;
      const preserve = /^(pre|pre-wrap|break-spaces|pre-line)$/.test(style.whiteSpace);
      const data = node.data;
      for (let index = 0; index < data.length && chars.length < maxText; index += 1) {
        const character = data[index]!;
        if (preserve && character === "\n") push("\n", node, index);
        else if (/\s/.test(character)) {
          if (preserve && character !== "\r") push(character === "\t" ? "\t" : " ", node, index);
          else if (chars.length > 0 && !/\s/.test(last()!)) push(" ", node, index);
        } else push(character, node, index);
      }
    };
    const walk = (element: Element) => {
      for (const child of element.childNodes) {
        if (chars.length >= maxText) return;
        if (child instanceof Text) {
          addText(child, element);
          continue;
        }
        if (!(child instanceof Element) || SKIPPED.has(child.localName)) continue;
        if (child.localName === "br") {
          separate("\n");
          continue;
        }
        const style = styleOf(child);
        if (style.display === "none" || style.contentVisibility === "hidden") continue;
        if (
          element instanceof HTMLDetailsElement &&
          !element.open &&
          child.localName !== "summary"
        ) {
          continue;
        }
        const display = style.display;
        const block = !display.startsWith("inline") && display !== "contents";
        if (display === "table-cell") separate("\t");
        else if (block) separate("\n");
        walk(child);
        if (block && display !== "table-cell") separate("\n");
      }
    };
    if (document.body) walk(document.body);
    while (last() === "\n" || last() === " " || last() === "\t") {
      chars.pop();
      nodes.pop();
      offsets.pop();
    }
    text = chars.join("");
    charNodes = nodes;
    charOffsets = offsets;
    nodeIndexes = new Map();
    lineStarts = [0];
    nodes.forEach((node, index) => {
      if (node) {
        const indexes = nodeIndexes.get(node);
        if (indexes) indexes.push(index);
        else nodeIndexes.set(node, [index]);
      }
      if (chars[index] === "\n") lineStarts.push(index + 1);
    });
  }

  /** The DOM range over `[from, to)`, from the nearest real characters inside it. */
  function rangeOf(from: number, to: number): Range | null {
    let start = from;
    while (start < to && charNodes[start] == null) start += 1;
    let end = to - 1;
    while (end >= start && charNodes[end] == null) end -= 1;
    if (start > end) return null;
    try {
      const range = document.createRange();
      range.setStart(charNodes[start]!, charOffsets[start]!);
      range.setEnd(charNodes[end]!, charOffsets[end]! + 1);
      return range;
    } catch {
      return null;
    }
  }

  /** The offset of a DOM point: the first character at or after it. */
  function offsetOf(node: Node, offset: number): number | null {
    let target: Node | null = node;
    let at = offset;
    if (!(node instanceof Text)) {
      target = node.childNodes[offset] ?? null;
      at = 0;
      if (target === null) {
        target = node;
        while (target && !target.nextSibling) target = target.parentNode;
        target = target?.nextSibling ?? null;
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    if (target && !(target instanceof Text)) {
      walker.currentNode = target;
      target = walker.nextNode();
      at = 0;
    }
    while (target) {
      const indexes = nodeIndexes.get(target as Text);
      if (indexes) {
        const found = indexes.find((index) => charOffsets[index]! >= at);
        if (found !== undefined) return found;
      }
      walker.currentNode = target;
      target = walker.nextNode();
      at = 0;
    }
    return null;
  }

  function firstVisibleOffset(visibleTop: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      const start = lineStarts[middle]!;
      const rect = rangeOf(start, start + 1)?.getBoundingClientRect();
      if (rect && rect.bottom > visibleTop) high = middle;
      else low = middle + 1;
    }
    return lineStarts[low] ?? 0;
  }

  function sendText(visibleTop: number): void {
    project();
    revision += 1;
    post(methods.readerText, { revision, text, firstVisible: firstVisibleOffset(visibleTop) });
  }

  function clearPaint(): void {
    CSS.highlights?.delete("mesura-reader-cursor");
    CSS.highlights?.delete("mesura-reader-visual");
  }

  function installSheet(): void {
    if (sheetInstalled) return;
    sheetInstalled = true;
    // The chat cursor's and the composer's visual colours (`apps/web/src/mesura.css`).
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "::highlight(mesura-reader-cursor){background-color:oklch(68.5% 0.169 237.323);color:var(--background,Canvas)}" +
        "::highlight(mesura-reader-visual){background-color:color-mix(in oklab,oklch(76.9% 0.188 70.08) 35%,transparent)}",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }

  function setMode(next: typeof mode, visibleTop = 0): void {
    mode = next;
    if (mode === "off") {
      clearPaint();
      observer?.disconnect();
      observer = null;
      return;
    }
    if (mode === "interact") {
      clearPaint();
      return;
    }
    installSheet();
    sendText(visibleTop);
    if (observer) return;
    observer = new MutationObserver(() => {
      if (reprojectTimer !== undefined) return;
      // @effect-diagnostics-next-line globalTimers:off - runs in the embedded page, which has no Effect runtime
      reprojectTimer = setTimeout(() => {
        reprojectTimer = undefined;
        const before = text;
        project();
        if (mode === "read" && text !== before) {
          revision += 1;
          post(methods.readerText, { revision, text, firstVisible: 0 });
        }
      }, 150);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open"],
    });
  }

  function paint(params: Record<string, unknown>): void {
    if (mode !== "read" || params.revision !== revision) return;
    const cursor = typeof params.cursor === "number" ? params.cursor : 0;
    const visual = Array.isArray(params.visual) ? params.visual : null;
    clearPaint();
    const cursorRange = rangeOf(cursor, cursor + 1);
    if (cursorRange && typeof Highlight === "function") {
      CSS.highlights.set("mesura-reader-cursor", new Highlight(cursorRange));
    }
    const visualRange =
      visual && typeof visual[0] === "number" && typeof visual[1] === "number"
        ? rangeOf(visual[0], visual[1])
        : null;
    if (visualRange && typeof Highlight === "function") {
      window.getSelection()?.removeAllRanges();
      CSS.highlights.set("mesura-reader-visual", new Highlight(visualRange));
    }
    if (params.reveal !== true || !cursorRange) return;
    let rect = cursorRange.getBoundingClientRect();
    const margin = Math.min(48, window.innerHeight / 4);
    if (rect.top < margin) window.scrollBy(0, rect.top - margin);
    else if (rect.bottom > window.innerHeight - margin)
      window.scrollBy(0, rect.bottom - window.innerHeight + margin);
    rect = cursorRange.getBoundingClientRect();
    post(methods.readerCursor, { revision, top: rect.top, bottom: rect.bottom });
  }

  function activate(params: Record<string, unknown>): void {
    if (mode !== "read" || params.revision !== revision || typeof params.offset !== "number")
      return;
    const node = charNodes[params.offset];
    const control = node?.parentElement?.closest<HTMLElement>(INTERACTIVE);
    if (control) {
      setMode("interact");
      control.focus();
    }
    post(methods.readerState, { mode, activated: control != null });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.jsonrpc !== "2.0" || typeof data.params !== "object" || !data.params) return;
    const params = data.params as Record<string, unknown>;
    if (data.method === methods.readerMode) {
      if (params.mode === "leave") post(methods.exit);
      else if (params.mode === "off" || params.mode === "read" || params.mode === "interact") {
        setMode(params.mode, typeof params.visibleTop === "number" ? params.visibleTop : 0);
        if (params.mode === "interact") post(methods.readerState, { mode, activated: false });
      }
    } else if (data.method === methods.readerPaint) paint(params);
    else if (data.method === methods.readerActivate) activate(params);
  });
  window.addEventListener("blur", () => setMode("off"));
  window.addEventListener(
    "pointerup",
    (event) => {
      if (mode !== "read" || !event.isTrusted || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.anchorNode) return;
      if (selection.isCollapsed && target?.closest(INTERACTIVE)) return;
      const anchor = offsetOf(selection.anchorNode, selection.anchorOffset);
      const focus = selection.focusNode
        ? offsetOf(selection.focusNode, selection.focusOffset)
        : null;
      if (anchor === null || focus === null) return;
      post(methods.readerSelect, { revision, anchor, focus });
    },
    true,
  );

  let pending: ((event: KeyboardEvent) => void) | undefined;
  window.addEventListener(
    "keydown",
    (event) => {
      if (pending) window.removeEventListener("keydown", pending);
      pending = undefined;
      if (event.key === "Escape" && event.shiftKey) {
        event.preventDefault();
        post(methods.exit);
        return;
      }
      const target = event.composedPath()[0] ?? null;
      if (mode === "read" && !isEditable(target)) {
        if (!event.isTrusted || event.isComposing || event.key === "Tab") return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          /^(Shift|Control|Alt|AltGraph|Meta|CapsLock|Dead|Unidentified|Process)$/.test(event.key)
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        post(methods.readerKey, { key: event.key, code: event.code, shiftKey: event.shiftKey });
        return;
      }
      if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey) return;
      const finish = (received: KeyboardEvent) => {
        window.removeEventListener("keydown", finish);
        pending = undefined;
        if (received !== event || event.defaultPrevented) return;
        event.preventDefault();
        if (mode === "read") (target as HTMLElement | null)?.blur?.();
        else if (mode === "interact") {
          (document.activeElement as HTMLElement | null)?.blur?.();
          setMode("read");
          post(methods.readerState, { mode, activated: false });
        } else post(methods.exit);
      };
      pending = finish;
      window.addEventListener("keydown", finish);
    },
    true,
  );
  if (document.hasFocus()) post(methods.readerReady);
}

export const EMBEDDED_DOCUMENT_AGENT_SCRIPT = `(${embeddedDocumentAgent.toString()})(${JSON.stringify(
  EMBEDDED_DOCUMENT_METHODS,
)}, ${EMBEDDED_READER_MAX_TEXT});`;
