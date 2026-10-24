// Entry point: `installKeyEngine` (`keyEngine.ts`) with the real `chatSurface`
// registered, as `KeyEngineHost` registers it. Every spec types `<leader>c`
// as real `KeyboardEvent`s from a focused element in the chat column, over a
// timeline fixture shaped like the one the chat renders, then types the labels
// the flash store shows. The cite pipeline's entry, `requestChatCite`, is
// mocked to record the selected text. Fixed geometry isolates the reading
// area and off-screen guards from the runner's viewport size.
import { createElement, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, fakeTimers } from "../../../test/render";
import { createWindowListenerFixture, mountKeyDom } from "~/test/keyBrowserFixtures";

import { configureKeyEngine, installKeyEngine, registerKeySurface } from "../keyEngine";
import { readKeyEngineSnapshot } from "../keyEngineStore";
import { isFlashActive, stopFlash } from "../flashSession";
import { useFlashSnapshot, type FlashSnapshot } from "../flashStore";
import { requestChatCite } from "./chatCiteBus";
import { chatSurface } from "./chatSurface";

vi.mock("./chatCiteBus", () => ({ requestChatCite: vi.fn() }));

const keyEngineListeners = createWindowListenerFixture(installKeyEngine);

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

async function setup(rows: string, rangeTop = 100) {
  await using stack = new AsyncDisposableStack();
  stack.use(keyEngineListeners());
  const dom = stack.use(
    mountKeyDom(`
    <div data-chat-column-maximized-away="false">
      <div data-testid="chat-focus" tabindex="0"></div>
      <div data-assistant-citation-viewport>
        <div data-testid="scroller" style="overflow-y: auto">${rows}</div>
      </div>
      <div data-testid="probe"></div>
    </div>`),
  );
  const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  scroller.getBoundingClientRect = () => rect(READING_AREA.top, READING_AREA.height, 0, 800);
  const citedTexts: string[] = [];
  vi.mocked(requestChatCite)
    .mockReset()
    .mockImplementation(() => {
      citedTexts.push(window.getSelection()?.getRangeAt(0).toString() ?? "");
      return true;
    });
  stack.defer(() => {
    vi.mocked(requestChatCite).mockReset();
  });
  stack.use(vi.spyOn(document, "elementFromPoint").mockImplementation(() => scroller));
  stack.use(
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(() => rect(rangeTop, 16)),
  );
  stack.use(
    vi
      .spyOn(Range.prototype, "getClientRects")
      .mockImplementation(() => [rect(rangeTop, 16)] as unknown as DOMRectList),
  );
  let flash: FlashSnapshot;
  function FlashProbe() {
    const snapshot = useFlashSnapshot();
    useLayoutEffect(() => {
      flash = snapshot;
    });
    return null;
  }
  stack.use(await render(createElement(FlashProbe), { container: dom.byTestId("probe") }));
  stack.use(fakeTimers());
  configureKeyEngine({ enabled: true });
  stack.defer(() => configureKeyEngine({ enabled: false }));
  stack.defer(registerKeySurface(chatSurface));
  stack.defer(() => act(() => stopFlash()));
  dom.byTestId("chat-focus").focus();

  /** Dispatches a keydown from the focused element, as the browser does. */
  async function press(key: string): Promise<void> {
    const code = key === " " ? "Space" : `Key${key.toUpperCase()}`;
    await act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }),
      );
    });
  }

  const typeLeaderCite = async () => {
    await press(" ");
    await press("c");
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

  const lifetime = stack.move();
  return {
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
    get flash() {
      return flash;
    },
    citedTexts,
    press,
    typeLeaderCite,
    startLabel,
    endLabel,
    labelTarget,
  };
}

describe("chat cite picks", () => {
  it("labels the sentence starts of the assistant text on screen on <leader>c", async () => {
    await using fixture = await setup(USER_ROW + ASSISTANT_ROWS);
    await fixture.typeLeaderCite();
    expect(isFlashActive()).toBe(true);
    expect(fixture.flash.hint).toBe("cite: where it starts");
    // The developer's own message is not citable; every assistant sentence is.
    expect(fixture.flash.labels.map(({ id }) => fixture.labelTarget(id).from)).toEqual([
      "The build failed. A type was wrong! Fixed it?",
      "A type was wrong! Fixed it?",
      "Fixed it?",
      "Run the tests.",
      "Second reply. Ends here.",
      "Ends here.",
    ]);
  });

  it("labels only the sentence ends of the picked message once a cite start is picked", async () => {
    await using fixture = await setup(USER_ROW + ASSISTANT_ROWS);
    await fixture.typeLeaderCite();
    await fixture.press(fixture.startLabel("A type"));
    expect(isFlashActive()).toBe(true);
    expect(fixture.flash.hint).toBe("cite: where it ends");
    // From the start onwards, inside the first assistant message only.
    expect(fixture.flash.labels.map(({ id }) => fixture.labelTarget(id).upTo)).toEqual([
      "The build failed. A type was wrong!",
      "The build failed. A type was wrong! Fixed it?",
      "Run the tests.",
    ]);
  });

  it("cites the text between the picked sentence start and the picked sentence end", async () => {
    await using fixture = await setup(USER_ROW + ASSISTANT_ROWS);
    await fixture.typeLeaderCite();
    await fixture.press(fixture.startLabel("A type"));
    await fixture.press(fixture.endLabel("Fixed it?"));
    expect(fixture.citedTexts).toEqual(["A type was wrong! Fixed it?"]);
    expect(isFlashActive()).toBe(false);
    expect(readKeyEngineSnapshot().notice).toBe("cited into the composer");
  });
});

describe("chat cite with nothing to cite", () => {
  it("shows the no-assistant-text notice and starts no pick when only the developer's text is on screen", async () => {
    await using fixture = await setup(USER_ROW);
    await fixture.typeLeaderCite();
    expect(readKeyEngineSnapshot().notice).toBe("no assistant text on screen to cite");
    expect(isFlashActive()).toBe(false);
    expect(fixture.flash.active).toBe(false);
    expect(fixture.citedTexts).toEqual([]);
  });

  it("shows the no-assistant-text notice and starts no pick in an empty chat", async () => {
    await using fixture = await setup("");
    await fixture.typeLeaderCite();
    expect(readKeyEngineSnapshot().notice).toBe("no assistant text on screen to cite");
    expect(isFlashActive()).toBe(false);
    expect(fixture.flash.active).toBe(false);
  });

  it("shows the no-assistant-text notice when the assistant text is scrolled off screen", async () => {
    await using fixture = await setup(
      USER_ROW + ASSISTANT_ROWS,
      READING_AREA.top + READING_AREA.height + 100,
    );
    await fixture.typeLeaderCite();
    expect(readKeyEngineSnapshot().notice).toBe("no assistant text on screen to cite");
    expect(isFlashActive()).toBe(false);
  });
});
