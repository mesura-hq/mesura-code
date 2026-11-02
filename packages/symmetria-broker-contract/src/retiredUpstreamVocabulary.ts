/**
 * Upstream T3 Code deleted its v1 provider runtime vocabulary (`packages/contracts/src/providerRuntime.ts`)
 * in 67661cfbb5, "delete 18k lines of code that nothing reaches". These are its last published
 * literals, so the locks in `upstreamLock.ts` pin that vocabulary rather than a live upstream type.
 * Point the locks back at `@t3tools/contracts` if upstream exports these again, or retire them.
 */

export type RuntimeSessionState =
  | "starting"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "error";

export type RuntimeThreadState = "active" | "idle" | "archived" | "closed" | "compacted" | "error";

export type RuntimeSessionExitKind = "graceful" | "error";

export type RuntimeErrorClass =
  | "provider_error"
  | "transport_error"
  | "permission_error"
  | "validation_error"
  | "unknown";

export type ProviderRuntimeEvent = {
  readonly type:
    | "session.started"
    | "session.configured"
    | "session.state.changed"
    | "session.exited"
    | "thread.started"
    | "thread.state.changed"
    | "thread.metadata.updated"
    | "thread.token-usage.updated"
    | "thread.realtime.started"
    | "thread.realtime.item-added"
    | "thread.realtime.audio.delta"
    | "thread.realtime.error"
    | "thread.realtime.closed"
    | "turn.started"
    | "turn.completed"
    | "turn.aborted"
    | "turn.plan.updated"
    | "turn.proposed.delta"
    | "turn.proposed.completed"
    | "turn.diff.updated"
    | "item.started"
    | "item.updated"
    | "item.completed"
    | "content.delta"
    | "request.opened"
    | "request.resolved"
    | "user-input.requested"
    | "user-input.resolved"
    | "task.started"
    | "task.progress"
    | "task.updated"
    | "task.completed"
    | "hook.started"
    | "hook.progress"
    | "hook.completed"
    | "tool.progress"
    | "tool.summary"
    | "tool.denied"
    | "auth.status"
    | "account.updated"
    | "account.rate-limits.updated"
    | "mcp.status.updated"
    | "mcp.oauth.completed"
    | "model.rerouted"
    | "config.warning"
    | "deprecation.notice"
    | "files.persisted"
    | "runtime.warning"
    | "runtime.error";
};
