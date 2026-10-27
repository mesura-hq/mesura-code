/**
 * Projects `ClientActivityLease`, keeping attention signals and dropping authentication
 * identity and device telemetry. Timestamps are `IsoDateTime`, not upstream's
 * `Schema.DateTimeUtc`, which decodes to a non-JSON value; one timestamp representation
 * holds across the contract, and `symmetriaSurfacePresenceFromLease` converts.
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
 * `ClientKind` plus `symmetria-shell`, which connects through the broker, not as a fork client.
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
 * One-directional on purpose: Symmetria adds a kind upstream never has, so mutual assignability
 * would reject it. Every upstream kind must stay expressible here, so an upstream addition
 * breaks this package's typecheck until it is mirrored.
 */
export const symmetriaSurfaceKindCoversClientKind: Covers<SymmetriaSurfaceKindLiteral, ClientKind> =
  true;

const SymmetriaSurfaceKindLiterals = Schema.Literals(SYMMETRIA_SURFACE_KINDS);

const KNOWN_SURFACE_KINDS: ReadonlySet<string> = new Set(SYMMETRIA_SURFACE_KINDS);

/**
 * Never fails to decode: an unrecognized kind comes from a newer producer, not a corrupt
 * payload, so it decodes as `unknown` and the presence record survives.
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
 * `threadIds` is flat rather than upstream's `scopes` union: every other `BackgroundScope`
 * member describes the fork's own screens and names paths on the host filesystem.
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
 * Total, and it holds no clock: both timestamps come from the lease. Non-thread scope members
 * are discarded here rather than in the schema, so the schema stays a plain wire shape.
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
