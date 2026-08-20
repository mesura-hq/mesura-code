import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { expectGoldenRoundTrip, readGoldenFixture } from "../test/goldenFixture.ts";
import {
  SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS,
  SymmetriaThreadSummary,
} from "./threadSummary.ts";

const GOLDEN = "threadSummary.golden.json";

const decode = Schema.decodeUnknownResult(SymmetriaThreadSummary);
const decodeOrThrow = Schema.decodeUnknownSync(SymmetriaThreadSummary);

/**
 * Keys that name an address which is reused as processes and panes come and go.
 * Delivering to one of these is the defect the whole projection replaces, so a
 * summary that grows such a field has to fail here rather than at a microphone.
 */
const EPHEMERAL_ADDRESS_FRAGMENTS = ["processid", "pid", "pane", "slot"];

const collectKeyPaths = (value: unknown, path = ""): ReadonlyArray<string> => {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path === "" ? key : `${path}.${key}`;
    return [here, ...collectKeyPaths(child, here)];
  });
};

describe("SymmetriaThreadSummary", () => {
  it("round-trips the golden fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaThreadSummary, GOLDEN);
  });

  it("addresses a thread by threadId and projectId", () => {
    const golden = readGoldenFixture(GOLDEN);
    const decoded = decodeOrThrow(golden);
    expect(decoded.threadId).toBe(golden["threadId"]);
    expect(decoded.projectId).toBe(golden["projectId"]);
  });

  it("carries no process, pane, or slot address at any depth", () => {
    const decoded = decodeOrThrow(readGoldenFixture(GOLDEN));
    const offending = collectKeyPaths(decoded).filter((path) => {
      const key = (path.split(".").pop() ?? "").toLowerCase();
      return EPHEMERAL_ADDRESS_FRAGMENTS.some((fragment) => key.includes(fragment));
    });
    expect(offending).toEqual([]);
  });

  it("drops every excluded upstream field, at the root and nested", () => {
    const golden = readGoldenFixture(GOLDEN);
    const excluded = Object.fromEntries(
      SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS.map((field) => [
        field,
        [{ role: "user", text: "private" }],
      ]),
    );
    const decoded = decodeOrThrow({
      ...golden,
      ...excluded,
      latestTurn: { ...(golden["latestTurn"] as Record<string, unknown>), ...excluded },
      session: { ...(golden["session"] as Record<string, unknown>), ...excluded },
    });

    const paths = collectKeyPaths(decoded);
    for (const field of SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS) {
      const leaked = paths.filter((path) => (path.split(".").pop() ?? "") === field);
      expect(leaked, `${field} crossed the allowlist`).toEqual([]);
    }
  });

  it("keeps worktreePath nullable", () => {
    const golden = readGoldenFixture(GOLDEN);
    const decoded = decode({ ...golden, worktreePath: null });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.worktreePath).toBe(null);
    }
  });

  it("refuses a summary that omits worktreePath or renames it", () => {
    const golden = readGoldenFixture(GOLDEN);
    const { worktreePath, ...withoutWorktreePath } = golden;
    expect(Result.isFailure(decode(withoutWorktreePath))).toBe(true);
    expect(Result.isFailure(decode({ ...withoutWorktreePath, worktree: worktreePath }))).toBe(true);
  });

  it("refuses a summary that omits its addresses", () => {
    const golden = readGoldenFixture(GOLDEN);
    const { threadId, projectId, ...withoutAddresses } = golden;
    expect(Result.isFailure(decode({ ...withoutAddresses, projectId }))).toBe(true);
    expect(Result.isFailure(decode({ ...withoutAddresses, threadId }))).toBe(true);
  });
});
