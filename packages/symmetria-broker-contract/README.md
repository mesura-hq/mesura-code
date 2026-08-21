# @symmetria/broker-contract

The wire contract between this fork and Symmetria Shell: the thread summary, the
surface presence, the command envelope and its receipt, the versioned draft, and
the stream framing. It is a description, not a running thing — no broker, no
publisher, no consumer, no storage.

## Fork-owned, and it stays that way

This package belongs to the Symmetria fork. Nothing under `packages/contracts`
or anywhere else upstream may be edited to serve it, because a change inside an
upstream file is a merge conflict at every weekly upstream synchronization. The
projection borrows upstream vocabulary instead: where upstream exports a schema
value it is composed directly, and where upstream exports only a type,
`src/upstreamLock.ts` binds a local copy to that type so the typecheck fails the
moment the two diverge.

## `schema/` is generated

Every file under `schema/` is emitted from the Effect schemas in `src/` by
`scripts/emit-json-schema.ts`. Do not hand-edit them — the suite rebuilds each
document in memory and compares it byte for byte, so an edit by hand fails
`src/jsonSchema.test.ts` rather than surviving.

Regenerate after any schema change:

```sh
vp run generate
```

Effect Schema is the single source of truth. The JSON Schema documents exist for
consumers that are not TypeScript, and a second hand-maintained description of
the same facts would drift.

## The checksum is what a consumer pins

`schema/index.json` records `contractVersion`, `checksum` and `sourceChecksum`.
`checksum` is a SHA-256 over every emitted document — for each file in ascending
path order, the relative path, a NUL byte, the exact bytes, and a NUL byte. A
second repository pins that value: it is reproducible from the published bytes
alone.

`sourceChecksum` hashes the Effect schemas instead, and it exists because
`checksum` cannot see a change JSON Schema cannot express. A check applied after
a transformation — every upstream `TrimmedNonEmptyString` field is one — is
dropped on emission, so swapping such a field for a bare string emits identical
documents. That edit moves `sourceChecksum`, and the drift test then fails until
somebody regenerates and commits the new value. It also moves on an Effect
upgrade that reshapes the schema tree; that is the intended cost of a change
detector, not a false alarm to suppress.

Emitted object schemas set `additionalProperties` to true at every depth. That is
deliberate and must not be tightened: a consumer is required to ignore additive
unknown fields, and the TypeScript decoder already drops them, so a closed schema
would make a non-TypeScript consumer reject a payload TypeScript accepts.
