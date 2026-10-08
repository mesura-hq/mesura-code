// @vitest-environment happy-dom
// Entry point: `buildChatBuffer` (`chatBuffer.ts`), which the chat surface
// calls on the timeline's `[data-assistant-citation-viewport]` before every
// key. The markup mirrors what the timeline renders: one
// `[data-timeline-row-id]` per row, a screen-reader-only author heading, and
// an assistant row whose prose sits in `[data-assistant-citation-source]`.
// happy-dom has no layout, so every row reports the same top and the buffer
// keeps document order.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  SEPARATOR_OFFSET,
  buildChatBuffer,
  fromRowPosition,
  rangeBetween,
  toRowPosition,
} from "./chatBuffer";

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

  it("maps a separator line to the separator before the row after it, and back", () => {
    const buffer = buildChatBuffer(mountTimeline(USER_ROW + ASSISTANT_ROW));
    const rowPosition = toRowPosition(buffer, { line: 1, col: 0 });
    expect(rowPosition).toEqual({ rowId: "assistant-1", offset: SEPARATOR_OFFSET });
    // Back on the separator, not on the row's first line: from there `k`
    // reaches the row before (review P1-2).
    expect(fromRowPosition(buffer, rowPosition!)).toEqual({ line: 1, col: 0 });
  });

  it("resolves a separator position to the row's start when the row before is gone", () => {
    const buffer = buildChatBuffer(mountTimeline(ASSISTANT_ROW));
    expect(fromRowPosition(buffer, { rowId: "assistant-1", offset: SEPARATOR_OFFSET })).toEqual({
      line: 0,
      col: 0,
    });
  });

  it("finds no buffer position for a row that is no longer mounted", () => {
    const buffer = buildChatBuffer(mountTimeline(USER_ROW));
    expect(fromRowPosition(buffer, { rowId: "gone", offset: 0 })).toBeNull();
  });
});

// Phase 5 of the modal keys production cycle (soft breaks read as spaces).
// Each case asserts the computed `white-space` it depends on before it
// asserts the projection, so a happy-dom that stopped resolving a style fails
// loudly instead of passing for the wrong reason. happy-dom resolves inline
// styles, stylesheet rules and inheritance, but has no user-agent stylesheet:
// an unstyled element reports "", which stands for the initial value
// `normal`, and `pre` needs the HTML rendering rule installed below.
describe("chat buffer soft breaks", () => {
  // The user-agent rule a browser applies to `pre` (HTML, "Rendering").
  let userAgentStyle: HTMLStyleElement;
  beforeEach(() => {
    userAgentStyle = document.createElement("style");
    userAgentStyle.textContent = "pre { white-space: pre; }";
    document.head.append(userAgentStyle);
  });
  afterEach(() => {
    userAgentStyle.remove();
  });

  /** An element's computed `white-space`, with happy-dom's "" read as `normal`. */
  function whiteSpaceOf(selector: string): string {
    return getComputedStyle(document.querySelector(selector)!).whiteSpace || "normal";
  }

  function assistantRow(id: string, prose: string): string {
    return `<div data-timeline-row-id="${id}"><div data-assistant-citation-source="${id}">${prose}</div></div>`;
  }

  it("soft break spec: a paragraph whose source has a single newline is one buffer line", () => {
    const buffer = buildChatBuffer(
      mountTimeline(
        assistantRow(
          "soft",
          "<p>Line one of the paragraph\nline two of it.</p><p>The next block.</p>",
        ),
      ),
    );
    expect(whiteSpaceOf("p")).toBe("normal");

    expect(buffer.lines).toEqual(["Line one of the paragraph line two of it.", "The next block."]);
    // `j` from the paragraph steps to the line after it: the next block.
    expect(buffer.lineRow).toEqual([0, 0]);
  });

  it("soft break spec: a newline inside inline markup in a paragraph reads as a space", () => {
    const buffer = buildChatBuffer(
      mountTimeline(
        assistantRow(
          "inline",
          "<p>Use <strong>the bold\nwords</strong> and <code>a()</code>\nthen stop.</p>",
        ),
      ),
    );
    expect(whiteSpaceOf("strong")).toBe("normal");

    expect(buffer.lines).toEqual(["Use the bold words and a() then stop."]);
  });

  it("soft break spec: nowrap collapses newlines like normal", () => {
    const buffer = buildChatBuffer(
      mountTimeline(
        assistantRow("nowrap", '<p style="white-space: nowrap">left half\nright half</p>'),
      ),
    );
    expect(whiteSpaceOf("p")).toBe("nowrap");

    expect(buffer.lines).toEqual(["left half right half"]);
  });

  it("soft break spec: offsets across a former soft break round-trip through a row position", () => {
    const buffer = buildChatBuffer(
      mountTimeline(assistantRow("offsets", "<p>alpha beta\ngamma delta</p><p>after</p>")),
    );
    expect(buffer.lines[0]).toBe("alpha beta gamma delta");

    // `gamma`, after the former break, on the same buffer line.
    const position = { line: 0, col: 11 };
    const rowPosition = toRowPosition(buffer, position);
    expect(rowPosition).toEqual({ rowId: "offsets", offset: 11 });
    expect(fromRowPosition(buffer, rowPosition!)).toEqual(position);
  });

  it("soft break spec: a range across a former soft break covers exactly the rendered characters", () => {
    const buffer = buildChatBuffer(
      mountTimeline(assistantRow("range", "<p>alpha beta\ngamma delta</p>")),
    );
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
    const buffer = buildChatBuffer(
      mountTimeline(assistantRow("code", "<pre><code>const a = 1;\nconst b = 2;</code></pre>")),
    );
    expect(whiteSpaceOf("pre")).toBe("pre");
    // The newline's text node sits in `code`, which inherits `pre`.
    expect(whiteSpaceOf("code")).toBe("pre");

    expect(buffer.lines).toEqual(["const a = 1;", "const b = 2;"]);
  });

  for (const whiteSpace of ["pre", "pre-wrap", "pre-line", "break-spaces"]) {
    it(`soft break guard: an inline white-space ${whiteSpace} keeps its newlines`, () => {
      const buffer = buildChatBuffer(
        mountTimeline(
          assistantRow(
            whiteSpace,
            `<p><span style="white-space: ${whiteSpace}">first line\nsecond line</span></p>`,
          ),
        ),
      );
      expect(whiteSpaceOf("span")).toBe(whiteSpace);

      expect(buffer.lines).toEqual(["first line", "second line"]);
    });
  }

  it("soft break guard: a stylesheet class with white-space pre-wrap keeps a user message's newlines", () => {
    const style = document.createElement("style");
    style.textContent = ".whitespace-pre-wrap { white-space: pre-wrap; }";
    const viewport = mountTimeline(
      '<div data-timeline-row-id="user-multiline"><div class="whitespace-pre-wrap">first request\nsecond request</div></div>',
    );
    document.head.append(style);
    try {
      expect(whiteSpaceOf(".whitespace-pre-wrap")).toBe("pre-wrap");

      expect(buildChatBuffer(viewport).lines).toEqual(["first request", "second request"]);
    } finally {
      style.remove();
    }
  });

  // Review P2-1: `\s` matches U+00A0, which the browser renders.
  it("soft break regression: a leading no-break space stays in the buffer line", () => {
    const buffer = buildChatBuffer(
      mountTimeline(assistantRow("nbsp", "<p>&nbsp;indented by a no-break space</p>")),
    );
    expect(whiteSpaceOf("p")).toBe("normal");

    expect(buffer.lines).toEqual(["\u00a0indented by a no-break space"]);
    const range = rangeBetween(buffer, { line: 0, col: 0 }, { line: 0, col: 1 });
    expect(range!.startOffset).toBe(0);
    expect(range!.toString()).toBe("\u00a0");
  });

  it("soft break guard: a hard break from remark-breaks still splits and adds no leading space", () => {
    // remark-breaks renders a Markdown newline as `<br>` followed by a "\n"
    // text node; the browser collapses that newline away at the line start.
    const buffer = buildChatBuffer(
      mountTimeline(assistantRow("hard", "<p>★ Insight first<br>\nsecond after the break</p>")),
    );
    expect(whiteSpaceOf("p")).toBe("normal");

    expect(buffer.lines).toEqual(["★ Insight first", "second after the break"]);
    // The line's first character is the rendered `s`, not the collapsed newline.
    const range = rangeBetween(buffer, { line: 1, col: 0 }, { line: 1, col: 1 });
    expect(range!.toString()).toBe("s");
  });
});
