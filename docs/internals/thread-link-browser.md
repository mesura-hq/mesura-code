# Thread-link browser constraints

## Allocation and navigation have separate authority

The server owns the designated thread-link tab so that clients connected to
the same environment reuse one tab for the same thread. A client-local slot
cannot enforce this constraint across clients. Keep allocation in the existing
[preview manager](../../apps/server/src/preview/Manager.ts). Do not add a
persistent client target cache or adopt a manual or agent-owned tab.

Allocation does not navigate or grant control. Navigation uses the same
[transport as the address bar](../../apps/web/src/browser/previewNavigationTransport.ts):
the primary desktop uses the native host bridge, while a streamed viewer needs
the existing controller authority and operation permission. The native host
does not use the streamed viewer's controller lease. Shared allocation therefore
does not imply shared arbitration between native and streamed navigation.
Preserve the [stream authorization boundary](../../apps/server/src/preview/ServerBrowserStream.ts).
Server metadata RPCs must not navigate a server-runtime tab.

## Loading is a local milestone

The navigation protocol has no causal request ID. The
[navigation coordinator](../../apps/web/src/browser/threadLinkNavigation.ts)
requires an accepted submission and a fresh Loading observation from the exact
mounted transport. This proves a local milestone, not which client's request
caused the observation or whether the page loaded successfully. A matching URL
or a resolved native bridge promise alone cannot supply that proof.

## Cancellation must survive reconciliation

An authoritative allocation response can arrive after a close, route change,
or disconnect. The [thread-link action](../../apps/web/src/browser/openThreadLinkInPreview.ts)
must retain its connection and close guards before reconciliation and recheck
the target afterward. Otherwise, a stale response can revive a closed tab or
navigate a replacement connection. Reconnection does not renew a cancelled
action. Keep pending navigation transient; do not replay it from a persistent
target cache.
