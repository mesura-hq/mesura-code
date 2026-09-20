/**
 * @vitest-environment happy-dom
 *
 * The finder, mounted by a host that has no file manager.
 *
 * Acceptance criteria 2 and 3, and the whole point of the package. Everything
 * else about the finder is proved inside the file manager's own suite, where
 * there is an application around it; what is proved HERE is that there does not
 * have to be one.
 *
 * **The test renders `FinderOverlay` and nothing else.** No panel, no
 * application component, no provider, no context. If this ever needs one of
 * those to be added to make it pass, that is the finding — and the fix is to
 * make the overlay take it as a prop, not to import the file manager here.
 *
 * The host contract is exactly two things: the four search methods on the
 * bridge global, and the handlers. This installs a fake of the first and
 * asserts on the second.
 */
import { BRIDGE_KEY } from "@symmetria/fm-core/bridge";
import type { SearchReplyRow } from "@symmetria/fm-core/contract";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FinderOverlay } from "../src/ui/index.ts";

const DEBOUNCE_MS = 100;

function row(
  relativePath: string,
  name: string,
  over: Partial<SearchReplyRow> = {},
): SearchReplyRow {
  return {
    relativePath,
    name,
    fullPath: `/project/${relativePath}`,
    isDir: relativePath.endsWith("/"),
    score: 100,
    size: 128,
    modifiedMs: 0,
    gitStatus: "clean",
    matchIndices: [],
    ...over,
  };
}

interface HostLog {
  readonly started: string[];
  readonly chosen: { path: string; isDir: boolean }[];
  readonly closed: number[];
}

/**
 * The whole of what a host has to provide on the privileged side.
 *
 * Four methods on one global. A host that runs the engine itself answers these
 * for real; this answers them from a fixture, which is the point — the overlay
 * cannot tell, and neither can anything it renders.
 */
function installHostBridge(rows: (query: string) => readonly SearchReplyRow[]): HostLog {
  const started: string[] = [];
  const log: HostLog = { started, chosen: [], closed: [] };
  const ok = { ok: true as const, value: null };

  Object.defineProperty(window, BRIDGE_KEY, {
    configurable: true,
    writable: true,
    value: {
      searchStart: (request: unknown) => {
        // SAFETY: the payload is built by this package's own `bridge.ts` from
        // typed arguments a few frames up the stack. A real host receives it
        // across a process boundary and must decode it — `decodeSearchDirectoryRequest`
        // is what does that — but this fixture stands in for the privileged
        // half, not for the boundary between them.
        started.push((request as { directory: string }).directory);
        return Promise.resolve(ok);
      },
      searchQuery: (request: unknown) => {
        // SAFETY: as above — this payload came from `searchIn` in this package.
        const { query } = request as { query: string };
        const found = rows(query);
        return Promise.resolve({
          ok: true as const,
          value: { rows: found, matchedQuery: query, truncated: false, cap: 200 },
        });
      },
      searchRecord: () => Promise.resolve(ok),
      searchRelease: () => Promise.resolve(ok),
    },
  });
  return log;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function type(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId("finder-query"), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

describe("a host with no file manager", () => {
  it("returns to the first result after manual scrolling and a query with the same count", async () => {
    installHostBridge((query) =>
      Array.from({ length: 50 }, (_, index) => row(`${query}${index}.ts`, `${query}${index}.ts`)),
    );
    render(
      <FinderOverlay directory="/project" onChoose={() => undefined} onClose={() => undefined} />,
    );
    await type("first");
    await waitFor(() => expect(screen.getAllByTestId("finder-row")).toHaveLength(50));
    const results = screen.getByRole("listbox");
    results.scrollTop = 500;
    await type("second");
    await waitFor(() =>
      expect(screen.getAllByTestId("finder-row-name")[0]?.textContent).toBe("second0.ts"),
    );
    expect(results.scrollTop).toBe(0);
    expect(screen.getAllByTestId("finder-row")[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("mounts the overlay on its own and searches a tree", async () => {
    const log = installHostBridge((query) =>
      query === "fmt" ? [row("src/format.ts", "format.ts")] : [],
    );
    render(
      <FinderOverlay
        directory="/project"
        onChoose={(path, isDir) => log.chosen.push({ path, isDir })}
        onClose={() => log.closed.push(1)}
      />,
    );
    await act(async () => undefined);

    expect(log.started).toEqual(["/project"]);
    await type("fmt");
    await waitFor(() => expect(screen.getAllByTestId("finder-row")).toHaveLength(1));
    expect(screen.getByTestId("finder-row-name").textContent).toBe("format.ts");
  });

  it("hands a chosen FILE to the host and navigates nothing", async () => {
    const log = installHostBridge(() => [row("src/format.ts", "format.ts")]);
    render(
      <FinderOverlay
        directory="/project"
        onChoose={(path, isDir) => log.chosen.push({ path, isDir })}
        onClose={() => log.closed.push(1)}
      />,
    );
    await act(async () => undefined);
    await type("fmt");
    await waitFor(() => expect(screen.getAllByTestId("finder-row")).toHaveLength(1));

    fireEvent.keyDown(screen.getByTestId("finder-query"), { key: "Enter" });

    expect(log.chosen).toEqual([{ path: "/project/src/format.ts", isDir: false }]);
    // The overlay is still mounted: closing is the HOST's decision, and a
    // component that unmounted itself would be one a host could not keep open.
    expect(screen.queryByTestId("finder")).not.toBeNull();
  });

  it("hands a chosen DIRECTORY to the host, flagged and without the engine's separator", async () => {
    // A host has no reason to know that the engine spells a directory with a
    // trailing separator, which is exactly why `isDir` travels beside the path.
    const log = installHostBridge(() => [
      row("notes/", "notes", { fullPath: "/project/notes/", isDir: true }),
    ]);
    render(
      <FinderOverlay
        directory="/project"
        onChoose={(path, isDir) => log.chosen.push({ path, isDir })}
        onClose={() => log.closed.push(1)}
      />,
    );
    await act(async () => undefined);
    await type("notes");
    await waitFor(() => expect(screen.getAllByTestId("finder-row")).toHaveLength(1));

    fireEvent.keyDown(screen.getByTestId("finder-query"), { key: "Enter" });

    expect(log.chosen).toEqual([{ path: "/project/notes", isDir: true }]);
  });

  it("asks the host to close rather than closing itself", async () => {
    const log = installHostBridge(() => []);
    render(
      <FinderOverlay
        directory="/project"
        onChoose={(path, isDir) => log.chosen.push({ path, isDir })}
        onClose={() => log.closed.push(1)}
      />,
    );
    await act(async () => undefined);

    fireEvent.keyDown(screen.getByTestId("finder-query"), { key: "Escape" });

    expect(log.closed).toHaveLength(1);
    expect(log.chosen).toEqual([]);
  });

  it("shows the information panel with no preview, when the host supplies none", async () => {
    // `renderPreview` is optional. A host that has no preview to give still
    // gets the name and the four facts, rather than an empty column or a crash.
    installHostBridge(() => [row("src/format.ts", "format.ts", { size: 128 })]);
    render(
      <FinderOverlay directory="/project" onChoose={() => undefined} onClose={() => undefined} />,
    );
    await act(async () => undefined);
    await type("fmt");
    await waitFor(() => expect(screen.getByTestId("finder-info")).toBeTruthy());

    expect(screen.getByTestId("finder-info-name").textContent).toBe("format.ts");
    expect(screen.getByTestId("finder-info-facts").textContent).toContain("128 B");
    expect(screen.getByTestId("finder-info-preview").textContent).toBe("");
  });

  it("draws the host's own preview when it supplies one", async () => {
    // Paired with the case above, so an overlay that ignored `renderPreview`
    // entirely could not pass both.
    installHostBridge(() => [row("src/format.ts", "format.ts")]);
    render(
      <FinderOverlay
        directory="/project"
        onChoose={() => undefined}
        onClose={() => undefined}
        renderPreview={(path) => <span data-testid="host-preview">{path}</span>}
      />,
    );
    await act(async () => undefined);
    await type("fmt");
    await waitFor(() => expect(screen.getByTestId("host-preview")).toBeTruthy());

    expect(screen.getByTestId("host-preview").textContent).toBe("/project/src/format.ts");
  });
});

describe("the host's handlers are called exactly once", () => {
  it("closes once on an Escape typed into the field, not twice", async () => {
    // The overlay handles Escape on the field AND listens at the window as a
    // backstop, and the event bubbles from one to the other. The file manager
    // never noticed because its close handler is a `setState(false)`; a host
    // that pops a stack or restores a focus would.
    const log = installHostBridge(() => []);
    render(
      <FinderOverlay
        directory="/project"
        onChoose={(path, isDir) => log.chosen.push({ path, isDir })}
        onClose={() => log.closed.push(1)}
      />,
    );
    await act(async () => undefined);

    fireEvent.keyDown(screen.getByTestId("finder-query"), { key: "Escape" });
    expect(log.closed).toHaveLength(1);
  });

  it("still closes when Escape arrives at the window instead", async () => {
    // Paired with the case above, so a fix that simply removed the backstop
    // could not pass both. The backstop is what makes the dialog closable at
    // all once focus has left the field — the zoxide popup was once
    // UNCLOSABLE by keyboard for exactly that reason.
    const log = installHostBridge(() => []);
    render(
      <FinderOverlay
        directory="/project"
        onChoose={(path, isDir) => log.chosen.push({ path, isDir })}
        onClose={() => log.closed.push(1)}
      />,
    );
    await act(async () => undefined);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(log.closed).toHaveLength(1);
  });
});
