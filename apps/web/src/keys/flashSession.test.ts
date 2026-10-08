// @vitest-environment happy-dom
// Entry point: `startFlash` and `handleFlashKey` (`flashSession.ts`), driven
// the way the chat and composer surfaces drive them: a provider supplies the
// targets for each pattern and receives the jump. The labels are read the way
// the overlay reads them, through `useFlashSnapshot`.
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  findOccurrences,
  handleFlashKey,
  isFlashActive,
  startFlash,
  stopFlash,
} from "./flashSession";
import type { FlashProvider, FlashTarget } from "./flashSession";
import { useFlashSnapshot, type FlashSnapshot } from "./flashStore";
import { readKeyEngineSnapshot } from "./keyEngineStore";

/** The cursor sits on the `X`, so the nearest match is not the first one. */
const TEXT = "cat cab Xcot cam";
const CURSOR = TEXT.indexOf("X");

let flash: FlashSnapshot;
let root: Root;
let textNode: Text;
let jumps: string[];

function FlashProbe() {
  const snapshot = useFlashSnapshot();
  useLayoutEffect(() => {
    flash = snapshot;
  });
  return null;
}

function provider(): FlashProvider {
  return {
    scope: "chat",
    backdrop: () => [],
    collect: (pattern, caseSensitive) =>
      findOccurrences(TEXT, pattern, caseSensitive).map((at): FlashTarget => {
        const range = document.createRange();
        range.setStart(textNode, at);
        range.setEnd(textNode, at + pattern.length);
        return {
          id: `at-${at}`,
          range,
          nextChar: TEXT[at + pattern.length],
          distance: Math.abs(at - CURSOR),
        };
      }),
    jump: (target) => jumps.push(target.id),
  };
}

function type(...tokens: string[]): void {
  act(() => {
    for (const token of tokens) expect(handleFlashKey(token)).toBe(true);
  });
}

const labelOf = (id: string) => flash.labels.find((label) => label.id === id)?.label;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = `<p>${TEXT}</p>`;
  textNode = document.querySelector("p")!.firstChild as Text;
  jumps = [];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(FlashProbe)));
  act(() => startFlash(provider()));
});

afterEach(() => {
  act(() => stopFlash());
  act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("flash session labels", () => {
  it("never labels a match with a character that continues the pattern", () => {
    type("c");
    // `c` matches at 0, 4, 9 and 13; the characters after them are a, a, o, a.
    expect(flash.labels.map((label) => label.id).toSorted()).toEqual([
      "at-0",
      "at-13",
      "at-4",
      "at-9",
    ]);
    for (const { label } of flash.labels) expect(["a", "o"]).not.toContain(label);
  });

  it("narrows the pattern on a key that continues it instead of jumping", () => {
    type("c", "a");
    expect(jumps).toEqual([]);
    expect(isFlashActive()).toBe(true);
    expect(flash.pattern).toBe("ca");
    expect(flash.labels.map((label) => label.id).toSorted()).toEqual(["at-0", "at-13", "at-4"]);
    for (const { label } of flash.labels) expect(["t", "b", "m"]).not.toContain(label);
  });

  it("jumps to the target whose label is typed and ends flash", () => {
    type("c", "a");
    const label = labelOf("at-4")!;
    type(label);
    expect(jumps).toEqual(["at-4"]);
    expect(isFlashActive()).toBe(false);
    expect(flash.active).toBe(false);
  });
});

describe("flash session keys", () => {
  it("exits on Backspace with an empty pattern", () => {
    type("<BS>");
    expect(isFlashActive()).toBe(false);
    expect(jumps).toEqual([]);
  });

  it("deletes one pattern character on Backspace before it exits", () => {
    type("c", "a", "<BS>");
    expect(isFlashActive()).toBe(true);
    expect(flash.pattern).toBe("c");
    type("<BS>");
    expect(isFlashActive()).toBe(true);
    expect(flash.pattern).toBe("");
    type("<BS>");
    expect(isFlashActive()).toBe(false);
  });

  it("jumps to the nearest target on Enter", () => {
    type("c", "<CR>");
    // The match right after the cursor, not the first match in the text.
    expect(jumps).toEqual(["at-9"]);
    expect(isFlashActive()).toBe(false);
  });

  it("exits without a jump on Enter before any pattern", () => {
    type("<CR>");
    expect(jumps).toEqual([]);
    expect(isFlashActive()).toBe(false);
  });

  it("exits on Escape without a jump", () => {
    type("c", "<Esc>");
    expect(jumps).toEqual([]);
    expect(isFlashActive()).toBe(false);
  });

  it("ends flash with a notice when the pattern matches nothing", () => {
    type("c", "q");
    expect(isFlashActive()).toBe(false);
    expect(readKeyEngineSnapshot().notice).toBe("flash: no match for “cq”");
  });
});
