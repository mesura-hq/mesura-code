import * as Effect from "effect/Effect";
import { SharedAgentRamSummary } from "./sharedAgentRam.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PortSchema, ThreadId } from "./baseSchemas.ts";

export {
  SharedAgentRamGroup,
  SharedAgentRamReason,
  SharedAgentRamSummary,
} from "./sharedAgentRam.ts";

const RecordId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const WorkloadListInput = Schema.Struct({ threadId: Schema.optionalKey(ThreadId) });
export type WorkloadListInput = typeof WorkloadListInput.Type;

export const WorkloadAssociation = Schema.Struct({
  state: Schema.Literals(["assigned", "unassigned"]),
  threadId: Schema.NullOr(ThreadId),
  reason: Schema.NullOr(
    Schema.Literals([
      "missing-identity",
      "environment",
      "unsupported-provider",
      "unmapped",
      "ambiguous",
      "stale",
      "unsupported-subagent",
      "projection-unavailable",
    ]),
  ),
});
export type WorkloadAssociation = typeof WorkloadAssociation.Type;

export const WorkloadDiagnostic = Schema.Struct({
  code: Schema.Literals([
    "unsafe-registry",
    "unreadable-registry",
    "invalid-record",
    "unsafe-record",
    "scan-limit",
    "observation-incomplete",
  ]),
  count: NonNegativeInt,
});
export type WorkloadDiagnostic = typeof WorkloadDiagnostic.Type;

export const WorkloadSummary = Schema.Struct({
  recordId: Schema.String,
  name: Schema.String,
  association: WorkloadAssociation,
  managerState: Schema.Literals(["running", "stopped", "failed", "absent", "unknown"]),
  ramBytes: Schema.NullOr(NonNegativeInt),
  memoryCurrentBytes: Schema.NullOr(NonNegativeInt),
  ports: Schema.Array(PortSchema),
  defaultPort: Schema.NullOr(PortSchema),
  remoteUrl: Schema.NullOr(Schema.String),
  controlsAvailable: Schema.Boolean,
});
export type WorkloadSummary = typeof WorkloadSummary.Type;

export const WorkloadListResult = Schema.Struct({
  registryState: Schema.Literals(["available", "absent", "unknown", "unsupported"]),
  workloads: Schema.Array(WorkloadSummary),
  incomplete: Schema.Boolean,
  diagnostics: Schema.Array(WorkloadDiagnostic),
  // A shared provider process cannot supply a per-thread agent RAM counter.
  agentRamAttribution: Schema.Literal("unsupported"),
  sharedAgentRam: SharedAgentRamSummary.pipe(
    Schema.withDecodingDefault(
      Effect.sync((): SharedAgentRamSummary => ({
        status: "unsupported",
        groups: [],
        incomplete: false,
      })),
    ),
  ),
});
export type WorkloadListResult = typeof WorkloadListResult.Type;

export const WorkloadControlInput = Schema.Struct({
  recordId: RecordId,
  threadId: ThreadId,
});
export type WorkloadControlInput = typeof WorkloadControlInput.Type;
const controlIdentity = {
  recordId: RecordId,
};
const ManagerState = Schema.Literals(["running", "stopped", "failed", "absent", "unknown"]);
export const WorkloadControlRefusal = Schema.Literals([
  "invalid-input",
  "registry-unavailable",
  "record-unavailable",
  "owner-unavailable",
  "owner-mismatch",
  "unsupported-host",
  "wrapper-unavailable",
  "deadline",
  "manager-unknown",
  "unit-loaded",
  "invalid-launch",
  "replay-context-unavailable",
]);
export type WorkloadControlRefusal = typeof WorkloadControlRefusal.Type;
export const WorkloadControlResult = Schema.Union([
  Schema.Struct({
    ...controlIdentity,
    status: Schema.Literal("completed"),
    operation: Schema.Literal("stop"),
    result: Schema.Literal("already-stopped"),
    mutationAttempted: Schema.Literal(false),
    managerState: Schema.Literals(["absent", "stopped", "failed"]),
  }),
  Schema.Struct({
    ...controlIdentity,
    status: Schema.Literal("completed"),
    operation: Schema.Literal("stop"),
    result: Schema.Literal("stopped"),
    mutationAttempted: Schema.Literal(true),
    managerState: Schema.Literals(["absent", "stopped", "failed"]),
  }),
  Schema.Struct({
    ...controlIdentity,
    status: Schema.Literal("completed"),
    operation: Schema.Literal("start"),
    result: Schema.Literal("admitted"),
    mutationAttempted: Schema.Literal(true),
    registration: Schema.Literal("recorded"),
    managerState: ManagerState,
  }),
  Schema.Struct({
    ...controlIdentity,
    status: Schema.Literal("refused"),
    operation: Schema.Literals(["start", "stop"]),
    reason: WorkloadControlRefusal,
    mutationAttempted: Schema.Literal(false),
    managerState: ManagerState,
  }),
  Schema.Struct({
    ...controlIdentity,
    status: Schema.Literal("incomplete"),
    operation: Schema.Literal("stop"),
    mutationAttempted: Schema.Literal(true),
    managerState: ManagerState,
  }),
  Schema.Struct({
    ...controlIdentity,
    status: Schema.Literal("incomplete"),
    operation: Schema.Literal("start"),
    mutationAttempted: Schema.Literal(true),
    admission: Schema.Literals(["accepted", "unknown"]),
    registration: Schema.Literals(["failed", "unknown"]),
    managerState: ManagerState,
  }),
]);
export type WorkloadControlResult = typeof WorkloadControlResult.Type;
