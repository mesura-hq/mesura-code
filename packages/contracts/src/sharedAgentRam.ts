import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SharedAgentRamReason = Schema.Literals([
  "unsupported_platform",
  "unknown_launcher",
  "unsupported_path",
  "untrusted_chain",
  "ambient_cgroup",
  "capture_failed",
  "exited",
  "identity_changed",
  "not_initialized",
  "sample_failed",
  "ambiguous_scope",
  "incomplete",
  "unsupported_provider",
]);
export type SharedAgentRamReason = typeof SharedAgentRamReason.Type;

const SafeCount = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0, {
    expected: "a nonnegative safe integer",
  }),
);
const SampleTime = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
      const date = DateTime.make(value);
      return Option.isSome(date) && DateTime.formatIso(date.value) === value;
    },
    { expected: "a valid UTC ISO sample time" },
  ),
);
const identity = {
  groupId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  ),
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  attachedThreadCount: SafeCount,
};
const AvailableGroup = Schema.Struct({
  ...identity,
  status: Schema.Literal("available"),
  anonymousBytes: SafeCount,
  sampledAt: SampleTime,
  reason: Schema.Null,
});
export const SharedAgentRamGroup = Schema.Union([
  AvailableGroup,
  Schema.Struct({
    ...identity,
    status: Schema.Literals(["unavailable", "unsupported"]),
    anonymousBytes: Schema.Null,
    sampledAt: Schema.Null,
    reason: SharedAgentRamReason,
  }),
]);
export type SharedAgentRamGroup = typeof SharedAgentRamGroup.Type;

export const SharedAgentRamSummary = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    groups: Schema.Array(AvailableGroup).check(Schema.isMaxLength(32)),
    incomplete: Schema.Literal(false),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    groups: Schema.Array(SharedAgentRamGroup).check(Schema.isMaxLength(32)),
    incomplete: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    groups: Schema.Tuple([]),
    incomplete: Schema.Boolean,
  }),
]).check(
  Schema.makeFilter(
    (summary) =>
      new Set(summary.groups.map((group) => group.groupId)).size === summary.groups.length,
    { expected: "unique shared runtime group identities" },
  ),
);
export type SharedAgentRamSummary = typeof SharedAgentRamSummary.Type;
