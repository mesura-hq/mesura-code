import { describe, expect, it } from "vite-plus/test";
import {
  EMBEDDED_READER_MAX_TEXT,
  isEmbeddedDocumentExit,
  readEmbeddedReaderMessage,
} from "./embeddedDocument.ts";

describe("isEmbeddedDocumentExit", () => {
  it("accepts only the payload-free exit notification", () => {
    const exit = { jsonrpc: "2.0", method: "t3/notifications/exit" };
    expect(isEmbeddedDocumentExit(exit)).toBe(true);
    for (const data of [
      null,
      "exit",
      {},
      { ...exit, params: {} },
      { ...exit, command: "thread.delete" },
      { ...exit, id: 1 },
      { ...exit, jsonrpc: "1.0" },
    ]) {
      expect(isEmbeddedDocumentExit(data)).toBe(false);
    }
  });
});

describe("readEmbeddedReaderMessage", () => {
  const message = (method: string, params?: unknown) => ({ jsonrpc: "2.0", method, params });

  it("reads each page message the reader knows", () => {
    expect(
      readEmbeddedReaderMessage(
        message("t3/reader/text", { revision: 2, text: "a\nb", firstVisible: 1 }),
      ),
    ).toEqual({ kind: "text", revision: 2, text: "a\nb", firstVisible: 1 });
    expect(
      readEmbeddedReaderMessage(
        message("t3/reader/key", { key: "E", code: "KeyE", shiftKey: true }),
      ),
    ).toEqual({ kind: "key", key: "E", code: "KeyE", shiftKey: true });
    expect(
      readEmbeddedReaderMessage(message("t3/reader/select", { revision: 1, anchor: 4, focus: 0 })),
    ).toEqual({ kind: "select", revision: 1, anchor: 4, focus: 0 });
    expect(readEmbeddedReaderMessage(message("t3/reader/ready"))).toEqual({ kind: "ready" });
  });

  it("rejects malformed, oversized and unknown messages from the page", () => {
    for (const data of [
      null,
      message("t3/reader/text", {
        revision: 1,
        text: "x".repeat(EMBEDDED_READER_MAX_TEXT + 1),
        firstVisible: 0,
      }),
      message("t3/reader/text", { revision: -1, text: "a", firstVisible: 0 }),
      message("t3/reader/key", { key: "x".repeat(33), code: "" }),
      message("t3/reader/key", { key: "", code: "" }),
      message("t3/reader/cursor", { revision: 1, top: Number.NaN, bottom: 2 }),
      message("t3/reader/select", { revision: 1, anchor: 1.5, focus: 2 }),
      message("t3/reader/state", { mode: "leave" }),
      message("t3/reader/mode", { mode: "read" }),
      { ...message("t3/reader/ready"), jsonrpc: "1.0" },
    ]) {
      expect(readEmbeddedReaderMessage(data)).toBeUndefined();
    }
  });
});
