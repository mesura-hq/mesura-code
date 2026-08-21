/**
 * Which surfaces are attending a thread, and how attentive each one is.
 *
 * The source is `ClientActivityLease` (`packages/contracts/src/background.ts:84`).
 * The projection keeps the attention signals and drops two groups outright.
 * `sessionId` and `rpcClientId` are authentication identity, and a shell that
 * renders "someone is watching this" has no use for the credential behind it.
 * `lowPowerMode`, `batteryState` and `networkType` are device telemetry about
 * the person at the other surface. `BackgroundPolicySnapshot` and
 * `HostPowerSnapshot` are not projected at all.
 *
 * Timestamps are `IsoDateTime` rather than the `Schema.DateTimeUtc` upstream
 * uses here. `Schema.DateTimeUtc` decodes to a `DateTime.Utc` value, which is
 * not JSON, and the rest of the Symmetria contract projects `IsoDateTime` from
 * `OrchestrationThread`. One timestamp representation across the whole contract
 * is worth more to a consumer that is not TypeScript than agreement with one
 * upstream module — `symmetriaSurfacePresenceFromLease` below carries the
 * conversion so a producer never has to think about it.
 */
import {
  ClientActivityClientId,
  IsoDateTime,
  ThreadId,
  type ClientActivityLease,
  type ClientKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import type { Covers } from "./upstreamLock.ts";

/**
 * Every surface that can attend a thread. This is `ClientKind`
 * (`background.ts:61`) plus `symmetria-shell`, because Symmetria Shell is a
 * surface the fork does not know about and will not learn about — it connects
 * through the broker, not as a fork client.
 */
export const SYMMETRIA_SURFACE_KINDS = [
  "web",
  "desktop-renderer",
  "mobile",
  "symmetria-shell",
  "unknown",
] as const;
export type SymmetriaSurfaceKindLiteral = (typeof SYMMETRIA_SURFACE_KINDS)[number];

/**
 * The lock is one-directional on purpose. The two sets are deliberately unequal
 * — Symmetria adds a member upstream will never have — so mutual assignability
 * would reject the very addition this vocabulary exists to make. What must hold
 * is that every upstream kind stays expressible here, and an upstream addition
 * still breaks this package's typecheck until somebody mirrors it.
 */
export const symmetriaSurfaceKindCoversClientKind: Covers<SymmetriaSurfaceKindLiteral, ClientKind> =
  true;

const SymmetriaSurfaceKindLiterals = Schema.Literals(SYMMETRIA_SURFACE_KINDS);

const KNOWN_SURFACE_KINDS: ReadonlySet<string> = new Set(SYMMETRIA_SURFACE_KINDS);

/**
 * A surface kind that never fails to decode.
 *
 * A kind the reader does not know is a newer producer, not a corrupt payload,
 * and dropping the whole presence record over one literal would blank a shell's
 * attention column for a surface that is genuinely there. So an unrecognized
 * kind decodes as `unknown` — the same value the fork already uses for a client
 * it cannot classify — and the record survives.
 */
export const SymmetriaSurfaceKind = Schema.String.pipe(
  Schema.decodeTo(
    SymmetriaSurfaceKindLiterals,
    SchemaTransformation.transform<SymmetriaSurfaceKindLiteral, string>({
      decode: (value) =>
        KNOWN_SURFACE_KINDS.has(value) ? (value as SymmetriaSurfaceKindLiteral) : "unknown",
      encode: (value) => value,
    }),
  ),
);
export type SymmetriaSurfaceKind = typeof SymmetriaSurfaceKind.Type;

/**
 * One surface attending one or more threads.
 *
 * `threadIds` is flat rather than the upstream `scopes` union, because every
 * other `BackgroundScope` member — server configuration, provider status, the
 * version control status of a directory — describes work the fork does for its
 * own screens and names paths on the host filesystem.
 */
export const SymmetriaSurfacePresence = Schema.Struct({
  clientId: ClientActivityClientId,
  surfaceKind: SymmetriaSurfaceKind,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  recentlyInteracted: Schema.Boolean,
  threadIds: Schema.Array(ThreadId),
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  // See `SymmetriaThreadSummary`: the identifier names this struct in the
  // emitted `$defs` instead of leaving it at a positional `Objects_1`.
}).annotate({ identifier: "SymmetriaSurfacePresence" });
export type SymmetriaSurfacePresence = typeof SymmetriaSurfacePresence.Type;

/**
 * Projects one upstream lease into the presence a surface outside this fork
 * sees. Total, and it holds no clock: both timestamps come from the lease.
 *
 * The thread ids come from the lease's scopes, which is the only place the
 * upstream model records what a client is attending. Every other scope member
 * is discarded here rather than in the schema, so the schema stays a plain
 * description of the wire shape.
 */
export const symmetriaSurfacePresenceFromLease = (
  lease: ClientActivityLease,
): SymmetriaSurfacePresence => ({
  clientId: lease.clientId,
  surfaceKind: lease.clientKind,
  visible: lease.visible,
  focused: lease.focused,
  recentlyInteracted: lease.recentlyInteracted,
  threadIds: lease.scopes.flatMap((scope) => (scope.type === "thread" ? [scope.threadId] : [])),
  updatedAt: DateTime.formatIso(lease.updatedAt),
  expiresAt: DateTime.formatIso(lease.expiresAt),
});

/**
 * The upstream lease fields this projection refuses, kept as a value so the
 * privacy test asserts against a list rather than against examples.
 */
export const SYMMETRIA_SURFACE_PRESENCE_EXCLUDED_UPSTREAM_FIELDS = [
  // Authentication identity.
  "sessionId",
  "rpcClientId",
  // Device telemetry about the person at the surface.
  "lowPowerMode",
  "batteryState",
  "networkType",
  "appState",
  // The raw scope union, of which only the thread member is projected.
  "scopes",
] as const;
