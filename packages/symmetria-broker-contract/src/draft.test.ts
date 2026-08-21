import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  expectGoldenRoundTrip,
  formatGoldenDocument,
  readGoldenFixture,
  readGoldenFixtureSource,
  without,
} from "../test/goldenFixture.ts";
import {
  SYMMETRIA_DRAFT_EXCLUDED_FIELDS,
  SymmetriaDraft,
  SymmetriaDraftUpdate,
  SymmetriaDraftUpdateResult,
  applySymmetriaDraftUpdate,
  type SymmetriaDraftUpdateApplied,
  type SymmetriaDraftUpdateConflict,
} from "./draft.ts";

const GOLDEN = "draft.golden.json";
const CONFLICT = "draft.conflict.json";
const DRAFT_SET = "command.draftSet.json";

const decodeDraft = Schema.decodeUnknownResult(SymmetriaDraft);
const decodeDraftOrThrow = Schema.decodeUnknownSync(SymmetriaDraft);
const encodeDraft = Schema.encodeSync(SymmetriaDraft);
const decodeUpdate = Schema.decodeUnknownResult(SymmetriaDraftUpdate);
const decodeUpdateOrThrow = Schema.decodeUnknownSync(SymmetriaDraftUpdate);
const decodeResult = Schema.decodeUnknownResult(SymmetriaDraftUpdateResult);
const decodeResultOrThrow = Schema.decodeUnknownSync(SymmetriaDraftUpdateResult);
const encodeResult = Schema.encodeSync(SymmetriaDraftUpdateResult);

const currentDraft = () => decodeDraftOrThrow(readGoldenFixture(GOLDEN));

/** The golden draft-set command, re-aimed at one expectation. */
const updateExpecting = (expectedVersion: number, text?: string) =>
  decodeUpdateOrThrow({
    ...readGoldenFixture(DRAFT_SET),
    expectedVersion,
    ...(text === undefined ? {} : { text }),
  });

describe("SymmetriaDraft", () => {
  it("round-trips the golden fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaDraft, GOLDEN);
  });

  it("carries a monotonic version and refuses anything that is not one", () => {
    const golden = readGoldenFixture(GOLDEN);
    expect(currentDraft().version).toBe(golden["version"]);
    for (const version of [-1, 1.5, "7"]) {
      expect(Result.isFailure(decodeDraft({ ...golden, version }))).toBe(true);
    }
    expect(Result.isFailure(decodeDraft(without(golden, "version")))).toBe(true);
  });

  it("accepts an empty composer, which is how a shell clears what it wrote", () => {
    expect(Result.isSuccess(decodeDraft({ ...readGoldenFixture(GOLDEN), text: "" }))).toBe(true);
  });

  it("keeps the body to composer fields in both directions", () => {
    const golden = readGoldenFixture(GOLDEN);
    const leaky = {
      ...golden,
      messages: [{ id: "message-1", text: "private message" }],
      transcript: [{ role: "user", text: "private message" }],
      providerPayload: { secret: "provider-native" },
      attachments: [{ dataUrl: "data:image/png;base64,AAAA" }],
      images: [{ dataUrl: "data:image/png;base64,AAAA" }],
    };
    // Both directions, because a producer that builds a draft from the client
    // store encodes one as often as it decodes one. The cast is the point of
    // the second half: it stands for a producer handing the encoder a value
    // fatter than this schema names, which is the mistake the allowlist has to
    // catch on the way out too.
    const encoded = encodeDraft(leaky as unknown as SymmetriaDraft);
    for (const value of [decodeDraftOrThrow(leaky), encoded]) {
      for (const field of SYMMETRIA_DRAFT_EXCLUDED_FIELDS) {
        expect(Object.hasOwn(value, field)).toBe(false);
      }
      expect(Object.keys(value).sort()).toEqual(["text", "threadId", "updatedAt", "version"]);
    }
  });
});

describe("SymmetriaDraftUpdate", () => {
  it("is the draft-set command rather than a second shape beside it", () => {
    // One wire shape for one write. Two would state the compare-and-set rule
    // twice, and two statements of one rule drift.
    expect(Result.isSuccess(decodeUpdate(readGoldenFixture(DRAFT_SET)))).toBe(true);
  });

  it("requires the version it expects", () => {
    const draftSet = readGoldenFixture(DRAFT_SET);
    expect(Result.isFailure(decodeUpdate(without(draftSet, "expectedVersion")))).toBe(true);
    expect(Result.isFailure(decodeUpdate({ ...draftSet, expectedVersion: null }))).toBe(true);
    expect(Result.isFailure(decodeUpdate({ ...draftSet, expectedVersion: -1 }))).toBe(true);
  });
});

describe("applySymmetriaDraftUpdate", () => {
  it("applies a matching expectation and advances the version by exactly one", () => {
    const current = currentDraft();
    const update = updateExpecting(current.version, "check the diff before we revert");
    const result = applySymmetriaDraftUpdate(current, update);

    expect(result.outcome).toBe("applied");
    const applied = result as SymmetriaDraftUpdateApplied;
    expect(applied.draft.version).toBe(current.version + 1);
    expect(applied.draft.text).toBe("check the diff before we revert");
    expect(applied.draft.threadId).toBe(current.threadId);
    // The helper holds no clock: the applied draft is stamped with the moment
    // the update states it was created.
    expect(applied.draft.updatedAt).toBe(update.createdAt);
  });

  it("never records a moment earlier than the draft it replaced", () => {
    // A shell with a skewed clock, or one that stamps `createdAt` when the user
    // started typing rather than when it sent, would otherwise make a thread's
    // last-edited label go backwards on the newest edit.
    const current = currentDraft();
    const skewed = decodeUpdateOrThrow({
      ...readGoldenFixture(DRAFT_SET),
      expectedVersion: current.version,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const applied = applySymmetriaDraftUpdate(current, skewed) as SymmetriaDraftUpdateApplied;
    expect(applied.draft.version).toBe(current.version + 1);
    expect(applied.draft.updatedAt).toBe(current.updatedAt);
  });

  it("refuses an update addressed to another thread", () => {
    // Words landing in a thread nobody addressed is the failure the whole
    // projection exists to remove, and this helper is the one place that sees
    // both names.
    const current = currentDraft();
    const elsewhere = decodeUpdateOrThrow({
      ...readGoldenFixture(DRAFT_SET),
      threadId: "thr_ffffffff",
      expectedVersion: current.version,
      text: "words meant for another thread",
    });
    const result = applySymmetriaDraftUpdate(current, elsewhere);

    expect(result.outcome).toBe("conflict");
    const conflict = result as SymmetriaDraftUpdateConflict;
    expect(conflict.currentDraft.threadId).toBe(current.threadId);
    expect(conflict.currentDraft.text).toBe(current.text);
  });

  it("refuses a stale expectation with the current version and the current body", () => {
    const current = currentDraft();
    const result = applySymmetriaDraftUpdate(current, updateExpecting(current.version - 1));

    expect(result.outcome).toBe("conflict");
    const conflict = result as SymmetriaDraftUpdateConflict;
    expect(conflict.currentVersion).toBe(current.version);
    // The body, not only the number: the surface that lost the race should not
    // need a second round trip before it can re-render.
    expect(conflict.currentDraft).toEqual(current);
  });

  it("refuses an expectation ahead of the current version", () => {
    // A caller claiming a version the producer never issued knows less about
    // this draft than a stale caller does. Accepting it would write a body
    // derived from a draft that never existed.
    const current = currentDraft();
    const result = applySymmetriaDraftUpdate(current, updateExpecting(current.version + 1));

    expect(result.outcome).toBe("conflict");
    expect((result as SymmetriaDraftUpdateConflict).currentVersion).toBe(current.version);
  });

  it("writes nothing at all on a conflict", () => {
    const current = currentDraft();
    const conflict = applySymmetriaDraftUpdate(
      current,
      updateExpecting(current.version - 1, "words that must not land"),
    ) as SymmetriaDraftUpdateConflict;
    expect(conflict.currentDraft.text).toBe(current.text);
    expect(conflict.currentDraft.version).toBe(current.version);
  });
});

describe("SymmetriaDraftUpdateResult", () => {
  it("round-trips the conflict fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaDraftUpdateResult, CONFLICT);
  });

  it("encodes the refused update this contract produces to that fixture", () => {
    const current = currentDraft();
    const result = applySymmetriaDraftUpdate(current, updateExpecting(current.version - 1));
    const encoded = encodeResult(decodeResultOrThrow(result));
    expect(formatGoldenDocument(encoded)).toBe(readGoldenFixtureSource(CONFLICT));
  });

  it("refuses a conflict whose two versions disagree", () => {
    // The restatement is for the consumer's convenience; a restated fact that
    // nothing checks is a fact that drifts, and a consumer retrying at the
    // wrong number conflicts forever.
    const conflict = readGoldenFixture(CONFLICT);
    expect(Result.isFailure(decodeResult({ ...conflict, currentVersion: 99 }))).toBe(true);
    expect(Result.isSuccess(decodeResult(conflict))).toBe(true);
  });

  it("branches on the outcome tag alone", () => {
    const conflict = readGoldenFixture(CONFLICT);
    expect(Result.isFailure(decodeResult({ ...conflict, outcome: "rejected" }))).toBe(true);
    expect(Result.isFailure(decodeResult(without(conflict, "currentVersion")))).toBe(true);
  });
});
