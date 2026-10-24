// @vitest-environment happy-dom
// Entry point: `installKeyEngine` (`keyEngine.ts`) with the real `chatSurface`
// registered, as `KeyEngineHost` registers it. Every spec types `<leader>c`
// as real `KeyboardEvent`s from a focused element in the chat column, over a
// timeline fixture shaped like the one the chat renders, then types the labels
// the flash store shows. The cite pipeline's entry, `requestChatCite`, is
// mocked to record the selection the cite hands it. happy-dom lays nothing
// out, so the scroller's box and every range's box are stubbed: one line of
// text inside the reading area, and nothing over it.
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { configureKeyEngine, installKeyEngine, registerKeySurface } from "../keyEngine";
import { readKeyEngineSnapshot } from "../keyEngineStore";
import { isFlashActive, stopFlash } from "../flashSession";
import { useFlashSnapshot, type FlashSnapshot } from "../flashStore";
import { requestChatCite } from "./chatCiteBus";
import { chatSurface } from "./chatSurface";

vi.mock("./chatCiteBus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatCiteBus")>()),
  requestChatCite: vi.fn(),
}));

const USER_ROW = `
  <div data-timeline-row-id="user-1" data-timeline-row-kind="user">
    <p>Fix the build. Then run it.</p>
  </div>`;

const ASSISTANT_ROWS = `
  <div data-timeline-row-id="assistant-1" data-timeline-row-kind="assistant">
    <div data-assistant-citation-source="assistant-1">
      <p>The build failed. A type was wrong! Fixed it?</p>
      <p>Run the tests.</p>
    </div>
  </div>
  <div data-timeline-row-id="assistant-2" data-timeline-row-kind="assistant">
    <div data-assistant-citation-source="assistant-2">
      <p>Second reply. Ends here.</p>
    </div>
  </div>`;

const READING_AREA = { top: 0, height: 600 };
/** Where every range draws: on screen by default; a spec moves it off. */
let rangeTop = 100;

let flash: FlashSnapshot;
let probeRoot: Root;
let citedTexts: string[];
let disposeSurface: () => void = () => {};

function FlashProbe() {
  const snapshot = useFlashSnapshot();
  useLayoutEffect(() => {
    flash = snapshot;
  });
  return null;
}

function rect(top: number, height: number, left = 10, width = 8): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left,
    right: left + width,
    width,
    x: left,
    y: top,
  } as DOMRect;
}

function mountTimeline(rows: string): void {
  document.body.innerHTML = `
    <div data-chat-column-maximized-away="false">
      <div data-testid="chat-focus" tabindex="0"></div>
      <div data-assistant-citation-viewport>
        <div data-testid="scroller" style="overflow-y: auto">${rows}</div>
      </div>
      <div data-testid="probe"></div>
    </div>`;
  const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  scroller.getBoundingClientRect = () => rect(READING_AREA.top, READING_AREA.height, 0, 800);
  vi.spyOn(document, "elementFromPoint").mockImplementation(() => scroller);
  probeRoot = createRoot(document.querySelector('[data-testid="probe"]')!);
  act(() => probeRoot.render(createElement(FlashProbe)));
  document.querySelector<HTMLElement>('[data-testid="chat-focus"]')!.focus();
}

/** Dispatches a keydown from the focused element, as the browser does. */
function press(key: string): void {
  const code = key === " " ? "Space" : `Key${key.toUpperCase()}`;
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }),
    );
  });
}

const typeLeaderCite = () => {
  press(" ");
  press("c");
};

/** The fixture's buffer lines: each row's blocks, a blank line between rows. */
function bufferLines(): string[] {
  const lines: string[] = [];
  document.querySelectorAll("[data-timeline-row-id]").forEach((row, index) => {
    if (index > 0) lines.push("");
    row.querySelectorAll("p").forEach((block) => lines.push(block.textContent ?? ""));
  });
  return lines;
}

/**
 * A pick label's target, read from its id (`line:col`, the buffer position the
 * label marks): the line's text from that character on, and up to it.
 */
function labelTarget(id: string): { readonly from: string; readonly upTo: string } {
  const [line, col] = id.split(":").map(Number);
  const text = bufferLines()[line!] ?? "";
  return { from: text.slice(col!), upTo: text.slice(0, col! + 1) };
}

/** The label the flash store shows over the target `matches` picks. */
function labelWhere(matches: (target: ReturnType<typeof labelTarget>) => boolean): string {
  const match = flash.labels.find(({ id }) => matches(labelTarget(id)));
  if (!match) throw new Error(`no such label: ${JSON.stringify(flash.labels)}`);
  return match.label;
}

const startLabel = (text: string) => labelWhere(({ from }) => from.startsWith(text));
const endLabel = (text: string) => labelWhere(({ upTo }) => upTo.endsWith(text));

beforeAll(() => {
  installKeyEngine();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rangeTop = 100;
  citedTexts = [];
  vi.mocked(requestChatCite).mockImplementation(() => {
    citedTexts.push(window.getSelection()?.getRangeAt(0).toString() ?? "");
    return true;
  });
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(() => rect(rangeTop, 16));
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
    () => [rect(rangeTop, 16)] as unknown as DOMRectList,
  );
  configureKeyEngine({ enabled: true });
  disposeSurface = registerKeySurface(chatSurface);
});

afterEach(() => {
  act(() => stopFlash());
  act(() => probeRoot.unmount());
  disposeSurface();
  configureKeyEngine({ enabled: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("chat cite picks", () => {
  it("labels the sentence starts of the assistant text on screen on <leader>c", () => {
    mountTimeline(USER_ROW + ASSISTANT_ROWS);
    typeLeaderCite();
    expect(isFlashActive()).toBe(true);
    expect(flash.hint).toBe("cite: where it starts");
    // The developer's own message is not citable; every assistant sentence is.
    expect(flash.labels.map(({ id }) => labelTarget(id).from)).toEqual([
      "The build failed. A type was wrong! Fixed it?",
      "A type was wrong! Fixed it?",
      "Fixed it?",
      "Run the tests.",
      "Second reply. Ends here.",
      "Ends here.",
    ]);
  });

  it("labels only the sentence ends of the picked message once a cite start is picked", () => {
    mountTimeline(USER_ROW + ASSISTANT_ROWS);
    typeLeaderCite();
    press(startLabel("A type"));
    expect(isFlashActive()).toBe(true);
    expect(flash.hint).toBe("cite: where it ends");
    // From the start onwards, inside the first assistant message only.
    expect(flash.labels.map(({ id }) => labelTarget(id).upTo)).toEqual([
      "The build failed. A type was wrong!",
      "The build failed. A type was wrong! Fixed it?",
      "Run the tests.",
    ]);
  });

  it("cites the text between the picked sentence start and the picked sentence end", () => {
    mountTimeline(USER_ROW + ASSISTANT_ROWS);
    typeLeaderCite();
    press(startLabel("A type"));
    press(endLabel("Fixed it?"));
    expect(citedTexts).toEqual(["A type was wrong! Fixed it?"]);
    expect(isFlashActive()).toBe(false);
    expect(readKeyEngineSnapshot().notice).toBe("cited into the composer");
  });
});

describe("chat cite with nothing to cite", () => {
  it("shows the no-assistant-text notice and starts no pick when only the developer's text is on screen", () => {
    mountTimeline(USER_ROW);
    typeLeaderCite();
    expect(readKeyEngineSnapshot().notice).toBe("no assistant text on screen to cite");
    expect(isFlashActive()).toBe(false);
    expect(flash.active).toBe(false);
    expect(citedTexts).toEqual([]);
  });

  it("shows the no-assistant-text notice and starts no pick in an empty chat", () => {
    mountTimeline("");
    typeLeaderCite();
    expect(readKeyEngineSnapshot().notice).toBe("no assistant text on screen to cite");
    expect(isFlashActive()).toBe(false);
    expect(flash.active).toBe(false);
  });

  it("shows the no-assistant-text notice when the assistant text is scrolled off screen", () => {
    rangeTop = READING_AREA.top + READING_AREA.height + 100;
    mountTimeline(USER_ROW + ASSISTANT_ROWS);
    typeLeaderCite();
    expect(readKeyEngineSnapshot().notice).toBe("no assistant text on screen to cite");
    expect(isFlashActive()).toBe(false);
  });
});
