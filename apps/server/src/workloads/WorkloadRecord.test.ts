// Entry point: private version2 record decoding. Fixtures derive from the accepted host contract.
import { expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { recordFixture } from "./workloadTestkit.ts";
import { decodeWorkloadRecord } from "./WorkloadRecord.ts";

it.layer(NodeCrypto.layer)("F2 V12 private record Crypto boundary", (it) => {
  it.effect("F2 record keeps exact private replay arguments", () =>
    Effect.gen(function* () {
      const record = recordFixture();
      expect(
        Option.getOrThrow(
          yield* decodeWorkloadRecord(JSON.stringify(record), `${record.recordKey}.json`),
        ),
      ).toEqual(record);
    }),
  );

  it.effect.each([
    { name: "version", overrides: { version: 1 } },
    {
      name: "unit type",
      overrides: { name: "preview.socket", unit: "mesura-workload-preview.socket" },
    },
    { name: "key", overrides: { recordKey: "c".repeat(64) } },
    { name: "NUL argv", overrides: { argv: ["node", "\u0000"] } },
    { name: "relative cwd", overrides: { cwd: "workspace" } },
  ])("F2 record rejects $name without repairing untrusted input", ({ overrides }) =>
    Effect.gen(function* () {
      const record = recordFixture(overrides);
      expect(
        Option.isNone(
          yield* decodeWorkloadRecord(JSON.stringify(record), `${record.recordKey}.json`),
        ),
      ).toBe(true);
    }),
  );

  it.effect("older extra generation fields are ignored without becoming control authority", () =>
    Effect.gen(function* () {
      const record = recordFixture();
      const old = {
        ...record,
        generation: "legacy",
        unitInvocationId: null,
        unitStartMonotonic: null,
        bootId: null,
        binding: "unverified",
      };
      expect(
        Option.getOrThrow(
          yield* decodeWorkloadRecord(JSON.stringify(old), `${record.recordKey}.json`),
        ),
      ).toEqual(record);
    }),
  );

  it.effect("F2 record canonicalizes equivalent names and retains null versus empty PATH", () =>
    Effect.gen(function* () {
      for (const PATH of [null, ""]) {
        const record = recordFixture({
          name: "preview.service",
          PATH,
        });
        expect(
          Option.getOrThrow(
            yield* decodeWorkloadRecord(JSON.stringify(record), `${record.recordKey}.json`),
          ).PATH,
        ).toBe(PATH);
      }
      const record = recordFixture();
      expect(Option.isNone(yield* decodeWorkloadRecord(JSON.stringify(record), "wrong.json"))).toBe(
        true,
      );
    }),
  );
});
