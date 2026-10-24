import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveExternalWebLinkHref, showExternalLinkContextMenu } from "./externalLinkContextMenu";

function createHarness(
  selection:
    | "open-in-preview"
    | "open-external"
    | "copy-link"
    | "link-to-thread"
    | "unlink-from-thread"
    | null,
) {
  const showContextMenu = vi.fn().mockResolvedValue(selection);
  const openInPreview = vi.fn().mockResolvedValue(undefined);
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const copyLink = vi.fn().mockResolvedValue(undefined);
  const updateThreadLink = vi.fn().mockResolvedValue(undefined);
  const reportFailure = vi.fn();

  return {
    showContextMenu,
    openInPreview,
    openExternal,
    copyLink,
    updateThreadLink,
    reportFailure,
  };
}

describe("external chat link context menu", () => {
  it.each([
    [
      "https://example.com/docs?topic=security#links",
      "https://example.com/docs?topic=security#links",
    ],
    ["HTTP://EXAMPLE.COM", "http://example.com/"],
    ["//example.com/path", "https://example.com/path"],
  ])("resolves the safe external web-link href for %s as %s", (href, expected) => {
    expect(resolveExternalWebLinkHref(href)).toBe(expected);
  });

  it.each([
    "javascript:alert(document.domain)",
    " \nJaVaScRiPt:alert(document.domain)",
    "data:text/html,<script>alert(document.domain)</script>",
    "file:///tmp/example.txt",
    "mailto:hello@example.com",
    "/relative/path",
    "not a URL",
    "",
  ])("rejects unsafe external web-link href %s", (href) => {
    expect(resolveExternalWebLinkHref(href)).toBeNull();
  });
});

afterEach(() => vi.unstubAllGlobals());

it.each([
  [767, false],
  [1280, true],
] as const)(
  "chat link menu policy: width %s coarse %s hides explicit app and rejects stale native selection",
  async (innerWidth, coarse) => {
    vi.stubGlobal("window", { innerWidth, matchMedia: () => ({ matches: coarse }) });
    const harness = createHarness("open-in-preview");
    const href = "https://example.com/docs";
    await showExternalLinkContextMenu({ href, position: { x: 1, y: 2 }, ...harness });
    expect(
      harness.showContextMenu.mock.calls[0]?.[0].map((item: { id: string }) => item.id),
    ).toEqual(["open-external", "copy-link"]);
    expect(harness.openInPreview).not.toHaveBeenCalled();
    expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith(href);
  },
);

it("chat link menu policy: a pending desktop app selection uses system after a viewport change", async () => {
  let width = 1280;
  vi.stubGlobal("window", {
    get innerWidth() {
      return width;
    },
    matchMedia: () => ({ matches: false }),
  });
  const harness = createHarness(null);
  let choose = () => {};
  harness.showContextMenu.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        choose = () => resolve("open-in-preview");
      }),
  );
  const href = "https://example.com/docs";
  const selecting = showExternalLinkContextMenu({ href, position: { x: 1, y: 2 }, ...harness });
  expect(
    harness.showContextMenu.mock.calls[0]?.[0].map((item: { id: string }) => item.id),
  ).toContain("open-in-preview");
  width = 767;
  choose();
  await selecting;
  expect(harness.openInPreview).not.toHaveBeenCalled();
  expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith(href);
});

it("chat link menu policy: a rejected stale phone open reports the actual system operation", async () => {
  vi.stubGlobal("window", { innerWidth: 767, matchMedia: () => ({ matches: false }) });
  const harness = createHarness("open-in-preview");
  const failure = new Error("System browser unavailable");
  harness.openExternal.mockRejectedValueOnce(failure);
  await showExternalLinkContextMenu({
    href: "https://example.com",
    position: { x: 1, y: 2 },
    ...harness,
  });
  expect(harness.reportFailure).toHaveBeenCalledExactlyOnceWith("open-link-external", failure);
  expect(harness.openInPreview).not.toHaveBeenCalled();
});
