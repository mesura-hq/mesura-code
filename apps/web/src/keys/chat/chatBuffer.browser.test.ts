// The markup mirrors what the timeline renders: one `[data-timeline-row-id]` per
// row, a screen-reader-only author heading, and an assistant row whose prose
// sits in `[data-assistant-citation-source]`. Chromium supplies real layout.
import { describe, expect, it } from "vite-plus/test";

import { mountKeyDom } from "~/test/keyBrowserFixtures";

import {
  SEPARATOR_OFFSET,
  buildChatBuffer,
  fromRowPosition,
  rangeBetween,
  toRowPosition,
} from "./chatBuffer";

function mountTimeline(rows: string) {
  const fixture = mountKeyDom(`<div data-assistant-citation-viewport>${rows}</div>`);
  return {
    ...fixture,
    viewport: fixture.container.querySelector<HTMLElement>("[data-assistant-citation-viewport]")!,
  };
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

describe("buildChatBuffer projection", () => {
  it("drops sr-only and blank lines and keeps one separator line between rows", () => {
    using timeline = mountTimeline(USER_ROW + ASSISTANT_ROW);
    const buffer = buildChatBuffer(timeline.viewport);

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
    using timeline = mountTimeline(ASSISTANT_ROW);
    const buffer = buildChatBuffer(timeline.viewport);
    expect(buffer.lines.join("\n")).not.toContain("Copy");
    expect(buffer.lines.join("\n")).not.toContain("T3 Code");
  });

  it("keeps a line that mixes screen-reader text with visible text", () => {
    using timeline = mountTimeline(
      '<div data-timeline-row-id="mixed"><p><span class="sr-only">Note:</span> visible words</p></div>',
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(buffer.lines).toEqual(["Note: visible words"]);
  });

  it("skips a row with no visible text without adding a separator", () => {
    using timeline = mountTimeline(
      `${USER_ROW}
        <div data-timeline-row-id="empty"><h2 class="sr-only">Working</h2>   </div>
        <div data-timeline-row-id="user-2"><p>Thanks</p></div>`,
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(buffer.lines).toEqual(["Fix the build", "", "Thanks"]);
    expect(buffer.rows.map((row) => row.id)).toEqual(["user-1", "user-2"]);
  });
});

describe("chat buffer row positions", () => {
  it("round-trips a buffer position through a row position", () => {
    using timeline = mountTimeline(USER_ROW + ASSISTANT_ROW);
    const buffer = buildChatBuffer(timeline.viewport);
    const position = { line: 3, col: 7 };

    const rowPosition = toRowPosition(buffer, position);
    expect(rowPosition?.rowId).toBe("assistant-1");
    const row = buffer.rows[1]!;
    expect(row.text.slice(rowPosition!.offset, rowPosition!.offset + 9)).toBe("paragraph");

    expect(fromRowPosition(buffer, rowPosition!)).toEqual(position);
  });

  it("maps a separator line to the separator before the row after it, and back", () => {
    using timeline = mountTimeline(USER_ROW + ASSISTANT_ROW);
    const buffer = buildChatBuffer(timeline.viewport);
    const rowPosition = toRowPosition(buffer, { line: 1, col: 0 });
    expect(rowPosition).toEqual({ rowId: "assistant-1", offset: SEPARATOR_OFFSET });
    // Back on the separator, not on the row's first line: from there `k`
    // reaches the row before (review P1-2).
    expect(fromRowPosition(buffer, rowPosition!)).toEqual({ line: 1, col: 0 });
  });

  it("resolves a separator position to the row's start when the row before is gone", () => {
    using timeline = mountTimeline(ASSISTANT_ROW);
    const buffer = buildChatBuffer(timeline.viewport);
    expect(fromRowPosition(buffer, { rowId: "assistant-1", offset: SEPARATOR_OFFSET })).toEqual({
      line: 0,
      col: 0,
    });
  });

  it("finds no buffer position for a row that is no longer mounted", () => {
    using timeline = mountTimeline(USER_ROW);
    const buffer = buildChatBuffer(timeline.viewport);
    expect(fromRowPosition(buffer, { rowId: "gone", offset: 0 })).toBeNull();
  });
});

// Soft breaks use Chromium's actual user-agent styles and computed inheritance.
describe("chat buffer soft breaks", () => {
  function whiteSpaceOf(selector: string): string {
    return getComputedStyle(document.querySelector(selector)!).whiteSpace;
  }

  function assistantRow(id: string, prose: string): string {
    return `<div data-timeline-row-id="${id}"><div data-assistant-citation-source="${id}">${prose}</div></div>`;
  }

  it("soft break spec: a paragraph whose source has a single newline is one buffer line", () => {
    using timeline = mountTimeline(
      assistantRow(
        "soft",
        "<p>Line one of the paragraph\nline two of it.</p><p>The next block.</p>",
      ),
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(whiteSpaceOf("p")).toBe("normal");

    expect(buffer.lines).toEqual(["Line one of the paragraph line two of it.", "The next block."]);
    // `j` from the paragraph steps to the line after it: the next block.
    expect(buffer.lineRow).toEqual([0, 0]);
  });

  it("soft break spec: a newline inside inline markup in a paragraph reads as a space", () => {
    using timeline = mountTimeline(
      assistantRow(
        "inline",
        "<p>Use <strong>the bold\nwords</strong> and <code>a()</code>\nthen stop.</p>",
      ),
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(whiteSpaceOf("strong")).toBe("normal");

    expect(buffer.lines).toEqual(["Use the bold words and a() then stop."]);
  });

  it("soft break spec: nowrap collapses newlines like normal", () => {
    using timeline = mountTimeline(
      assistantRow("nowrap", '<p style="white-space: nowrap">left half\nright half</p>'),
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(whiteSpaceOf("p")).toBe("nowrap");

    expect(buffer.lines).toEqual(["left half right half"]);
  });

  it("soft break spec: offsets across a former soft break round-trip through a row position", () => {
    using timeline = mountTimeline(
      assistantRow("offsets", "<p>alpha beta\ngamma delta</p><p>after</p>"),
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(buffer.lines[0]).toBe("alpha beta gamma delta");

    // `gamma`, after the former break, on the same buffer line.
    const position = { line: 0, col: 11 };
    const rowPosition = toRowPosition(buffer, position);
    expect(rowPosition).toEqual({ rowId: "offsets", offset: 11 });
    expect(fromRowPosition(buffer, rowPosition!)).toEqual(position);
  });

  it("soft break spec: a range across a former soft break covers exactly the rendered characters", () => {
    using timeline = mountTimeline(assistantRow("range", "<p>alpha beta\ngamma delta</p>"));
    const buffer = buildChatBuffer(timeline.viewport);
    expect(buffer.lines).toEqual(["alpha beta gamma delta"]);

    // From `beta` through `gamma`: the visual selection `v` + `e e` paints.
    const range = rangeBetween(buffer, { line: 0, col: 6 }, { line: 0, col: 16 });
    expect(range).not.toBeNull();
    const textNode = document.querySelector("p")!.firstChild;
    expect(range!.startContainer).toBe(textNode);
    expect(range!.startOffset).toBe(6);
    expect(range!.endContainer).toBe(textNode);
    expect(range!.endOffset).toBe(16);
    // The DOM keeps its newline; the buffer shows the space it renders as.
    expect(range!.toString()).toBe("beta\ngamma");
    expect(buffer.lines[0]!.slice(6, 16)).toBe("beta gamma");
  });

  it("soft break guard: text in pre and code blocks still splits at each newline", () => {
    using timeline = mountTimeline(
      assistantRow("code", "<pre><code>const a = 1;\nconst b = 2;</code></pre>"),
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(whiteSpaceOf("pre")).toBe("pre");
    // The newline's text node sits in `code`, which inherits `pre`.
    expect(whiteSpaceOf("code")).toBe("pre");

    expect(buffer.lines).toEqual(["const a = 1;", "const b = 2;"]);
  });

  it.each(["pre", "pre-wrap", "pre-line", "break-spaces"])(
    "soft break guard: an inline white-space %s keeps its newlines",
    (whiteSpace) => {
      using timeline = mountTimeline(
        assistantRow(
          whiteSpace,
          `<p><span style="white-space: ${whiteSpace}">first line\nsecond line</span></p>`,
        ),
      );
      const buffer = buildChatBuffer(timeline.viewport);
      expect(whiteSpaceOf("span")).toBe(whiteSpace);

      expect(buffer.lines).toEqual(["first line", "second line"]);
    },
  );

  it("soft break guard: a stylesheet class with white-space pre-wrap keeps a user message's newlines", () => {
    const style = document.createElement("style");
    style.textContent = ".whitespace-pre-wrap { white-space: pre-wrap; }";
    using timeline = mountTimeline(
      '<div data-timeline-row-id="user-multiline"><div class="whitespace-pre-wrap">first request\nsecond request</div></div>',
    );
    document.head.append(style);
    try {
      expect(whiteSpaceOf(".whitespace-pre-wrap")).toBe("pre-wrap");

      expect(buildChatBuffer(timeline.viewport).lines).toEqual(["first request", "second request"]);
    } finally {
      style.remove();
    }
  });

  // Review P2-1: `\s` matches U+00A0, which the browser renders.
  it("soft break regression: a leading no-break space stays in the buffer line", () => {
    using timeline = mountTimeline(
      assistantRow("nbsp", "<p>&nbsp;indented by a no-break space</p>"),
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(whiteSpaceOf("p")).toBe("normal");

    expect(buffer.lines).toEqual(["\u00a0indented by a no-break space"]);
    const range = rangeBetween(buffer, { line: 0, col: 0 }, { line: 0, col: 1 });
    expect(range!.startOffset).toBe(0);
    expect(range!.toString()).toBe("\u00a0");
  });

  it("soft break guard: a hard break from remark-breaks still splits and adds no leading space", () => {
    // remark-breaks renders a Markdown newline as `<br>` followed by a "\n"
    // text node; the browser collapses that newline away at the line start.
    using timeline = mountTimeline(
      assistantRow("hard", "<p>★ Insight first<br>\nsecond after the break</p>"),
    );
    const buffer = buildChatBuffer(timeline.viewport);
    expect(whiteSpaceOf("p")).toBe("normal");

    expect(buffer.lines).toEqual(["★ Insight first", "second after the break"]);
    // The line's first character is the rendered `s`, not the collapsed newline.
    const range = rangeBetween(buffer, { line: 1, col: 0 }, { line: 1, col: 1 });
    expect(range!.toString()).toBe("s");
  });
});
