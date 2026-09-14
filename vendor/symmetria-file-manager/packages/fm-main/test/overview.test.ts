import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { decodeOverviewRequest } from "../../fm-core/src/overview/contract.ts";
import { readOverviewDirectory } from "../src/fs/overview.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
  roots.length = 0;
});
it("keeps directory symlinks visible as leaves", async () => {
  const root = await mkdtemp(join(tmpdir(), "overview-"));
  roots.push(root);
  await mkdir(join(root, "target"));
  await symlink(join(root, "target"), join(root, "link"));
  const result = await readOverviewDirectory(root, 10);
  expect(result.entries.find((entry) => entry.name === "link")).toMatchObject({
    isSymlink: true,
    kind: "other",
  });
});
it("rejects malformed requests before filesystem work", () => {
  for (const request of [
    null,
    {},
    { path: "relative", requestId: "x", limit: 1 },
    { path: "/", requestId: "x", limit: 1001 },
    { path: "/", requestId: "", limit: 1 },
  ])
    expect(decodeOverviewRequest(request).ok).toBe(false);
});
it("bounds inspected entries without full metadata scanning", async () => {
  const root = await mkdtemp(join(tmpdir(), "overview-"));
  roots.push(root);
  await Promise.all(Array.from({ length: 12 }, (_, i) => writeFile(join(root, String(i)), "")));
  const result = await readOverviewDirectory(root, 5);
  expect(result.inspected).toBe(5);
  expect(result.entries).toHaveLength(5);
  expect(result.truncated).toBe(true);
});
