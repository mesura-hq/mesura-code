import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

const text = Schema.String.check(
  Schema.makeFilter((value: string) => !value.includes("\u0000"), {
    expected: "text without a NUL",
  }),
);
const hex32 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));
const bootId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
);
const monotonic = Schema.String.check(Schema.isPattern(/^[0-9]+$/));

const PrivateWorkloadRecord = Schema.Struct({
  version: Schema.Literal(2),
  name: text,
  unit: text,
  recordKey: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  generation: hex32,
  unitInvocationId: Schema.NullOr(hex32),
  unitStartMonotonic: Schema.NullOr(monotonic),
  bootId: Schema.NullOr(bootId),
  binding: Schema.Literals(["observed", "unverified"]),
  cwd: text,
  argv: Schema.Array(text),
  PATH: Schema.NullOr(text),
  thread: Schema.NullOr(text),
  providerThreadRef: Schema.NullOr(Schema.Struct({ driver: text, nativeId: text })),
  environmentId: Schema.NullOr(text),
  providerInstanceId: Schema.NullOr(text),
  memoryHigh: text,
  startedAt: Schema.String,
});
export type WorkloadRecord = typeof PrivateWorkloadRecord.Type;
export const encodeWorkloadRecord = Schema.encodeSync(Schema.fromJsonString(PrivateWorkloadRecord));
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PrivateWorkloadRecord));

export function canonicalWorkloadUnit(name: string): string | null {
  if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/.test(name)) return null;
  const unit = `mesura-workload-${name}`;
  if (/\.(socket|device|mount|automount|swap|target|path|timer|slice|scope)$/.test(unit))
    return null;
  const canonical = unit.endsWith(".service") ? unit : `${unit}.service`;
  return Buffer.byteLength(canonical, "ascii") <= 255 ? canonical : null;
}

export const workloadRecordKey = Effect.fn("WorkloadRecord.workloadRecordKey")(function* (
  unit: string,
) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(unit)));
});

export const decodeWorkloadRecord = Effect.fn("WorkloadRecord.decodeWorkloadRecord")(function* (
  json: string,
  filename: string,
) {
  const record = decode(json).pipe(
    Option.filter((record) => {
      if (
        canonicalWorkloadUnit(record.name) !== record.unit ||
        filename !== `${record.recordKey}.json`
      )
        return false;
      if (
        // The recording wrapper and registry are Linux-only.
        !record.cwd.startsWith("/") ||
        record.argv.length === 0 ||
        !record.argv[0] ||
        !record.memoryHigh.trim() ||
        !Number.isFinite(Date.parse(record.startedAt))
      )
        return false;
      if (record.binding === "unverified")
        return (
          record.unitInvocationId === null &&
          record.unitStartMonotonic === null &&
          record.bootId === null
        );
      return (
        record.unitInvocationId !== null &&
        record.unitInvocationId !== "0".repeat(32) &&
        record.unitStartMonotonic !== null &&
        BigInt(record.unitStartMonotonic) > 0n &&
        record.bootId !== null
      );
    }),
  );
  if (Option.isNone(record)) return record;
  const key = yield* workloadRecordKey(record.value.unit);
  return Option.filter(record, (value) => value.recordKey === key);
});
