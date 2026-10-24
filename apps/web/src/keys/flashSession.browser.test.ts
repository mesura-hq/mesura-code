// Entry point: `startFlash`, `startFlashPick` and `handleFlashKey`
// (`flashSession.ts`), driven the way the chat and composer surfaces drive
// them: a provider supplies the targets for each pattern and receives the
// jump, or a pick labels its targets up front and receives the chosen one.
// The labels are read the way the overlay reads them, through
// `useFlashSnapshot`.
import { createElement, useLayoutEffect } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render, fakeTimers } from "../../test/render";
import { mountKeyDom } from "~/test/keyBrowserFixtures";

import {
  findOccurrences,
  handleFlashKey,
  isFlashActive,
  startFlash,
  startFlashPick,
  stopFlash,
} from "./flashSession";
import type { FlashPick, FlashProvider, FlashTarget } from "./flashSession";
import { useFlashSnapshot, type FlashSnapshot } from "./flashStore";
import { readKeyEngineSnapshot } from "./keyEngineStore";

/** The cursor sits on the `X`, so the nearest match is not the first one. */
const TEXT = "cat cab Xcot cam";
const CURSOR = TEXT.indexOf("X");

async function setup() {
  await using stack = new AsyncDisposableStack();
  const dom = stack.use(mountKeyDom(`<p>${TEXT}</p>`));
  const textNode = dom.container.querySelector("p")!.firstChild as Text;
  const jumps: string[] = [];
  const picked: string[] = [];
  let flash: FlashSnapshot;

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

  async function type(...tokens: string[]): Promise<void> {
    await act(() => {
      for (const token of tokens) expect(handleFlashKey(token)).toBe(true);
    });
  }

  const labelOf = (id: string) => flash.labels.find((label) => label.id === id)?.label;

  stack.use(await render(createElement(FlashProbe)));
  stack.use(fakeTimers());
  stack.defer(() => act(() => stopFlash()));
  await act(() => startFlash(provider()));
  const lifetime = stack.move();
  return {
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
    get flash() {
      return flash;
    },
    jumps,
    picked,
    textNode,
    type,
    labelOf,
  };
}

describe("flash session labels", () => {
  it("never labels a match with a character that continues the pattern", async () => {
    await using fixture = await setup();
    await fixture.type("c");
    // `c` matches at 0, 4, 9 and 13; the characters after them are a, a, o, a.
    expect(fixture.flash.labels.map((label) => label.id).toSorted()).toEqual([
      "at-0",
      "at-13",
      "at-4",
      "at-9",
    ]);
    for (const { label } of fixture.flash.labels) expect(["a", "o"]).not.toContain(label);
  });

  it("narrows the pattern on a key that continues it instead of jumping", async () => {
    await using fixture = await setup();
    await fixture.type("c", "a");
    expect(fixture.jumps).toEqual([]);
    expect(isFlashActive()).toBe(true);
    expect(fixture.flash.pattern).toBe("ca");
    expect(fixture.flash.labels.map((label) => label.id).toSorted()).toEqual([
      "at-0",
      "at-13",
      "at-4",
    ]);
    for (const { label } of fixture.flash.labels) expect(["t", "b", "m"]).not.toContain(label);
  });

  it("jumps to the target whose label is typed and ends flash", async () => {
    await using fixture = await setup();
    await fixture.type("c", "a");
    const label = fixture.labelOf("at-4")!;
    await fixture.type(label);
    expect(fixture.jumps).toEqual(["at-4"]);
    expect(isFlashActive()).toBe(false);
    expect(fixture.flash.active).toBe(false);
  });
});

describe("flash session keys", () => {
  it("exits on Backspace with an empty pattern", async () => {
    await using fixture = await setup();
    await fixture.type("<BS>");
    expect(isFlashActive()).toBe(false);
    expect(fixture.jumps).toEqual([]);
  });

  it("deletes one pattern character on Backspace before it exits", async () => {
    await using fixture = await setup();
    await fixture.type("c", "a", "<BS>");
    expect(isFlashActive()).toBe(true);
    expect(fixture.flash.pattern).toBe("c");
    await fixture.type("<BS>");
    expect(isFlashActive()).toBe(true);
    expect(fixture.flash.pattern).toBe("");
    await fixture.type("<BS>");
    expect(isFlashActive()).toBe(false);
  });

  it("jumps to the nearest target on Enter", async () => {
    await using fixture = await setup();
    await fixture.type("c", "<CR>");
    // The match right after the cursor, not the first match in the text.
    expect(fixture.jumps).toEqual(["at-9"]);
    expect(isFlashActive()).toBe(false);
  });

  it("exits without a jump on Enter before any pattern", async () => {
    await using fixture = await setup();
    await fixture.type("<CR>");
    expect(fixture.jumps).toEqual([]);
    expect(isFlashActive()).toBe(false);
  });

  it("exits on Escape without a jump", async () => {
    await using fixture = await setup();
    await fixture.type("c", "<Esc>");
    expect(fixture.jumps).toEqual([]);
    expect(isFlashActive()).toBe(false);
  });

  it("ends flash with a notice when the pattern matches nothing", async () => {
    await using fixture = await setup();
    await fixture.type("c", "q");
    expect(isFlashActive()).toBe(false);
    expect(readKeyEngineSnapshot().notice).toBe("flash: no match for “cq”");
  });
});

describe("flash label pick", () => {
  /** A pick over `count` targets, each one character of the fixture text. */
  function pickOver(
    fixture: Awaited<ReturnType<typeof setup>>,
    count: number,
    overrides: Partial<FlashPick> = {},
  ): FlashPick {
    return {
      scope: "chat",
      hint: "cite: where it starts",
      placement: "over",
      backdrop: [],
      targets: Array.from({ length: count }, (_, index) => {
        const range = document.createRange();
        range.setStart(fixture.textNode, index % TEXT.length);
        range.setEnd(fixture.textNode, (index % TEXT.length) + 1);
        return { id: `target-${index}`, range };
      }),
      pick: (target) => fixture.picked.push(target.id),
      ...overrides,
    };
  }

  it("labels every pick target at once and shows the pick's hint", async () => {
    await using fixture = await setup();
    await act(() => {
      expect(startFlashPick(pickOver(fixture, 3))).toBe(true);
    });
    expect(fixture.flash.active).toBe(true);
    expect(fixture.flash.hint).toBe("cite: where it starts");
    expect(fixture.flash.labels.map(({ id, label }) => [id, label])).toEqual([
      ["target-0", "a"],
      ["target-1", "s"],
      ["target-2", "d"],
    ]);
  });

  it("picks the target whose label is typed and ends the pick", async () => {
    await using fixture = await setup();
    await act(() => {
      startFlashPick(pickOver(fixture, 3));
    });
    await fixture.type("s");
    expect(fixture.picked).toEqual(["target-1"]);
    expect(isFlashActive()).toBe(false);
  });

  it("narrows a pick to the second characters after the first of a two-character label", async () => {
    await using fixture = await setup();
    // 27 targets over 26 label characters: the last two take two characters.
    await act(() => {
      startFlashPick(pickOver(fixture, 27));
    });
    expect(fixture.labelOf("target-26")).toBe("ms");
    await fixture.type("m");
    expect(fixture.picked).toEqual([]);
    expect(fixture.flash.pattern).toBe("m");
    expect(fixture.flash.labels.map(({ id, label }) => [id, label])).toEqual([
      ["target-25", "a"],
      ["target-26", "s"],
    ]);
    await fixture.type("s");
    expect(fixture.picked).toEqual(["target-26"]);
  });

  it("clears a typed pick prefix on Backspace, then exits the pick on a second Backspace", async () => {
    await using fixture = await setup();
    await act(() => {
      startFlashPick(pickOver(fixture, 27));
    });
    await fixture.type("m", "<BS>");
    expect(isFlashActive()).toBe(true);
    expect(fixture.flash.pattern).toBe("");
    expect(fixture.flash.labels).toHaveLength(27);
    await fixture.type("<BS>");
    expect(isFlashActive()).toBe(false);
    expect(fixture.picked).toEqual([]);
  });

  it("exits a pick on Escape and ignores a key that is no label", async () => {
    await using fixture = await setup();
    await act(() => {
      startFlashPick(pickOver(fixture, 3));
    });
    await fixture.type("z");
    expect(isFlashActive()).toBe(true);
    await fixture.type("<Esc>");
    expect(isFlashActive()).toBe(false);
    expect(fixture.picked).toEqual([]);
  });

  it("shows nothing and reports false for a pick with no target", async () => {
    await using fixture = await setup();
    await act(() => {
      expect(startFlashPick(pickOver(fixture, 0))).toBe(false);
    });
    expect(isFlashActive()).toBe(false);
    expect(fixture.flash.active).toBe(false);
  });
});
