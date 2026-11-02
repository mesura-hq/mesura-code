import { EMBEDDED_DOCUMENT_AGENT_SOURCE } from "./embeddedDocumentAgentSource.ts";

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
 * The page agent: `embeddedDocumentAgent.ts`, typed against the DOM, which the server's program
 * has no types for, so it reaches the server as the generated `EMBEDDED_DOCUMENT_AGENT_SOURCE`.
 */
export const EMBEDDED_DOCUMENT_AGENT_SCRIPT = `(${EMBEDDED_DOCUMENT_AGENT_SOURCE})(${JSON.stringify(
  EMBEDDED_DOCUMENT_METHODS,
)}, ${EMBEDDED_READER_MAX_TEXT});`;
