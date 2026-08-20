import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { expectGoldenRoundTrip, readGoldenFixture } from "../test/goldenFixture.ts";
import {
  SYMMETRIA_COMMAND_TYPES,
  SymmetriaCommandEnvelope,
  SymmetriaCommandReceipt,
  SymmetriaCommandRefusedReceipt,
  SymmetriaTurnStartCommand,
  symmetriaReplayReceiptOf,
  type SymmetriaCommandAppliedReceipt,
} from "./command.ts";

const GOLDEN = "command.golden.json";
const ACTIVATE = "command.activate.json";
const INTERRUPT = "command.interrupt.json";
const DRAFT_SET = "command.draftSet.json";
const DUPLICATE = "command.duplicate.json";

const decode = Schema.decodeUnknownResult(SymmetriaCommandEnvelope);
const decodeOrThrow = Schema.decodeUnknownSync(SymmetriaCommandEnvelope);
const decodeReceipt = Schema.decodeUnknownSync(SymmetriaCommandReceipt);
const decodeRefused = Schema.decodeUnknownResult(SymmetriaCommandRefusedReceipt);

/** One payload short of a key, which is how every refusal case here is built. */
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));

const readDuplicateReceipts = () => {
  const fixture = readGoldenFixture(DUPLICATE);
  return {
    first: decodeReceipt(fixture["first"]),
    replay: decodeReceipt(fixture["replay"]),
  };
};

/**
 * Every leaf of a decoded value, addressed by its path. A receipt guarantee is
 * about the whole value and not about the fields a reader thought to name, so
 * the comparison walks it rather than listing keys.
 */
const leafPaths = (value: unknown, path = ""): ReadonlyArray<readonly [string, unknown]> => {
  if (value === null || typeof value !== "object") return [[path, value]];
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, path === "" ? key : `${path}.${key}`),
  );
};

const differingPaths = (left: unknown, right: unknown): ReadonlyArray<string> => {
  const rightLeaves = new Map(leafPaths(right));
  const leftLeaves = new Map(leafPaths(left));
  const paths = new Set([...leftLeaves.keys(), ...rightLeaves.keys()]);
  return [...paths].filter((path) => !Object.is(leftLeaves.get(path), rightLeaves.get(path)));
};

describe("SymmetriaCommandEnvelope", () => {
  it("round-trips the golden fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaCommandEnvelope, GOLDEN);
  });

  it("round-trips the activation fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaCommandEnvelope, ACTIVATE);
  });

  it("round-trips the interrupt fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaCommandEnvelope, INTERRUPT);
  });

  it("round-trips the draft set fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaCommandEnvelope, DRAFT_SET);
  });

  it("interrupts the running turn when the caller cannot name it", () => {
    const interrupt = readGoldenFixture(INTERRUPT);
    const decoded = decode({ ...interrupt, turnId: null });
    expect(Result.isSuccess(decoded)).toBe(true);
    // Nullable rather than optional: a shell that saw a row light up but never
    // learned the turn's identity still has one shape to send.
    expect(Result.isFailure(decode(without(interrupt, "turnId")))).toBe(true);
  });

  it("refuses a draft set that does not state the version it expects", () => {
    const draftSet = readGoldenFixture(DRAFT_SET);
    expect(Result.isFailure(decode(without(draftSet, "expectedVersion")))).toBe(true);
    expect(Result.isFailure(decode({ ...draftSet, expectedVersion: -1 }))).toBe(true);
    // Emptying the composer is a legitimate draft, unlike an empty dictation.
    expect(Result.isSuccess(decode({ ...draftSet, text: "" }))).toBe(true);
  });

  it("refuses a dictation that is empty or only whitespace", () => {
    const golden = readGoldenFixture(GOLDEN);
    for (const text of ["", "   ", "\t\n"]) {
      expect(Result.isFailure(decode({ ...golden, text }))).toBe(true);
    }
  });

  it("keeps the non-empty rule on turn text visible to a consumer outside TypeScript", () => {
    // `JsonSchema` is a union whose object member the emitter picks at runtime,
    // so a test reading one property has to say which member it got.
    const schema = Schema.toJsonSchemaDocument(SymmetriaTurnStartCommand).schema as unknown as {
      readonly properties: Record<string, unknown>;
    };
    // `TrimmedNonEmptyString` would emit a bare {"type":"string"} here, because
    // the emitter drops a check applied after a transformation, and a shell
    // validating against that schema would accept what the decoder refuses.
    const text = JSON.stringify(schema.properties["text"]);
    expect(text).toContain("minLength");
    expect(text).toContain("pattern");
  });

  it("carries the shared address block on every member", () => {
    const golden = readGoldenFixture(GOLDEN);
    const decoded = decodeOrThrow(golden);
    expect(decoded.commandId).toBe(golden["commandId"]);
    expect(decoded.threadId).toBe(golden["threadId"]);
    expect(decoded.createdAt).toBe(golden["createdAt"]);
    expect(decoded.type).toBe(golden["type"]);
  });

  it("admits exactly the four shell-facing command tags", () => {
    const tags = SymmetriaCommandEnvelope.members.map((member) => member.fields.type.literal);
    expect([...tags].sort()).toEqual([...SYMMETRIA_COMMAND_TYPES].sort());
    expect(SYMMETRIA_COMMAND_TYPES).toHaveLength(4);
  });

  it("decodes an activation with a target surface and without one", () => {
    const activate = readGoldenFixture(ACTIVATE);
    const withTarget = decode(activate);
    expect(Result.isSuccess(withTarget)).toBe(true);
    if (Result.isSuccess(withTarget)) {
      expect(withTarget.success).toHaveProperty("targetSurfaceId");
    }

    const decoded = decode(without(activate, "targetSurfaceId"));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      // Absent stays absent. `Schema.optionalKey` refuses to synthesize the key,
      // so a consumer never has to tell a missing target from an undefined one.
      expect(Object.hasOwn(decoded.success, "targetSurfaceId")).toBe(false);
    }
  });

  it("refuses an envelope that omits its idempotency key", () => {
    expect(Result.isFailure(decode(without(readGoldenFixture(GOLDEN), "commandId")))).toBe(true);
  });

  it("refuses an envelope that omits its thread address", () => {
    expect(Result.isFailure(decode(without(readGoldenFixture(GOLDEN), "threadId")))).toBe(true);
  });

  it("refuses a command tag the shell contract does not own", () => {
    const golden = readGoldenFixture(GOLDEN);
    expect(Result.isFailure(decode({ ...golden, type: "thread.snooze" }))).toBe(true);
  });
});

describe("SymmetriaCommandReceipt", () => {
  it("answers one commandId twice with receipts equal but for the replay marker", () => {
    const { first, replay } = readDuplicateReceipts();
    expect(first.commandId).toBe(replay.commandId);
    expect(differingPaths(first, replay)).toEqual(["application"]);
    expect(first.application).toBe("first");
    expect(replay.application).toBe("replay");
  });

  it("derives the replay receipt from the first application by construction", () => {
    const { first, replay } = readDuplicateReceipts();
    expect(symmetriaReplayReceiptOf(first)).toEqual(replay);
  });

  it("reports the effect identity the applied command produced", () => {
    const { first } = readDuplicateReceipts();
    expect(first.outcome).toBe("applied");
    const applied = first as SymmetriaCommandAppliedReceipt;
    expect(applied.effect.turnId).not.toBe(null);
    expect(applied.effect.draftVersion).toBe(null);
    expect(applied.effect.activatedSurfaceId).toBe(null);
  });

  it("tells an interrupt which turn it stopped", () => {
    // The caller sent `turnId: null`, so the receipt's effect slot is the only
    // place it learns what was interrupted.
    const receipt = decodeReceipt({
      outcome: "applied",
      commandId: "cmd_84be0d5c",
      threadId: "thr_9f3c1a7e",
      application: "first",
      effect: { turnId: "trn_4b21d0c8", draftVersion: null, activatedSurfaceId: null },
      sequence: 4822,
    });
    expect(receipt.outcome).toBe("applied");
    expect((receipt as SymmetriaCommandAppliedReceipt).effect.turnId).toBe("trn_4b21d0c8");
  });

  it("requires a typed rejection on a refused receipt and carries no effect", () => {
    const refused = {
      outcome: "refused",
      commandId: "cmd_6f0a3d91",
      threadId: "thr_9f3c1a7e",
      application: "first",
      rejection: { code: "surface_not_attached", detail: "no shell surface holds this thread" },
    };
    const decoded = decodeRefused(refused);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.rejection.code).toBe("surface_not_attached");
      expect(Object.hasOwn(decoded.success, "effect")).toBe(false);
    }

    expect(Result.isFailure(decodeRefused(without(refused, "rejection")))).toBe(true);
  });

  it("requires the rejection detail key and refuses an empty sentence", () => {
    const rejection = (detail: unknown) => ({
      outcome: "refused",
      commandId: "cmd_6f0a3d91",
      threadId: "thr_9f3c1a7e",
      application: "first",
      rejection: { code: "unknown_thread", detail },
    });
    // Nullable, not optional: `null` is how a producer says "no sentence", and
    // omitting the key is not a second way to say it.
    expect(Result.isSuccess(decodeRefused(rejection(null)))).toBe(true);
    expect(
      Result.isFailure(
        decodeRefused({
          ...rejection(null),
          rejection: without(rejection(null).rejection as Record<string, unknown>, "detail"),
        }),
      ),
    ).toBe(true);
    expect(Result.isFailure(decodeRefused(rejection("")))).toBe(true);
  });

  it("refuses a rejection code outside the closed vocabulary", () => {
    const refused = {
      outcome: "refused",
      commandId: "cmd_6f0a3d91",
      threadId: "thr_9f3c1a7e",
      application: "first",
      rejection: { code: "because I said so", detail: null },
    };
    expect(Result.isFailure(decodeRefused(refused))).toBe(true);
  });
});
