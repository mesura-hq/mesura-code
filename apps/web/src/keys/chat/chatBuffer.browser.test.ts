// The markup mirrors what the timeline renders: one `[data-timeline-row-id]` per
// row, a screen-reader-only author heading, and an assistant row whose prose
// sits in `[data-assistant-citation-source]`. Chromium supplies real layout.
import { describe, expect, it, vi } from "vite-plus/test";

import { readAssistantText } from "~/lib/assistantTextSelection";
import { mountKeyDom } from "~/test/keyBrowserFixtures";

import {
  SEPARATOR_OFFSET,
  buildChatBuffer,
  domPointToRowPosition,
  isSupportedChatSelection,
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

it("keeps blank code lines mapped to their original DOM offsets", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="code"><p>Before</p><pre><code>\nalpha\n\n  \nbeta\n</code></pre><p>After</p></div>',
  );
  const buffer = buildChatBuffer(timeline.viewport);
  expect(buffer.lines).toEqual(["Before", "", "alpha", "", "  ", "beta", "", "After"]);
  expect(rangeBetween(buffer, { line: 1, col: 0 }, { line: 6, col: 0 })?.toString()).toBe(
    "\nalpha\n\n  \nbeta\n",
  );
  expect(fromRowPosition(buffer, toRowPosition(buffer, { line: 3, col: 0 })!)).toEqual({
    line: 3,
    col: 0,
  });
});

it("projects rendered objects as one stop per line without their internal text", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="rich"><p>Before <span data-mesura-chat-object="math" data-markdown-math="inline" data-markdown-copy="x^2">x²</span> after</p><div data-mesura-chat-object="html-render"><iframe data-mesura-chat-object-entry></iframe></div><img data-mesura-chat-object="image" alt="Plot"><div data-mesura-chat-object="diagram" data-markdown-copy="diagram source"><svg><text>Node</text></svg></div><div data-mesura-chat-object="mcp-app"><button>Action</button></div></div>',
  );
  const buffer = buildChatBuffer(timeline.viewport);
  expect(buffer.lines).toEqual([
    "Before ",
    "\ufffc",
    "after",
    "\ufffc",
    "\ufffc",
    "\ufffc",
    "\ufffc",
  ]);
  const range = rangeBetween(buffer, { line: 1, col: 0 }, { line: 1, col: 1 })!;
  expect(range.cloneContents().querySelector('[data-mesura-chat-object="math"]')).not.toBeNull();
});

it("reads only marked expanded output beneath activation wrappers", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="work"><div role="button"><span>Tool label</span><div data-mesura-readable><p>Expanded reasoning</p><pre>output\n\nend</pre><button>Copy output</button><textarea>Private input</textarea></div></div></div>',
  );
  const buffer = buildChatBuffer(timeline.viewport);
  expect(buffer.lines).toEqual(["Expanded reasoning", "output", "", "end"]);
  expect(readAssistantText(timeline.viewport).text).toBe("");
});

it("skips closed details, CSS-hidden content and unselectable chrome", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="visibility"><details><summary>Summary</summary>Hidden direct text<p>Hidden body</p></details><p style="display:none">Display hidden</p><p style="visibility:hidden">Visibility hidden</p><div style="opacity:0">Transparent</div><div style="user-select:none"><span>Code header</span></div><p>Visible body</p></div>',
  );
  const sourceText = readAssistantText(timeline.viewport).text;
  expect(sourceText).toContain("Hidden body");
  expect(sourceText).toContain("Code header");
  expect(buildChatBuffer(timeline.viewport).lines).toEqual(["Summary", "Visible body"]);
  timeline.container.querySelector("details")!.open = true;
  expect(buildChatBuffer(timeline.viewport).lines).toContain("Hidden body");
});

it.each(["flex", "grid"])(
  "separates adjacent status labels in %s layout without changing citation text",
  (display) => {
    using timeline = mountTimeline(
      `<div data-timeline-row-id="status"><div style="display:${display};gap:8px"><span>Factory run</span><span>degraded</span></div></div>`,
    );
    expect(readAssistantText(timeline.viewport).text).toBe("Factory rundegraded");
    const buffer = buildChatBuffer(timeline.viewport);
    expect(buffer.lines).toEqual(["Factory run degraded"]);
    expect(rangeBetween(buffer, { line: 0, col: 12 }, { line: 0, col: 20 })?.toString()).toBe(
      "degraded",
    );
  },
);

it("reads each element style once during a rebuild", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="cached"><p><span>first\nsecond</span></p><pre><code>alpha\n\nbeta</code></pre></div>',
  );
  using styles = vi.spyOn(window, "getComputedStyle");
  buildChatBuffer(timeline.viewport);
  const elements = styles.mock.calls.map(([element]) => element);
  expect(new Set(elements).size).toBe(elements.length);
});

it("projects table rows with tabs while ranges retain citation chunk boundaries", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="table"><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>Mode</td><td>Normal</td></tr></tbody></table></div>',
  );
  expect(readAssistantText(timeline.viewport).text).toBe("Metric\nValue\nMode\nNormal");
  const buffer = buildChatBuffer(timeline.viewport);
  expect(buffer.lines).toEqual(["Metric\tValue", "Mode\tNormal"]);
  expect(rangeBetween(buffer, { line: 1, col: 5 }, { line: 1, col: 11 })?.toString()).toBe(
    "Normal",
  );
});

it("maps DOM points to the same row coordinates used by motions", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="points"><p>alpha <strong>beta</strong></p><button>Control</button></div>',
  );
  const buffer = buildChatBuffer(timeline.viewport);
  const bold = timeline.container.querySelector("strong")!;
  expect(domPointToRowPosition(buffer, bold.firstChild!, 2)).toEqual({
    rowId: "points",
    offset: 8,
  });
  expect(domPointToRowPosition(buffer, bold, 1)).toEqual({ rowId: "points", offset: 10 });
  expect(
    domPointToRowPosition(buffer, timeline.container.querySelector("button")!.firstChild!, 1),
  ).toBeNull();
});

it("rejects selections spanning controls, object stops or unprojected content", () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="unsupported"><p>Before</p><button>Control</button><iframe></iframe><p>After</p></div>',
  );
  const buffer = buildChatBuffer(timeline.viewport);
  const paragraphs = timeline.container.querySelectorAll("p");
  const range = document.createRange();
  range.setStart(paragraphs[0]!.firstChild!, 0);
  range.setEnd(paragraphs[1]!.firstChild!, 5);
  expect(isSupportedChatSelection(buffer, range)).toBe(false);
  range.setEnd(paragraphs[0]!.firstChild!, 5);
  expect(isSupportedChatSelection(buffer, range)).toBe(true);
});
