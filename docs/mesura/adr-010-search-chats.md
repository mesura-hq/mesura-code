# ADR-010 — Search conversations use ordinary threads

**Status:** Accepted on 2026-10-25 by the developer, with the search-unification plan. It
replaces the design of the unmerged branch `t3code/research-zev-thread-search` (commit
`d4e841fb56`), whose ADR had the number 009. That number now belongs to
`adr-009-modal-keys.md`.

## Decision

An agent search is a conversation, not a list. The developer corrects it ("no, the other
one"), so the model that talks must hold the conversation, and a classifier alone cannot.

- **One ordinary thread per search, in one hidden project.** The project id is
  `THREAD_SEARCH_PROJECT_ID` (`mesura-thread-search`). `StartThreadSearchChat` creates it
  with the stable command id `mesura-thread-search-project-create-v1`. When two clients
  start their first search at the same time, the second command replays the first receipt.
  The project's workspace sits in the server's state directory. It has its own git
  repository for checkpoints, and an `AGENTS.md` that tells the agent how to search.
- **The configured text-generation model owns the conversation.** Each search thread
  starts with that model and with the project's runtime mode.
- **Jev is a tool of that model, not the model.** The model calls the read-only
  `find_threads` MCP tool. Jev (TypeSafe AI, through OpenRouter, key
  `OPENROUTER_JEV_SEARCH_API_KEY` on the server) classifies bounded evidence for that
  tool.
- **Capability.** The `thread-search` capability is granted when a provider session's MCP
  credential is issued, and only when the thread is in the search project. If every
  session held it, any agent could read across the developer's environments through Jev.
  The toolkit registration is shared like the other toolkits, and `find_threads` from any
  other session fails with a capability error.
- **Broker.** The client owns its connections to other environments. The server never
  infers access to a host from another environment's credentials. `ThreadSearchBroker`
  sends each call to one client only, the newest connected one, because broadcasting
  would duplicate API charges and race the answers. That client searches its registered
  environments.
  - The client must stay connected. A disconnect fails the pending call instead of
    returning an empty success.
  - At most four searches can run at once, and a call times out after 240 seconds.
- **Fallback.** No key, a network failure or a 5xx from OpenRouter fails the Jev step
  with `jevUnavailableError`. The client then finishes the search on the configured text
  model, and the result's `engine` says `text-model`. Any other Jev failure, such as a
  rejected key or a malformed answer, is reported to the model as a failure. The search
  never fails only because Jev is missing.
- **Exclusion.** Search conversations repeat the remembered words, so they would outrank
  the thread being searched for. The server leaves the search project out of these reads,
  inside the SQL and before `LIMIT`:
  - the search catalog,
  - the evidence pages,
  - `t3_thread_search`,
  - the agents' project list.

  An evidence window that holds only excluded messages still advances the cursor, so each
  request still scans at most one window. Clients keep the project out of every project
  list, scope picker and settings list.

- **Deletion.** The search project is an internal identity, not a workspace. Generic
  project deletion refuses it, before the cascade would delete its threads, so its
  creation receipt stays valid. One search is deleted through the ordinary thread
  deletion.
- **Links.** Results link with the app's own `t3-thread://v1/<threadId>` URLs. A live
  model once turned a relative path into an invented HTTPS host. A complete app URL ties
  the saved result to no client origin.

## Where it shows

The search opens as a popup from the sidebar's Search field (Tab, or the sparkle button
on touch). The popup holds the conversation and, beside it, the earlier searches. This
replaces the branch's design, which used a separate search screen, a right panel in
`AppSidebarLayout` and a header slot in `ChatHeader`. That design touched more upstream
files, and the developer asked for a popup.

## Merge cost

The upstream files touched are kept to thin calls into fork code.

| File                        | Upstream commits in the 3 months before 2026-10-25 | Change                                                      |
| --------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `ProviderSessionManager.ts` | 21                                                 | grants the capability                                       |
| `McpHttpServer.ts`          | 26                                                 | registers the toolkit                                       |
| `McpInvocationContext.ts`   | 8                                                  | adds the capability name                                    |
| `ThreadSearch.ts`           | 4                                                  | the exclusion predicate                                     |
| `ProjectCommands.ts`        | 3                                                  | the deletion refusal                                        |
| `ProjectService.ts`         | 5                                                  | the refusal before the cascade, and the project list filter |
| `server.ts`                 | 113                                                | provides the server-scope broker and starter                |
| `ws.ts`                     | 172                                                | hands the server-scope services to each connection          |

A future sync must keep:

- the exclusion predicate in `ThreadSearch.ts`;
- the deletion refusal in `ProjectCommands.ts` and `ProjectService.ts`;
- the injection in `ws.ts` (`captureMesuraServerScope`, provided to each connection's
  handler layer). The WebSocket handlers are built once per connection. Building the
  broker or the starter per connection instead would split them: `find_threads` calls
  would reach no client, and two clients' first searches would race to set up the
  workspace.

## Connections

`ws.ts` builds the handler layer once per WebSocket, and every connection's RPC protocol
numbers its client 0. So the starter and the broker live at server scope
(`layerMesuraServerScope` in `wsMesura.ts`), and each connection's handler layer mints its
own UUID. The broker uses that UUID to accept a `find_threads` answer only from the
connection the request went to.

## Configuration

The server reads two environment variables when it starts. On an installed service they go
in `service.env` (`docs/user/background-service.md`).

- `OPENROUTER_JEV_SEARCH_API_KEY`: the OpenRouter key for Jev. When it is unset or blank,
  every search uses the configured text model.
- `OPENROUTER_JEV_SEARCH_ENDPOINT`: replaces the OpenRouter decisions URL, for example
  with a stub for verification. The server sends this endpoint the key as a Bearer token
  and the search evidence: excerpts of the developer's threads. Set it only to an
  endpoint you trust with both.
