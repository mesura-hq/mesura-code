/**
 * @vitest-environment happy-dom
 *
 * The information panel beside the finder's list.
 *
 * What the highlighted result IS — its name, size, type, git status and age —
 * and a live preview of it, through the same router the main window uses. The
 * split stays in place with a placeholder when no result is selected.
 *
 * The preview itself is not re-tested here: `preview.test.tsx` proves the
 * router against every type. What is proved here is that the finder reaches it,
 * with the right path, and does not reach it once per row while a movement key
 * is held.
 */
import type { SearchReplyRow } from "@symmetria/fm-core/contract";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, installBridge, namesIn } from "./support.ts";

const DEBOUNCE_MS = 100;
/** `PREVIEW_DEBOUNCE_MS`, which `usePreview` owns. */
const PREVIEW_MS = 150;

function row(
  relativePath: string,
  name: string,
  over: Partial<SearchReplyRow> = {},
): SearchReplyRow {
  return {
    relativePath,
    name,
    fullPath: `/home/jc/${relativePath}`,
    isDir: relativePath.endsWith("/"),
    score: 100,
    size: 4096,
    modifiedMs: 0,
    gitStatus: "clean",
    matchIndices: [],
    ...over,
  };
}

let log: BridgeLog;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function opened(options: Parameters<typeof installBridge>[0] = {}): Promise<void> {
  log = installBridge(options);
  render(<App startPath="/home/jc" homePath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
  fireEvent.keyDown(window, { key: "f" });
  await screen.findByTestId("finder");
}

async function type(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId("finder-query"), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

/** Let the preview's own debounce elapse and its request settle. */
async function settlePreview(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(PREVIEW_MS);
  });
  await act(async () => undefined);
}

function facts(): string {
  return screen.getByTestId("finder-info-facts").textContent ?? "";
}

describe("the panel appears with the answer", () => {
  it("is absent while there is nothing to show", async () => {
    await opened({ search: () => [] });
    expect(screen.queryByTestId("finder-info")).toBeNull();
  });

  it("appears as soon as a result is highlighted", async () => {
    // Paired with the empty case above, so a panel that was always mounted
    // could not pass both.
    await opened({ search: () => [row("src/format.ts", "format.ts")] });
    await type("fmt");
    await waitFor(() => expect(screen.getByTestId("finder-info")).toBeTruthy());
  });

  it("reserves the preview column when a search has no results", async () => {
    await opened({ search: (query) => (query === "hit" ? [row("a.ts", "a.ts")] : []) });
    await type("hit");
    await waitFor(() => expect(screen.getByTestId("finder-info")).toBeTruthy());
    await type("miss");
    await waitFor(() => expect(screen.queryByTestId("finder-info")).toBeNull());
    expect(screen.getByTestId("finder-info-placeholder").textContent).toContain("Select a file");
  });
});

describe("what the panel says about a file", () => {
  it("names it, and reports its size, type, git status and age", async () => {
    const now = Date.now();
    await opened({
      search: () => [
        row("src/format.ts", "format.ts", {
          size: 4096,
          gitStatus: "modified",
          modifiedMs: now - 3 * 24 * 60 * 60 * 1000,
        }),
      ],
    });
    await type("fmt");
    await waitFor(() =>
      expect(screen.getByTestId("finder-info-name").textContent).toBe("format.ts"),
    );

    const shown = facts();
    expect(shown).toContain("4.0 kB");
    expect(shown).toContain("TS");
    expect(shown).toContain("modified");
    expect(shown).toContain("3d ago");
  });

  it("reports a directory's missing facts as missing rather than as zero", async () => {
    // The engine's directory item carries no size, no modification time and no
    // git status. Reporting them as `0 B` and 1970 would be inventing four
    // facts nobody established.
    await opened({
      search: () => [
        row("notes/", "notes", {
          fullPath: "/home/jc/notes/",
          isDir: true,
          size: 0,
          modifiedMs: 0,
          gitStatus: "",
        }),
      ],
    });
    await type("notes");
    await waitFor(() => expect(screen.getByTestId("finder-info-name").textContent).toBe("notes"));

    const shown = facts();
    expect(shown).toContain("dir");
    expect(shown).toContain("—");
    expect(shown).not.toContain("0 B");
    expect(shown).not.toContain("1970");
  });

  it("follows the highlight rather than the first result", async () => {
    await opened({
      search: () => [row("a.ts", "a.ts"), row("b.md", "b.md")],
    });
    await type("x");
    await waitFor(() => expect(screen.getByTestId("finder-info-name").textContent).toBe("a.ts"));

    fireEvent.keyDown(screen.getByTestId("finder-query"), { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByTestId("finder-info-name").textContent).toBe("b.md"));
    expect(facts()).toContain("MD");
  });
});

describe("the live preview", () => {
  it("asks the same describe channel the main window uses, for the highlighted path", async () => {
    await opened({ search: () => [row("src/format.ts", "format.ts")] });
    await type("fmt");
    await waitFor(() => expect(screen.getByTestId("finder-info")).toBeTruthy());
    await settlePreview();

    expect(log.described).toContain("/home/jc/src/format.ts");
  });

  it("asks for a directory WITHOUT the engine's trailing separator", async () => {
    // Every other path in the application is separator-free, and this one is
    // about to be handed to `stat`.
    await opened({
      search: () => [row("notes/", "notes", { fullPath: "/home/jc/notes/", isDir: true })],
    });
    await type("notes");
    await waitFor(() => expect(screen.getByTestId("finder-info")).toBeTruthy());
    await settlePreview();

    expect(log.described).toContain("/home/jc/notes");
    expect(log.described).not.toContain("/home/jc/notes/");
  });

  it("does not ask once per row while a movement key is held", async () => {
    // The reason the debounce exists. It lives inside `usePreview`, at the
    // 150 ms a second stage here would have used; the finder deliberately adds
    // no stage of its own, so this is where that decision is checked.
    await opened({
      search: () => Array.from({ length: 8 }, (_, at) => row(`f${at}.ts`, `f${at}.ts`)),
    });
    await type("f");
    await waitFor(() => expect(screen.getByTestId("finder-info")).toBeTruthy());
    await settlePreview();
    const before = log.described.length;

    const field = screen.getByTestId("finder-query");
    for (let at = 0; at < 7; at += 1) {
      fireEvent.keyDown(field, { key: "ArrowDown" });
      await act(async () => {
        vi.advanceTimersByTime(PREVIEW_MS / 5);
      });
    }
    await settlePreview();

    // One describe for where the cursor landed, not seven for where it passed.
    // Paired with a positive assertion, so a preview that asked for NOTHING
    // could not pass this.
    expect(log.described.length - before).toBeLessThan(4);
    expect(log.described.at(-1)).toBe("/home/jc/f7.ts");
  });
});

describe("the split", () => {
  // The two stylesheet assertions this pair belongs with — that the rule reads
  // the token, and that the list may shrink below its content — live in
  // `theme.test.ts`. They read files, and under happy-dom `import.meta.url` is
  // not a file URL.
  it("keeps the list readable when a result has a very long path", async () => {
    // The behavioural half of the two assertions above: the row is still there
    // and still names the file, however deep it sits.
    const deep = `${"very-long-directory-name/".repeat(12)}format.ts`;
    await opened({ search: () => [row(deep, "format.ts")] });
    await type("fmt");
    await waitFor(() => expect(screen.getAllByTestId("finder-row")).toHaveLength(1));
    expect(screen.getByTestId("finder-row-name").textContent).toBe("format.ts");
    expect(screen.getByTestId("finder-info")).toBeTruthy();
  });
});
