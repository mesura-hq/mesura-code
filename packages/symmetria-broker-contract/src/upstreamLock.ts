/**
 * The broker retains these retired upstream literals for protocol compatibility.
 * Each tuple locks against the frozen broker-owned type, not the current server runtime.
 * Compose live upstream schema values directly where they remain available.
 * No runtime imports: compiler guards replace only the vocabulary module.
 */
import type {
  ProviderRuntimeEvent,
  RuntimeErrorClass,
  RuntimeSessionExitKind,
  RuntimeSessionState,
  RuntimeThreadState,
} from "./retiredUpstreamVocabulary.ts";

type ProviderRuntimeEventType = ProviderRuntimeEvent["type"];

/**
 * Resolves to `true` when `A` and `B` denote the same type, and to `never`
 * otherwise. The tuple wrappers stop a naked union from distributing, so a
 * union compares as one whole rather than member by member.
 */
export type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Resolves to `true` when every member of `Subset` is also a member of
 * `Superset`. Used where Symmetria deliberately widens an upstream vocabulary —
 * a projection that adds an `unknown` member stays a superset, and locking it
 * in both directions would reject the addition it exists to make.
 */
export type Covers<Superset, Subset> = [Subset] extends [Superset] ? true : never;

export const RUNTIME_SESSION_STATES = [
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
] as const;
export type RuntimeSessionStateLiteral = (typeof RUNTIME_SESSION_STATES)[number];
export const runtimeSessionStateLock: MutuallyAssignable<
  RuntimeSessionStateLiteral,
  RuntimeSessionState
> = true;

export const RUNTIME_THREAD_STATES = [
  "active",
  "idle",
  "archived",
  "closed",
  "compacted",
  "error",
] as const;
export type RuntimeThreadStateLiteral = (typeof RUNTIME_THREAD_STATES)[number];
export const runtimeThreadStateLock: MutuallyAssignable<
  RuntimeThreadStateLiteral,
  RuntimeThreadState
> = true;

export const RUNTIME_SESSION_EXIT_KINDS = ["graceful", "error"] as const;
export type RuntimeSessionExitKindLiteral = (typeof RUNTIME_SESSION_EXIT_KINDS)[number];
export const runtimeSessionExitKindLock: MutuallyAssignable<
  RuntimeSessionExitKindLiteral,
  RuntimeSessionExitKind
> = true;

export const RUNTIME_ERROR_CLASSES = [
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
] as const;
export type RuntimeErrorClassLiteral = (typeof RUNTIME_ERROR_CLASSES)[number];
export const runtimeErrorClassLock: MutuallyAssignable<
  RuntimeErrorClassLiteral,
  RuntimeErrorClass
> = true;

export const PROVIDER_RUNTIME_EVENT_TYPES = [
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "thread.realtime.started",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "tool.denied",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "runtime.warning",
  "runtime.error",
] as const;
export type ProviderRuntimeEventTypeLiteral = (typeof PROVIDER_RUNTIME_EVENT_TYPES)[number];
export const providerRuntimeEventTypeLock: MutuallyAssignable<
  ProviderRuntimeEventTypeLiteral,
  ProviderRuntimeEventType
> = true;

/**
 * Keep the public name and keys for broker consumers. These vocabularies now lock
 * against retiredUpstreamVocabulary.ts; they no longer track live upstream exports.
 */
export const BORROWED_RUNTIME_VOCABULARIES = {
  RuntimeSessionState: RUNTIME_SESSION_STATES,
  RuntimeThreadState: RUNTIME_THREAD_STATES,
  RuntimeSessionExitKind: RUNTIME_SESSION_EXIT_KINDS,
  RuntimeErrorClass: RUNTIME_ERROR_CLASSES,
  ProviderRuntimeEventType: PROVIDER_RUNTIME_EVENT_TYPES,
} as const;
