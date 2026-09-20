/**
 * Compile-time locks that bind the runtime vocabularies this projection borrows
 * to the upstream types they project.
 *
 * `packages/contracts/src/providerRuntime.ts` declares every runtime state
 * vocabulary as a module-private `Schema.Literals` value and, for the ones
 * borrowed here, exports only the TypeScript type — so no other package can
 * compose the schema value. Symmetria needs a runtime value — a schema cannot
 * emit JSON Schema without one — so it keeps its own literal tuple here and
 * asserts mutual assignability against the upstream type. Adding or removing a
 * literal upstream collapses `MutuallyAssignable` to `never`, and the
 * assignment of `true` then fails this package's typecheck. That is how the
 * second copy cannot drift in silence.
 *
 * A vocabulary belongs here only when its schema value is genuinely
 * unreachable. `RuntimeTurnState` looks like it belongs and does not: upstream
 * re-exports that exact value as `ProviderRuntimeTurnStatus`
 * (`providerRuntime.ts:1213`), so the projection composes it directly and needs
 * neither a copy nor a lock. Do not add it back — a lock guards against drift
 * between two copies, and composing the upstream value means there is only one.
 * Check for a public alias before adding any vocabulary to this module.
 *
 * The alternative was one `export` keyword added to each upstream constant.
 * That is a smaller diff today and a merge conflict at every weekly upstream
 * synchronization, in the file this migration most wants to leave untouched.
 *
 * Every declaration below is a type-only import or a plain literal tuple. This
 * module deliberately depends on nothing at runtime, so it can be typechecked
 * on its own against a stand-in for the upstream types.
 */
import type {
  ProviderRuntimeEventType,
  RuntimeErrorClass,
  RuntimeSessionExitKind,
  RuntimeSessionState,
  RuntimeThreadState,
} from "@t3tools/contracts";

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
 * Every borrowed vocabulary, keyed by the upstream type it locks against. Kept
 * so a test can walk the whole set rather than naming each tuple by hand, which
 * also means adding or removing one here changes what those tests cover without
 * any second table needing an edit.
 */
export const BORROWED_RUNTIME_VOCABULARIES = {
  RuntimeSessionState: RUNTIME_SESSION_STATES,
  RuntimeThreadState: RUNTIME_THREAD_STATES,
  RuntimeSessionExitKind: RUNTIME_SESSION_EXIT_KINDS,
  RuntimeErrorClass: RUNTIME_ERROR_CLASSES,
  ProviderRuntimeEventType: PROVIDER_RUNTIME_EVENT_TYPES,
} as const;
