# Symmetria dictation

Mesura Code and Symmetria Shell share one Shell-owned dictation session. Shell owns audio capture,
transcription, transcript recovery, and final toasts. Mesura owns exact composer addressing,
persistent draft mutation, directed submission, and provider-turn confirmation.

## Session identity and target

Electron main runs `DictationBroker`. The broker holds one session and one immutable target. A target
is one of these values:

- A server thread, addressed by `environmentId` and `threadId`.
- A local draft, addressed by `draftId` and its preallocated `futureThreadRef`.

Shell captures the Mesura process and dispatches the reservation before audio capture starts. It can
start capture immediately after that dispatch while Shell still owns presentation. The renderer
supplies the exact target from the registered composer. If reservation fails, Shell keeps ordinary
transcription active, reports the failure, and copies the result for manual paste. It never runs
destination-less injection or automatic send. Navigation does not change a confirmed reservation.
Delivery resolves only the reservation and never reads the current route.

Fast transcription cannot bypass reservation. Shell holds a completed transcript until the broker
confirms the target. Restart reuses the pending session identity, and the latest Shell mode is
published after confirmation.

The broker survives a renderer reload. The new renderer restores the broker snapshot into
`dictationCoordinator`. Delivery then revalidates the target against the current draft store and
thread projection. A missing or ambiguous target produces `target_missing`; it never selects a
replacement target.

## Flow

1. Shell or the Mesura microphone sends `dictation.reserve.request`; Shell starts capture under its
   own presentation while that request is pending.
2. Electron main asks the renderer to reserve its registered composer target.
3. The broker publishes the session snapshot to Shell and every renderer.
4. Shell runs the existing STT job and publishes phase, elapsed time, audio level, and grace time.
5. Shell sends one `dictation.deliver` command with the final transcript and selected mode.
6. The renderer appends the transcript to the reserved draft with the delivery `commandId`.
7. Insert mode completes after the exact append. Submit mode completes after Mesura accepts the
   normal thread submission command.
8. The broker records the receipt and Shell shows the final toast.

The transcript crosses the broker only in `dictation.deliver`. Session snapshots never contain it.

## Draft and submission rules

The append operation adds `[voiced] ` and the transcript after the latest target text. It preserves
text, links, paths, and references that the user added while dictation was active. The operation
persists a bounded command ledger with the draft. Replaying the same `commandId` returns a replay
result without a second append.

Submit mode uses the target's latest composer state. It supports normal turns, new-thread bootstrap,
worktree preparation, text questions, and plan follow-ups. It refuses button approvals because free
text cannot select an approval decision.

The directed executor uses the same `commandId` and `messageId` on retry. It evicts only failures that
prove no provider effect started. A successful dispatch stays cached and cannot start a second turn.

## Receipts

Receipts describe an observed effect:

- `copied`: Shell owns clipboard success. Mesura does not mutate a draft.
- `inserted`: Mesura applied the exact draft append. `action: submit` means Mesura also accepted the
  normal thread submission command. `action: answer` means Mesura accepted a pending answer.
- `turn-running` and `confirmation-pending`: legacy outcomes retained for protocol compatibility.
- `refused`: the target or composer action is invalid.
- `failed`: the renderer or provider start failed before Mesura accepted the submission.

Provider execution is outside the dictation delivery boundary. A later provider error does not
change an accepted dictation into a delivery failure. The legacy retry control and retryable failure
codes remain only for compatibility with an older Shell during rollout.

Persistence flush and readback remain best-effort safeguards. Mesura reports their failures through
safe diagnostics, but it does not discard an append that already exists in the client store. The
exact composer and Shell Transcriptions retain the recovery paths.

Only Shell emits final toasts. A submit success uses the additive `action: submit` field on the
existing `inserted` outcome. Older Shell builds already treat `inserted` as success, but they show
the generic inserted toast. An updated Shell uses `action: submit` to show the sent-message toast.
Mesura and Shell can therefore roll out independently without showing a false failure.

## Presentation ownership

Mesura renews a short lease only when all of these conditions are true:

- The document is visible.
- The Mesura window has focus.
- The displayed target equals the reserved target.
- The strip was not dismissed.

Shell presents the session when the lease is absent or expired. A route change, settings view,
window blur, renderer loss, or explicit strip dismissal releases the lease without changing the STT
job. Progress snapshots do not restart the lease timer.

## Recovery and compatibility

The broker and draft store apply delivery commands idempotently. Renderer reconnect restores the
session. Draft promotion resolves through `futureThreadRef`. Mesura does not restore a provider-turn
watcher because provider execution does not control dictation delivery.

The old destination-less renderer subscription is removed. Mesura still binds the legacy
`symmetria-mesura-<pid>.sock` endpoint during Shell rollout, but that endpoint always returns
`reserved-session-required`. It performs no renderer IPC and never writes text. Current Shell builds
use `symmetria-mesura-dictation-<pid>.sock` and the reserved-session protocol.

## Delivery diagnostics

Desktop traces record renderer request dispatch, resolution, abandonment, and send failure. Each
event includes the request kind, request ID, session ID, command ID, and elapsed milliseconds when
the request ended. Receipt-transition events include the session ID, command ID, outcome, optional
code, elapsed milliseconds, and phase before and after the transition.

Shell logs the normalized final receipt with peer PID, session ID, command ID, outcome, and code.
These diagnostics use an allowlist. They never contain transcript text, composer prompt text,
receipt detail, attachment data, or serialized draft state. Composer persistence diagnostics can
add serialized byte counts and non-reversible prompt hashes when hashing is available.

Focused coverage lives in the `symmetria` test directories under `apps/web/src` and
`apps/desktop/src`. The integration guard in `tests/unit/symmetria-dictation-integration.test.ts`
protects the retired renderer path and the compatibility refusal.
