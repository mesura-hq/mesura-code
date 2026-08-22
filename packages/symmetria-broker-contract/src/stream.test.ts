import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { expectGoldenRoundTrip, readGoldenFixture, without } from "../test/goldenFixture.ts";
import { SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS } from "./threadSummary.ts";
import {
  SYMMETRIA_STREAM_CHANGE_ENTITIES,
  SYMMETRIA_STREAM_ITEM_TYPES,
  SymmetriaStreamChange,
  SymmetriaStreamItem,
  applySymmetriaStreamDelta,
  decodeSymmetriaStreamItem,
  openSymmetriaStream,
  type SymmetriaStreamChangeEntity,
  type SymmetriaStreamDelta,
  type SymmetriaStreamDeltaGap,
  type SymmetriaStreamState,
} from "./stream.ts";
import { SYMMETRIA_PROTOCOL_MAJOR } from "./version.ts";

const GOLDEN = "stream.snapshot.golden.json";
const UNKNOWN_FIELD = "stream.unknownField.json";
const UNSUPPORTED_MAJOR = "stream.unsupportedMajor.json";
const DUPLICATE = "stream.duplicate.json";
const REORDERED = "stream.reordered.json";

const decodeStreamItem = Schema.decodeUnknownResult(SymmetriaStreamItem);
const decodeStreamItemOrThrow = Schema.decodeUnknownSync(SymmetriaStreamItem);
const decodeChangeOrThrow = Schema.decodeUnknownSync(SymmetriaStreamChange);

/** The items of an adversarial fixture, as they sit on disk. */
const rawFixtureItems = (name: string): ReadonlyArray<Record<string, unknown>> =>
  readGoldenFixture(name)["items"] as ReadonlyArray<Record<string, unknown>>;

/** The items of an adversarial fixture, decoded in the order they arrive. */
const fixtureItems = (name: string): ReadonlyArray<SymmetriaStreamItem> =>
  rawFixtureItems(name).map((item) => decodeStreamItemOrThrow(item));

/** The state a fixture's opening snapshot produces, or a thrown failure. */
const openedFrom = (name: string): SymmetriaStreamState => {
  const opened = openSymmetriaStream(fixtureItems(name)[0] as SymmetriaStreamItem);
  if (Result.isFailure(opened)) {
    throw new Error(`${name} did not open: ${opened.failure._tag}`);
  }
  return opened.success;
};

const goldenSnapshot = () => decodeStreamItemOrThrow(readGoldenFixture(GOLDEN));

/** The first entry of one of the golden snapshot's entity lists, as it sits on disk. */
const goldenEntity = (list: "threads" | "surfaces" | "drafts" | "projects"): unknown =>
  (readGoldenFixture(GOLDEN)[list] as ReadonlyArray<unknown>)[0];

describe("SymmetriaStreamItem", () => {
  it("round-trips the golden snapshot byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaStreamItem, GOLDEN);
  });

  it("carries a revision on the snapshot and a sequence on the delta", () => {
    const golden = readGoldenFixture(GOLDEN);
    expect(Result.isFailure(decodeStreamItem(without(golden, "revision")))).toBe(true);

    const delta = rawFixtureItems(DUPLICATE)[1] as Record<string, unknown>;
    expect(Result.isFailure(decodeStreamItem(without(delta, "sequence")))).toBe(true);
  });

  it("refuses a position that is not a non-negative integer", () => {
    const golden = readGoldenFixture(GOLDEN);
    for (const revision of [-1, 1.5, "412", null]) {
      expect(Result.isFailure(decodeStreamItem({ ...golden, revision }))).toBe(true);
    }
  });

  it("admits exactly the two item types it publishes", () => {
    // The exported list and the union it names cannot drift apart in silence,
    // which is the assertion `command.test.ts` already makes over
    // `SYMMETRIA_COMMAND_TYPES`.
    const types = SymmetriaStreamItem.members.map((member) => member.fields.type.literal);
    expect([...types].sort()).toEqual([...SYMMETRIA_STREAM_ITEM_TYPES].sort());
  });

  it("admits exactly the change entities it publishes", () => {
    // Read by decoding rather than by reflection, because the fallback member
    // reaches its tag through a transformation and has no literal to inspect.
    // The exhaustive record is half the pin: a name added to the published list
    // has to be given a payload here, and the member count is the other half, so
    // neither the list nor the union can grow without the other.
    const probes: Record<SymmetriaStreamChangeEntity, unknown> = {
      thread: { entity: "thread", thread: goldenEntity("threads") },
      surface: { entity: "surface", surface: goldenEntity("surfaces") },
      draft: { entity: "draft", draft: goldenEntity("drafts") },
      project: { entity: "project", project: goldenEntity("projects") },
      // Was `project` until that entity became real in the 1.1 addition. Any
      // name this build does not publish serves; what is being exercised is
      // the fallback member, not this particular word.
      unknown: { entity: "sprocket", sprocket: { id: "spr_1" } },
    };

    expect(SymmetriaStreamChange.members).toHaveLength(SYMMETRIA_STREAM_CHANGE_ENTITIES.length);
    for (const entity of SYMMETRIA_STREAM_CHANGE_ENTITIES) {
      expect(decodeChangeOrThrow(probes[entity]).entity).toBe(entity);
    }
  });

  it("refuses a delta announcing a major this build does not speak", () => {
    // The exported schema is the decode path a consumer reaches for first, so it
    // has to hold the version rule on its own rather than leaving it to the gate.
    const delta = rawFixtureItems(DUPLICATE)[1] as Record<string, unknown>;
    expect(
      Result.isFailure(decodeStreamItem({ ...delta, protocolVersion: { major: 9, minor: 0 } })),
    ).toBe(true);
    expect(
      Result.isSuccess(decodeStreamItem({ ...delta, protocolVersion: { major: 1, minor: 4 } })),
    ).toBe(true);
    // A delta need not repeat what the opening snapshot settled.
    expect(Result.isSuccess(decodeStreamItem(delta))).toBe(true);
  });
});

describe("SymmetriaUnknownChange", () => {
  it("degrades an entity from a newer minor instead of refusing the delta", () => {
    // Refusing it would cost the consumer the position as well as the update:
    // the next in-order delta would read as a gap, and every occurrence would
    // force a full resnapshot.
    const item = decodeStreamItemOrThrow({
      type: "delta",
      sequence: 413,
      change: { entity: "sprocket", sprocket: { id: "spr_1" } },
    });
    if (item.type !== "delta") throw new Error("probe did not decode as a delta");
    expect(item.change.entity).toBe("unknown");
    expect(Object.hasOwn(item.change, "sprocket")).toBe(false);
  });

  it("still refuses a known entity whose body does not match it", () => {
    // The fallback must not swallow corruption: only a name this build has never
    // heard of reaches it.
    expect(
      Result.isFailure(
        decodeStreamItem({
          type: "delta",
          sequence: 413,
          change: { entity: "thread", thread: { threadId: "thr_9f3c1a7e" } },
        }),
      ),
    ).toBe(true);
  });

  it("consumes the position and writes nothing", () => {
    const state = openedFrom(DUPLICATE);
    const applied = applySymmetriaStreamDelta(
      state,
      decodeStreamItemOrThrow({
        type: "delta",
        sequence: state.sequence + 1,
        change: { entity: "sprocket", sprocket: { id: "spr_1" } },
      }) as SymmetriaStreamDelta,
    );

    expect(applied.outcome).toBe("applied");
    expect(applied.state.sequence).toBe(state.sequence + 1);
    expect(applied.state.threads).toEqual(state.threads);
    expect(applied.state.surfaces).toEqual(state.surfaces);
    expect(applied.state.drafts).toEqual(state.drafts);
  });
});

describe("openSymmetriaStream", () => {
  it("opens at the snapshot's revision, because a snapshot already reflects it", () => {
    const opened = openSymmetriaStream(goldenSnapshot());
    expect(Result.isSuccess(opened)).toBe(true);
    const state = (opened as { readonly success: SymmetriaStreamState }).success;
    expect(state.sequence).toBe(state.revision);
    expect(state.threads).toHaveLength(1);
    expect(state.surfaces).toHaveLength(1);
    expect(state.drafts).toHaveLength(1);
    expect(state.projects).toHaveLength(1);
  });

  it("refuses a delta as the first item and names the position it saw", () => {
    // A consumer that started mid-stream would fold changes into a world it
    // never received, and nothing later in the stream would tell it so.
    const delta = fixtureItems(DUPLICATE)[1] as SymmetriaStreamDelta;
    const opened = openSymmetriaStream(delta);

    expect(Result.isFailure(opened)).toBe(true);
    const failure = (opened as { readonly failure: { _tag: string; receivedSequence: number } })
      .failure;
    expect(failure._tag).toBe("SymmetriaStreamNotOpened");
    expect(failure.receivedSequence).toBe(delta.sequence);
  });
});

describe("decodeSymmetriaStreamItem", () => {
  it("accepts an additive unknown field and drops it at every depth", () => {
    // A newer minor is additive by definition, so the payload decodes; the field
    // is gone rather than carried, in the item, in a nested struct and inside an
    // array item. Asserting the absence is the point: a bare "it decoded" check
    // would pass while the field leaked through.
    const input = readGoldenFixture(UNKNOWN_FIELD);
    const decoded = decodeSymmetriaStreamItem(input);

    expect(Result.isSuccess(decoded)).toBe(true);
    const item = (decoded as { readonly success: SymmetriaStreamItem }).success;
    if (item.type !== "snapshot") throw new Error("unknown-field fixture is not a snapshot");

    expect(Object.hasOwn(input, "emittedAt")).toBe(true);
    expect(Object.hasOwn(item, "emittedAt")).toBe(false);
    expect(Object.hasOwn(item.threads[0] as object, "unreadCount")).toBe(false);
    expect(Object.hasOwn(item.surfaces[0] as object, "deviceLabel")).toBe(false);
    // One level deeper than the two above: a struct nested inside an array
    // element. Widening a projected struct there is how free-form content would
    // reach a shell past the allowlist, so the drop has to be pinned at that
    // depth and not only at the depths that are easy to reach.
    expect(Object.hasOwn(item.threads[0]?.latestTurn as object, "queuedBehind")).toBe(false);
    // The known fields are untouched by the drop.
    expect(item.revision).toBe(readGoldenFixture(GOLDEN)["revision"]);
  });

  it("refuses an unsupported major and names both majors", () => {
    // A consumer that cannot say what it expected cannot report a useful error,
    // which is why this routes through the version gate rather than failing as
    // an unmatched literal inside the schema.
    const input = readGoldenFixture(UNSUPPORTED_MAJOR);
    const decoded = decodeSymmetriaStreamItem(input);

    expect(Result.isFailure(decoded)).toBe(true);
    const failure = (
      decoded as {
        readonly failure: { _tag: string; supportedMajor: number; receivedMajor: number };
      }
    ).failure;
    expect(failure._tag).toBe("SymmetriaProtocolVersionMismatch");
    expect(failure.supportedMajor).toBe(SYMMETRIA_PROTOCOL_MAJOR);
    expect(failure.receivedMajor).toBe(
      (input["protocolVersion"] as { readonly major: number }).major,
    );
    expect(failure.receivedMajor).not.toBe(failure.supportedMajor);
  });

  it("separates a version refusal from a payload this build cannot read", () => {
    const malformed = decodeSymmetriaStreamItem({
      ...readGoldenFixture(GOLDEN),
      revision: "not a position",
    });
    expect(Result.isFailure(malformed)).toBe(true);
    expect((malformed as { readonly failure: { _tag: string } }).failure._tag).toBe(
      "SymmetriaStreamItemMalformed",
    );
  });

  it("gates a delta that repeats the version, and accepts one that omits it", () => {
    const bare = rawFixtureItems(DUPLICATE)[1] as Record<string, unknown>;
    expect(Result.isSuccess(decodeSymmetriaStreamItem(bare))).toBe(true);

    const announced = decodeSymmetriaStreamItem({
      ...bare,
      protocolVersion: { major: 9, minor: 0 },
    });
    expect((announced as { readonly failure: { _tag: string } }).failure._tag).toBe(
      "SymmetriaProtocolVersionMismatch",
    );
  });

  it("keeps provider payloads and transcripts out of a delta", () => {
    const [, delta] = rawFixtureItems(REORDERED);
    const change = (delta as { readonly change: { readonly thread: Record<string, unknown> } })
      .change;
    const leaky = {
      ...(delta as object),
      change: {
        entity: "thread",
        thread: {
          ...change.thread,
          messages: [{ id: "message-1", text: "private message" }],
          activities: [{ payload: { secret: "provider-native" } }],
          providerName: "claude",
          workspaceRoot: "/home/dev/projects/symmetria",
        },
      },
    };
    const decoded = decodeStreamItemOrThrow(leaky);
    if (decoded.type !== "delta" || decoded.change.entity !== "thread") {
      throw new Error("leaky fixture did not decode as a thread delta");
    }
    for (const field of SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS) {
      expect(Object.hasOwn(decoded.change.thread, field)).toBe(false);
    }
  });
});

describe("applySymmetriaStreamDelta", () => {
  it("applies the successor of the last position and advances by exactly one", () => {
    const state = openedFrom(DUPLICATE);
    const applied = applySymmetriaStreamDelta(
      state,
      fixtureItems(DUPLICATE)[1] as SymmetriaStreamDelta,
    );

    expect(applied.outcome).toBe("applied");
    expect(applied.requiresResnapshot).toBe(false);
    expect(applied.state.sequence).toBe(state.sequence + 1);
    expect(applied.state.revision).toBe(state.revision);
    expect(applied.state.drafts).toHaveLength(1);
  });

  it("reports a repeated position as a duplicate and applies it once", () => {
    // A delta replayed after a reconnect is normal traffic, so it is a distinct
    // outcome from an error — and the state has to be untouched, position
    // included, or the fold has applied it twice.
    const items = fixtureItems(DUPLICATE);
    const first = applySymmetriaStreamDelta(
      openedFrom(DUPLICATE),
      items[1] as SymmetriaStreamDelta,
    );
    const replay = applySymmetriaStreamDelta(first.state, items[2] as SymmetriaStreamDelta);

    expect(replay.outcome).toBe("duplicate");
    expect(replay.requiresResnapshot).toBe(false);
    expect(replay.state).toEqual(first.state);
    expect(replay.state.sequence).toBe(first.state.sequence);
  });

  it("reports a skipped position as a gap that only a resnapshot repairs", () => {
    // No buffering and no reordering: a gap that resolves itself by waiting is
    // the consumer inferring a missing event from a local timeout.
    const state = openedFrom(REORDERED);
    const delta = fixtureItems(REORDERED)[1] as SymmetriaStreamDelta;
    const gap = applySymmetriaStreamDelta(state, delta);

    expect(gap.outcome).toBe("gap");
    expect(gap.requiresResnapshot).toBe(true);
    expect(gap.state).toEqual(state);
    const reported = gap as SymmetriaStreamDeltaGap;
    expect(reported.expectedSequence).toBe(state.sequence + 1);
    expect(reported.receivedSequence).toBe(delta.sequence);
    expect(reported.receivedSequence).toBeGreaterThan(reported.expectedSequence);
  });

  it("replaces an entity it already holds rather than appending a second row", () => {
    const state = openedFrom(DUPLICATE);
    const first = applySymmetriaStreamDelta(
      state,
      fixtureItems(DUPLICATE)[1] as SymmetriaStreamDelta,
    );
    const draft = first.state.drafts[0];
    if (draft === undefined) throw new Error("the applied delta carried no draft");

    const next = applySymmetriaStreamDelta(
      first.state,
      decodeStreamItemOrThrow({
        type: "delta",
        sequence: first.state.sequence + 1,
        change: { entity: "draft", draft: { ...draft, version: draft.version + 1, text: "later" } },
      }) as SymmetriaStreamDelta,
    );

    expect(next.outcome).toBe("applied");
    expect(next.state.drafts).toHaveLength(1);
    expect(next.state.drafts[0]?.text).toBe("later");
  });

  it("never walks a draft backwards, whatever position the delta arrives at", () => {
    // Position and version are two orderings and only the version is the
    // draft's own — `draft.ts` calls it the only ordering a consumer may trust.
    // A producer that re-emits a stale row on a resync must not overwrite a
    // newer body a shell is about to dictate over.
    const state = openedFrom(DUPLICATE);
    const first = applySymmetriaStreamDelta(
      state,
      fixtureItems(DUPLICATE)[1] as SymmetriaStreamDelta,
    );
    const held = first.state.drafts[0];
    if (held === undefined) throw new Error("the applied delta carried no draft");

    const stale = applySymmetriaStreamDelta(
      first.state,
      decodeStreamItemOrThrow({
        type: "delta",
        sequence: first.state.sequence + 1,
        change: {
          entity: "draft",
          draft: { ...held, version: held.version - 1, text: "words from before the last write" },
        },
      }) as SymmetriaStreamDelta,
    );

    // The position is consumed; the body is not written.
    expect(stale.outcome).toBe("applied");
    expect(stale.state.sequence).toBe(first.state.sequence + 1);
    expect(stale.state.drafts).toEqual(first.state.drafts);
  });

  it("folds a thread and a surface into the state the snapshot opened", () => {
    const state = openedFrom(REORDERED);
    const thread = goldenEntity("threads");
    const surface = goldenEntity("surfaces");

    const withThread = applySymmetriaStreamDelta(
      state,
      decodeStreamItemOrThrow({
        type: "delta",
        sequence: state.sequence + 1,
        change: { entity: "thread", thread },
      }) as SymmetriaStreamDelta,
    );
    const withSurface = applySymmetriaStreamDelta(
      withThread.state,
      decodeStreamItemOrThrow({
        type: "delta",
        sequence: withThread.state.sequence + 1,
        change: { entity: "surface", surface },
      }) as SymmetriaStreamDelta,
    );

    expect(withSurface.outcome).toBe("applied");
    expect(withSurface.state.threads).toHaveLength(1);
    expect(withSurface.state.surfaces).toHaveLength(1);
    expect(withSurface.state.sequence).toBe(state.sequence + 2);
  });
});
