# ADR-007 — Keep the fork's usage-limits UI and subscription registry, adopt upstream's vendor parsers

**Status:** Accepted, 2026-09-20.

**Scope:** how this fork learns what is left on a paid subscription, and which of
two implementations of that it carries. Not about token accounting or spend,
which is upstream's Usage page and is untouched here.

## Decision

**Keep this fork's usage-limits stack and adopt upstream's vendor response
parsers into it.** The split runs along one line: upstream owns _reading a
vendor's payload_, the fork owns _knowing which subscriptions exist and showing
them_.

**The fork keeps, unchanged:**

- `apps/web/src/components/sidebar/AccountLimitsPanel*` — the sidebar band.
- `apps/web/src/state/accountLimits.ts` and `packages/contracts/src/accountLimits.ts`.
- `apps/server/src/usage/SubscriptionRegistry.ts` and `openCodeCredentialDiscovery.ts`.
- `apps/server/src/usage/AccountLimitsService.ts`, including the event ingestion
  that updates one named window from a Claude rate-limit event instead of
  waiting for a poll.
- The **Z.ai** reader in `subscriptionReaders.ts`. Upstream has no Z.ai parser:
  `git grep -i 'api\.z\.ai' upstream/main` over `apps/**` and `packages/**` is
  empty.

**The fork adopts, from upstream:** the per-vendor parsers that turn a payload
into windows — `openCodeUsageLimits.ts`, `claudeUsageLimits.ts`
(`claudeUsageResponseToLimits`), `codexUsageLimits.ts`
(`codexRateLimitsToLimits`), and the `providerUsageLimits.ts` helpers
`makeUsageLimits`, `makeUnavailableUsageLimits` and `clampPercent`.
`cursorUsageLimits.ts` and `grokUsageLimits.ts` come with them and cost nothing
until those providers are enabled.

**The fork does not adopt** upstream's `UsageLimitSources`, its
`collectLimitAccounts` pooling, its Limits tab, or its composer widget. Those
stay in the tree as upstream ships them; nothing here removes or disables them.

## This is not ADR-003 again, and the difference is measurable

ADR-003 retired the fork's attachment stack because upstream's did the same job
better. The obvious reading of `feat(usage): show OpenCode Go, Cursor, and Grok
subscription limits (#12115)` is that the same thing just happened again:
upstream's `openCodeUsageLimits.ts` reads
`https://opencode.ai/zen/go/v1/usage`, which is byte for byte the endpoint the
fork's `OPENCODE_GO_USAGE_URL` already reads.

**That reading is wrong, and the first pass at this decision made it.** Identical
endpoints do not make two designs rivals. What decides it is whether upstream's
code path runs in this fork's configuration at all.

It does not. Upstream hangs usage limits off each provider driver's health
check, and `openCodeUsageLimits.ts` opens with:

```ts
if (!input.enabled || input.serverUrl.trim()) return unsupported;
```

A disabled provider reports `unsupported` and produces no windows. Read against
the live configuration in `~/.mesura-code/userdata` on 2026-09-20:

- Configured providers: `cursor`, `grok`, `opencode` — **all three disabled**.
- Registered subscriptions: `opencode-go`, `zai`.

The developer holds the OpenCode Go subscription without running the OpenCode
provider. Upstream's stack would render an empty panel where the fork's renders
real numbers. For this machine the fork's model is not a matter of taste; it is
the only one of the two that produces output.

## The two models, stated plainly

**Upstream asks:** which providers are installed and signed in here, and what do
they report about themselves? Usage is a property of a running agent.

**This fork asks:** which subscriptions does the developer own, and what is left
on them? Usage is a property of a credential, held in the secret store and keyed
by a digest of itself in `SubscriptionRegistry`.

The two coincide only when a developer runs an agent for every subscription they
pay for. This developer does not, and there is no reason they should: a
subscription is bought, an agent is merely one way to spend it.

## A second difference, corroborating and weaker

Upstream's `collectLimitAccounts` in `packages/shared/src/usageLimits.ts` keys an
account by `` `${driver}:${email}` ``. The deduplication built on that key is
genuinely good — it merges the same account across environments, and across
hub-reported and natively-reported readings, preferring the freshest
`checkedAt`.

But the key stays driver-scoped. One subscription reached through two drivers
lands as two rows with one allowance split between them. `accountLimits.ts`
argues against exactly this:

> This is deliberately not the driver that read the numbers. One subscription
> can be driven by more than one agent — a ChatGPT plan reached through Codex
> and through OpenCode is one plan with one allowance — so keying by reader
> would list it twice and halve the apparent spend of each row.

**This does not bite today.** Only `opencode-go` and `zai` are registered, and
neither is reachable through a second driver here. It is recorded as
corroboration, not as a reason. If it ever became the reason, upstream's pooling
would still need replacing, and this ADR would read the same.

## What upstream is better at, and is therefore adopted

Parsing. A vendor's usage payload is an external contract that changes without
notice, and upstream tracks those changes across five vendors with tests. That
is recurring maintenance the fork should not carry twice.

The fork's own parsers are the part with no durable advantage. They exist
because nothing upstream existed when they were written.

## Where it plugs in

`subscriptionReaders.ts` already has the seam. `readUsage` takes:

```ts
normalize: (payload: unknown) => NormalizedAccountLimits | null;
```

and owns transport and error classification separately — 401 and 403 are
`unauthorized`, 429 and 5xx are `unreachable`, an unparseable body is
`unrecognized`. **Only `normalize` changes.**

Transport, credential discovery and error classification stay the fork's,
because upstream's equivalents read provider auth files rather than the fork's
secret store. `openCodeUsageLimits.ts` decodes an `AuthFile` keyed
`opencode-go`; the fork holds the same credential in its own store, discovered
by `openCodeCredentialDiscovery.ts`. Those cannot be swapped without adopting
upstream's whole provider model, which is the thing this ADR declines.

## The adapter

One new module, with tests: upstream's `ServerProviderUsageLimits` to the fork's
`AccountLimitsWindow`.

| upstream                                      | fork                         |
| --------------------------------------------- | ---------------------------- |
| `id`                                          | `id`                         |
| `label`                                       | `label`                      |
| `usedPercent`                                 | `usedPercent`                |
| `resetsAt` (optional `IsoDateTime`)           | `resetsAt` (nullable string) |
| `windowDurationMins` (optional)               | `windowMinutes` (nullable)   |
| `checkedAt`, on the parent                    | `observedAt`, per window     |
| `kind` (`session`/`weekly`/`monthly`/`other`) | no equivalent                |

`kind` is dropped rather than mapped onto `meter`. `meter` names _what_ is
metered; `kind` names _how long the window is_, which `windowMinutes` already
carries. Forcing one into the other would make both lie.

Keep it in one module. It is the single point where upstream's shape becomes the
fork's, so it is also the single place a future upstream field change has to be
handled.

## What this costs, accepted knowingly

The fork keeps roughly twenty files it could have deleted: the registry, the
service, the contract, the panel and its state. Every one of them is a file a
sync has to carry, and `AccountLimitsService.ts` is not small.

That cost is accepted for two reasons, in this order. The stack works for this
configuration and upstream's does not, which is decisive on its own. And the
developer built the panel, reads it every day, and prefers it — which is a
legitimate reason in a fork maintained by and for one person, and would not be
in a shared project.

What the fork sheds is the per-vendor parsers. That is the churn, not the bulk.

## The follow-on, deliberately not scoped here

Clicking the band should open a deeper analysis of usage. **Do not build that
from scratch.** Upstream ships the deep surface already, in
`apps/web/src/components/usage/`: `UsagePage.tsx`, `UsageLimits.tsx`,
`UsageLimitsPooled.tsx`, `UsageProviderChart.tsx`, `usagePriceTable.ts` and
`UsagePriceOverrides.tsx`, with `feat(web): open Usage on the Limits tab by
default (#11261)`.

The band stays the glanceable surface and routes into upstream's page for the
detail. Scope it after the sync, against upstream's merged code, or it gets
built twice.

## What would reverse this

- The developer enables a provider for every subscription they hold, and keeps
  it that way. Upstream's model would then produce the same rows, and carrying
  two stacks would stop paying for itself.
- Upstream gives `UsageLimitSources` a second source kind, making a
  credential-keyed subscription a first-class concept rather than a hub-only
  one. `UsageLimitSourceConfig.kind` is `Schema.Literal("cliproxy")` today — a
  one-member literal already shaped as a discriminator, so this is a plausible
  direction for them, not a fantasy.
- Upstream adds a Z.ai parser, removing the last thing only this fork reads.

Any one of those is worth re-opening this. None of them is true on 2026-09-20.

## Relationship to the sync

Recorded during the run-up to the sync onto `v0.0.42`, with the fork 1034
commits behind at 143 conflicts. The usage-limits files are not among the
heaviest conflicts; `apps/server/src/usage/UsageService.ts` carried 2 upstream
commits over the range.

Do the parser adoption **after** the merge, not during it. Merging is already
the largest single change this fork has taken, and folding a refactor into it
would make a failure impossible to attribute.

## The mistake this records

The first pass recommended retiring the fork's stack, on the strength of the
endpoint matching. It compared two implementations against each other and never
against the configuration they had to run in — the same failure mode ADR-001 is
kept for, where two candidates were compared to each other and never to the
architecture already running.

**Endpoint identity is not supersession.** Ask whether the upstream code path
executes here at all, before asking which implementation is better.
