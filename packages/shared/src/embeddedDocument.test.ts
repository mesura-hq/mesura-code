import { describe, expect, it } from "vite-plus/test";
import { isEmbeddedDocumentExit } from "./embeddedDocument.ts";

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
