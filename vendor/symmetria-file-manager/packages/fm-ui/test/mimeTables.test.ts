import { existsSync, readFileSync } from "node:fs";

import { type PreviewTarget, routePreview } from "@symmetria/fm-core/preview/route";
import { describe, expect, it } from "vitest";

import { RENDERER_TABLES } from "../src/usePreview.ts";

/**
 * The panel's hand-written MIME table, against the system's real one.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `usePreview.ts` hands the router a small table instead of the several
 * thousand rows the database holds. Every other test in this repository builds
 * its own table, so an edge in that one can be WRONG and nothing notices.
 *
 * One was. `application/x-compressed-tar` was listed as inheriting from
 * `application/x-tar`; the database says `application/gzip`. Every `.tar.gz`
 * routed as an uncompressed tar, the reader was handed gzip bytes, and the pane
 * said it could not read the archive — while the whole suite stayed green. It
 * took launching the real application to see it.
 *
 * ── Why it skips rather than fails without a database ───────────────────────
 * `shared-mime-info` is not guaranteed on every machine a checkout lands on. A
 * test that fails there would be reporting the absence of a package as a defect
 * in the panel. Skipping is honest; the first assertion below is what stops the
 * whole suite from passing vacuously by finding nothing to check.
 */

const SUBCLASSES = "/usr/share/mime/subclasses";

/**
 * Edges the panel adds on purpose, where the database routes differently.
 *
 * Each of these exists to make a file preview as CODE. The database's own path
 * does not reach `text/plain` for either, so following it strictly would send
 * both to the content sniff — which happens to answer "text" anyway, so the
 * shortcut buys a direct answer rather than a different one.
 *
 * They are listed rather than tolerated silently, because that is the whole
 * difference between a deliberate divergence and the one that broke `.tar.gz`.
 * **Adding to this list is a decision; a new entry needs a reason on this
 * comment.**
 */
const DELIBERATE_SHORTCUTS: ReadonlyMap<string, string> = new Map([
  // The database says `application/json` inherits from `application/json5`,
  // which leads nowhere useful. The panel routes it through JavaScript, which
  // does reach `text/plain`.
  ["application/json", "application/javascript"],
  // The database says `text/x-shellscript` inherits from
  // `application/x-executable` — true, and the opposite of helpful for a
  // preview. A script is text and should highlight as one.
  ["text/x-shellscript", "text/plain"],
]);

/** `child parent` per line, as shared-mime-info writes it. */
function realEdges(): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const line of readFileSync(SUBCLASSES, "utf8").split("\n")) {
    const [child, parent] = line.split(" ");
    if (child === undefined || parent === undefined) continue;
    const parents = edges.get(child) ?? new Set<string>();
    parents.add(parent);
    edges.set(child, parents);
  }
  return edges;
}

describe.skipIf(!existsSync(SUBCLASSES))("the panel's MIME table agrees with the system's", () => {
  it("has edges to check, so this suite cannot pass by finding nothing", () => {
    expect(RENDERER_TABLES.subclasses.size).toBeGreaterThan(5);
    expect(realEdges().size).toBeGreaterThan(100);
  });

  it.each([...RENDERER_TABLES.subclasses].map(([child, parents]) => [child, parents] as const))(
    "%s inherits from what the database says it does",
    (child, parents) => {
      const real = realEdges().get(child);
      // A type the database does not know is not an error — the panel may
      // reasonably carry an edge for something this machine has no rule for,
      // and an alias is recorded elsewhere in the database entirely.
      if (real === undefined) return;

      for (const parent of parents) {
        if (DELIBERATE_SHORTCUTS.get(child) === parent) continue;
        expect([...real]).toContain(parent);
      }
    },
  );
});

/**
 * What the panel's own table makes the router answer.
 *
 * ── Why this exists BESIDE the comparison above ─────────────────────────────
 * That one reads `/usr/share/mime/subclasses` and skips where it is absent, so
 * on a machine without `shared-mime-info` it guarantees nothing — and review
 * pointed out this repository has no TypeScript CI job at all yet, so today it
 * runs on one workstation. These cases need no database and always run.
 *
 * They are OUTCOMES rather than edges on purpose. A checked-in copy of the
 * database would be a THIRD hand-written table of the same facts, which is
 * precisely the disease: the `.tar.gz` defect existed because one table said
 * `application/x-compressed-tar` inherits from `application/x-tar` while
 * another said `application/gzip`. Asserting where a type ends up is the one
 * form that cannot rot into a fourth opinion.
 */

function target(mime: string): PreviewTarget {
  return {
    name: "thing",
    path: "/tmp/thing",
    isDirectory: false,
    entryCount: 0,
    entries: [],
    size: 4096,
    mime,
    head: new Uint8Array([0x00, 0x01, 0x02]),
  };
}

describe("the panel's table routes these types where they belong", () => {
  it.each([
    // The defect. A `.tar.gz` is a gzip to the database, and reading one as a
    // plain tar hands the walker compressed bytes and fails every time.
    ["application/x-compressed-tar", { format: "tar", compression: "gzip" }],
    ["application/gzip", { format: "tar", compression: "gzip" }],
    ["application/x-tar", { format: "tar", compression: "none" }],
    ["application/zip", { format: "zip", compression: "none" }],
  ])("routes %s as an archive read the right way", (mime, expected) => {
    expect(routePreview(RENDERER_TABLES, target(mime))).toEqual({
      kind: "archive",
      mime,
      ...expected,
    });
  });

  it.each([
    "application/x-xz-compressed-tar",
    "application/x-bzip2-compressed-tar",
    "application/x-zstd-compressed-tar",
    "application/x-7z-compressed",
    "application/vnd.rar",
  ])("says %s has no preview rather than letting it fall through", (mime) => {
    expect(routePreview(RENDERER_TABLES, target(mime))).toEqual({
      kind: "unbuilt",
      what: "archive",
      mime,
    });
  });

  it.each(["application/json", "text/x-shellscript", "text/markdown"])(
    "still treats %s as something to read",
    (mime) => {
      // The deliberate shortcuts above earn their place here: without them
      // these reach the content sniff instead of the code branch.
      expect(routePreview(RENDERER_TABLES, { ...target(mime), name: "thing.json" }).kind).not.toBe(
        "fallback",
      );
    },
  );
});
