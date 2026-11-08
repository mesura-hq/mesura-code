import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";

// A commit is the durable boundary of an orchestration command: the server acks it and
// starts outbox effects after it, so a commit needs SQLite's default FULL (2).
// Regression note: NORMAL (1) was tried for event-loop latency and reverted, because in
// WAL mode it can lose acknowledged commits after a power loss.
it.effect("keeps every commit durable across a power loss (synchronous = FULL)", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    assert.equal(rows[0]?.synchronous, 2);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
