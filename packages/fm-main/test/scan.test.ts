import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scanDirectory } from "../src/fs/scan.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "symfm-scan-"));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "alpha.txt"), "twelve bytes");
  await writeFile(join(root, ".hidden"), "x");
  await symlink(join(root, "alpha.txt"), join(root, "link.txt"));
  await symlink(join(root, "nowhere"), join(root, "broken.txt"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * The best of several runs.
 *
 * A single timed run measures the machine's spare capacity as much as the
 * implementation. Verification caught this exactly: on an idle box the scan
 * measures 42-48 ms, and under real contention — a headless browser at 1000%
 * CPU, an install running, load average 11-14 — the same code measured 130 ms
 * and the assertion failed. The code had not changed.
 *
 * Taking the best run measures the floor, which is the property these budgets
 * are actually about. A flaky assertion is a defect, and a loose one that never
 * fires is worse than an honest one that does.
 */
async function fastestScan(path: string, runs = 5): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await scanDirectory(path);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Two directories timed in alternation, best-of-N each.
 *
 * Alternating rather than batching is what keeps the RATIO honest: whatever the
 * machine is doing, both sides get the same share of it. Taking all of one and
 * then all of the other lets a burst of load land on one side alone.
 */
async function interleavedScans(
  plain: string,
  links: string,
  runs = 5,
): Promise<{ baseline: number; withLinks: number }> {
  let baseline = Number.POSITIVE_INFINITY;
  let withLinks = Number.POSITIVE_INFINITY;

  for (let i = 0; i < runs; i++) {
    const startedPlain = performance.now();
    await scanDirectory(plain);
    baseline = Math.min(baseline, performance.now() - startedPlain);

    const startedLinks = performance.now();
    await scanDirectory(links);
    withLinks = Math.min(withLinks, performance.now() - startedLinks);
  }
  return { baseline, withLinks };
}

/**
 * The floor the scan is measured against: the syscalls it cannot avoid.
 *
 * One `readdir` plus one `lstat` per entry, issued in the same bounded batches
 * the scan uses, and nothing else — no sorting, no filtering, no entry objects.
 * Measured with the same best-of-N as the scan, in the same conditions, so a
 * loaded machine slows both sides and the ratio between them stays honest.
 */
async function fastestRawWalk(path: string, runs = 5): Promise<number> {
  let best = Number.POSITIVE_INFINITY;

  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const names = await readdir(path);
    for (let from = 0; from < names.length; from += RAW_BATCH) {
      await Promise.all(
        names
          .slice(from, from + RAW_BATCH)
          .map((name) => lstat(join(path, name)).catch(() => null)),
      );
    }
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** The scan's own batch width (`BATCH` in scan.ts), so the baseline pays the same queueing cost. */
const RAW_BATCH = 512;

describe("scanDirectory", () => {
  it("reports name, kind, size, modification time and symlink status", async () => {
    const entries = await scanDirectory(root);
    const byName = new Map(entries.map((e) => [e.name, e]));

    const alpha = byName.get("alpha.txt");
    expect(alpha?.kind).toBe("file");
    expect(alpha?.size).toBe(12);
    expect(alpha?.modifiedMs).toBeGreaterThan(0);
    expect(alpha?.isSymlink).toBe(false);

    expect(byName.get("sub")?.kind).toBe("directory");
    expect(byName.get("link.txt")?.isSymlink).toBe(true);
    // A link's kind is its TARGET's kind, so a symlinked directory can be
    // walked into. Reporting `other` for every link would make that impossible.
    expect(byName.get("link.txt")?.kind).toBe("file");
  });

  it("marks a dotfile hidden without dropping it", async () => {
    const entries = await scanDirectory(root);
    const hidden = entries.find((e) => e.name === ".hidden");

    // Filtering is a separate decision, made by the view. The scan reports.
    expect(hidden).toBeDefined();
    expect(hidden?.isHidden).toBe(true);
  });

  it("survives a broken symlink instead of throwing", async () => {
    // `lstat` succeeds on a dangling link; a `stat` would throw ENOENT and take
    // the whole directory listing down with it.
    const entries = await scanDirectory(root);
    const broken = entries.find((e) => e.name === "broken.txt");

    expect(broken).toBeDefined();
    expect(broken?.isSymlink).toBe(true);
  });

  it("reports a directory that cannot be read as an error, not a crash", async () => {
    await expect(scanDirectory(join(root, "does-not-exist"))).rejects.toThrow();
  });

  it("refuses immediately when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(scanDirectory(root, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("scanDirectory cancels in flight, not only at the ends", () => {
  let big: string;

  beforeAll(async () => {
    big = await mkdtemp(join(tmpdir(), "symfm-abort-"));
    await Promise.all(
      Array.from({ length: 6000 }, (_, i) => writeFile(join(big, `e-${i}.txt`), "x")),
    );
    await scanDirectory(big);
  }, 120_000);

  afterAll(async () => {
    await rm(big, { recursive: true, force: true });
  });

  it("stops soon after the signal fires, rather than finishing first", async () => {
    // Verification found the earlier implementation dispatched every `lstat` in
    // one `Promise.all`, so an abort raised mid-scan still waited 17-24 ms for
    // all of them to settle. The old test only aborted BEFORE the call, so it
    // never demonstrated the cancellation its own comment claimed. Batching
    // gives the signal a seam to be seen at.
    const controller = new AbortController();
    const started = performance.now();
    const scan = scanDirectory(big, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await expect(scan).rejects.toThrow();
    // A full scan measures 42-48 ms. Settling well inside that proves the run
    // was cut short rather than allowed to complete.
    expect(performance.now() - started).toBeLessThan(30);
  });
});

describe("scanDirectory, symlink kinds", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "symfm-links-"));
    await mkdir(join(base, "target-dir"));
    await writeFile(join(base, "target-file"), "x");
    await symlink(join(base, "target-dir"), join(base, "to-dir"));
    await symlink(join(base, "target-file"), join(base, "to-file"));
    await symlink(join(base, "gone"), join(base, "to-nowhere"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reports a link to a directory as a directory, so it can be entered", async () => {
    const byName = new Map((await scanDirectory(base)).map((e) => [e.name, e]));

    expect(byName.get("to-dir")?.kind).toBe("directory");
    expect(byName.get("to-dir")?.isSymlink).toBe(true);
  });

  it("reports a link to a file as a file", async () => {
    const byName = new Map((await scanDirectory(base)).map((e) => [e.name, e]));

    expect(byName.get("to-file")?.kind).toBe("file");
  });

  it("reports a broken link as other, and still lists it", async () => {
    const byName = new Map((await scanDirectory(base)).map((e) => [e.name, e]));

    expect(byName.get("to-nowhere")?.kind).toBe("other");
    expect(byName.get("to-nowhere")?.isSymlink).toBe(true);
  });
});

describe("scanDirectory at scale, a directory of symlinks", () => {
  let links: string;

  beforeAll(async () => {
    // The case verification found: 6000 links measured 84-117 ms against a
    // 100 ms budget, because each one cost `lstat` for the size plus `stat` for
    // the target's kind. A file manager shows a link's TARGET size anyway, so
    // `stat` alone answers both and `lstat` is needed only when the link is
    // broken. Re-measured after that change: 42-52 ms, level with plain files.
    links = await mkdtemp(join(tmpdir(), "symfm-links-scale-"));
    await mkdir(join(links, "t"));
    await writeFile(join(links, "tf"), "x");
    await Promise.all(
      Array.from({ length: 6000 }, (_, i) =>
        symlink(join(links, i % 2 === 0 ? "t" : "tf"), join(links, `l-${i}`)),
      ),
    );
    await scanDirectory(links);
  }, 120_000);

  afterAll(async () => {
    await rm(links, { recursive: true, force: true });
  });

  it("costs no more than a directory of plain files", async () => {
    // Measured as a RATIO against plain files built the same way, not against a
    // wall-clock ceiling.
    //
    // This assertion used to read `elapsed < 100`, and it was flaky by
    // construction: the same code measured 42 ms on an idle machine and 104 ms
    // with a build running beside it, so the suite failed for load rather than
    // for a regression. The defect it exists to catch — `lstat` for the size
    // plus `stat` for the target's kind, two syscalls per link — roughly
    // DOUBLES the cost, which a ratio catches on any machine and a millisecond
    // budget catches only on a quiet one.
    const plain = await mkdtemp(join(tmpdir(), "symfm-links-baseline-"));
    try {
      await Promise.all(
        Array.from({ length: 6000 }, (_, i) => writeFile(join(plain, `entry-${i}.txt`), "x")),
      );
      await scanDirectory(plain);

      // Best-of-N on both sides, INTERLEAVED.
      //
      // It used to take five baseline samples and then five link samples, and
      // that is what made it flake: a machine that got busy between the two
      // batches inflated the second one and the ratio with it. Measured on this
      // box, the ratio ran 0.93-1.29 quiet and reached 1.63 against a 1.6
      // threshold in a full parallel suite — while the defect it guards costs a
      // factor of two. Widening the threshold would have bought the same flake
      // a little later and blunted the guard; alternating the two measurements
      // makes both sides see the same conditions, which is the actual fix.
      const { baseline, withLinks } = await interleavedScans(plain, links);

      // 6000 links plus the two targets they point at.
      expect(await scanDirectory(links)).toHaveLength(6002);
      // 1.6, not 1.0: scheduling noise is real and the regression is a factor
      // of two. A threshold that fails at 1.05 would be the same flake again.
      expect(withLinks / baseline).toBeLessThan(1.6);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  }, 120_000);

  it("still resolves each link to its target kind", async () => {
    const entries = await scanDirectory(links);
    const dirs = entries.filter((e) => e.kind === "directory" && e.isSymlink);

    expect(dirs).toHaveLength(3000);
  });
});

describe("scanDirectory at scale", () => {
  let big: string;

  beforeAll(async () => {
    big = await mkdtemp(join(tmpdir(), "symfm-big-"));
    await Promise.all(
      Array.from({ length: 6000 }, (_, i) => writeFile(join(big, `entry-${i}.txt`), "x")),
    );
    // Warm the cache: the budget below is about the implementation, not disk.
    await scanDirectory(big);
  }, 120_000);

  afterAll(async () => {
    await rm(big, { recursive: true, force: true });
  });

  it("lists six thousand entries without costing more than the syscalls do", async () => {
    const entries = await scanDirectory(big);

    expect(entries).toHaveLength(6000);

    // ── Why this is a ratio and not `elapsed < 100` ─────────────────────────
    // It WAS `elapsed < 100`, with a comment stating the budget carried better
    // than 2x headroom and would not flake. It flaked: 146 ms, in a full suite
    // run where 28 other files compete for the CPU and for libuv's four-thread
    // pool. The same assertion passed 3 out of 3 alone, at well under budget,
    // with the implementation untouched — so it was measuring the machine's
    // spare capacity, exactly as the symlink budget forty lines above was
    // measuring it before that one was converted to a ratio for the same
    // reason. Two absolute budgets in one file, one already known to be wrong:
    // this is the second.
    //
    // What the budget is FOR is unchanged and is still enforced: it fails if
    // someone rewrites the batched fill as a serial `for await` loop. The
    // baseline below is the raw work the scan cannot avoid — one `readdir`
    // plus one `lstat` per entry, issued the same batched way — so it moves
    // with the machine and the ratio does not. A serial rewrite costs many
    // times the baseline; the batched fill costs a small multiple of it.
    const baseline = await fastestRawWalk(big);
    const elapsed = await fastestScan(big);

    expect(elapsed / baseline).toBeLessThan(4);
  });
});
