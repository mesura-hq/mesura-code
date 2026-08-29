# Remote file attachments

Remote file attachments move client-local bytes into the environment that owns the thread. The transport is environment-scoped and works for local, LAN, relay, and tunnel connections.

The client creates an upload through the authenticated attachment HTTP route. It sends 5 MiB chunks with the tus offset headers. After an interrupted `PATCH`, the client uses `HEAD` to read the server offset and continues from that byte. Every request uses the environment authorization flow, including a fresh DPoP proof for relay connections.

The composer stores upload state under its draft target. Images and generic files use the same state machine and attachment limit. A route change does not cancel the draft uploads. Before send, the client checks every staged upload with `HEAD`. It marks only unavailable uploads as failed.

The turn command contains opaque upload references. The server claims the references atomically, moves their bytes into immutable attachment storage, and projects canonical message attachments. A failed command releases the claims for retry. Expiry cleanup removes abandoned staged uploads. Cleanup retains uploads whose command receipt is accepted.

Provider adapters receive validated absolute paths. Codex, Claude, Cursor, and Grok keep native image delivery and receive generic files through prompt paths. OpenCode receives native file parts. Title, branch, and regeneration prompts include readable attachment paths.

`@` mentions are separate. They identify an environment-local workspace path and transfer no bytes.

Mobile drafts and outbox records store generic attachment metadata with an app-owned URI. The outbox resolves that URI to an Expo `File`, which implements `Blob`, and uses the same upload client before dispatch. It removes the owned file only after an accepted turn or explicit queue removal. Android and iOS share inputs copy generic native payloads into durable app storage before the share extension payload is acknowledged.
