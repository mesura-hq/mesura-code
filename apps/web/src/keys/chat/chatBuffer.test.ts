// @vitest-environment happy-dom
// Entry point: `buildChatBuffer` (`chatBuffer.ts`), which the chat surface
// calls on the timeline's `[data-assistant-citation-viewport]` before every
// key. The markup mirrors what the timeline renders: one
// `[data-timeline-row-id]` per row, a screen-reader-only author heading, and
// an assistant row whose prose sits in `[data-assistant-citation-source]`.
// happy-dom has no layout, so every row reports the same top and the buffer
// keeps document order.
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildChatBuffer, fromRowPosition, toRowPosition } from "./chatBuffer";

function mountTimeline(rows: string): HTMLElement {
  document.body.innerHTML = `<div data-assistant-citation-viewport>${rows}</div>`;
  return document.querySelector<HTMLElement>("[data-assistant-citation-viewport]")!;
}

const USER_ROW = `
  <div data-timeline-row-id="user-1">
    <h2 class="sr-only">You</h2>
    <p>Fix the build</p>
  </div>`;

const ASSISTANT_ROW = `
  <div data-timeline-row-id="assistant-1">
    <span class="sr-only">T3 Code</span>
    <button>Copy</button>
    <div data-assistant-citation-source="assistant-1">
      <p>First paragraph</p>

      <p>Second paragraph</p>
      <ul>
        <li>one item</li>
      </ul>
    </div>
  </div>`;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("buildChatBuffer projection", () => {
  it("drops sr-only and blank lines and keeps one separator line between rows", () => {
    const buffer = buildChatBuffer(mountTimeline(USER_ROW + ASSISTANT_ROW));

    expect(buffer.lines).toEqual([
      "Fix the build",
      "",
      "First paragraph",
      "Second paragraph",
      "one item",
    ]);
    expect(buffer.lineRow).toEqual([0, -1, 1, 1, 1]);
    expect(buffer.rows.map((row) => [row.id, row.firstLine])).toEqual([
      ["user-1", 0],
      ["assistant-1", 2],
    ]);
  });

  it("reads an assistant row from its citation source only", () => {
    const buffer = buildChatBuffer(mountTimeline(ASSISTANT_ROW));
    expect(buffer.lines.join("\n")).not.toContain("Copy");
    expect(buffer.lines.join("\n")).not.toContain("T3 Code");
  });

  it("keeps a line that mixes screen-reader text with visible text", () => {
    const buffer = buildChatBuffer(
      mountTimeline(
        '<div data-timeline-row-id="mixed"><p><span class="sr-only">Note:</span> visible words</p></div>',
      ),
    );
    expect(buffer.lines).toEqual(["Note: visible words"]);
  });

  it("skips a row with no visible text without adding a separator", () => {
    const buffer = buildChatBuffer(
      mountTimeline(
        `${USER_ROW}
        <div data-timeline-row-id="empty"><h2 class="sr-only">Working</h2>   </div>
        <div data-timeline-row-id="user-2"><p>Thanks</p></div>`,
      ),
    );
    expect(buffer.lines).toEqual(["Fix the build", "", "Thanks"]);
    expect(buffer.rows.map((row) => row.id)).toEqual(["user-1", "user-2"]);
  });
});

describe("chat buffer row positions", () => {
  it("round-trips a buffer position through a row position", () => {
    const buffer = buildChatBuffer(mountTimeline(USER_ROW + ASSISTANT_ROW));
    const position = { line: 3, col: 7 };

    const rowPosition = toRowPosition(buffer, position);
    expect(rowPosition?.rowId).toBe("assistant-1");
    const row = buffer.rows[1]!;
    expect(row.text.slice(rowPosition!.offset, rowPosition!.offset + 9)).toBe("paragraph");

    expect(fromRowPosition(buffer, rowPosition!)).toEqual(position);
  });

  it("maps a separator line to the start of the row after it", () => {
    const buffer = buildChatBuffer(mountTimeline(USER_ROW + ASSISTANT_ROW));
    expect(toRowPosition(buffer, { line: 1, col: 0 })).toEqual({
      rowId: "assistant-1",
      offset: 0,
    });
  });

  it("finds no buffer position for a row that is no longer mounted", () => {
    const buffer = buildChatBuffer(mountTimeline(USER_ROW));
    expect(fromRowPosition(buffer, { rowId: "gone", offset: 0 })).toBeNull();
  });
});
