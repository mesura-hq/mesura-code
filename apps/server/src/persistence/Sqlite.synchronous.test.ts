import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";

// Mesura, phase 6 of the editor latency cycle: a commit is the durable boundary
// of an orchestration command. The server acknowledges the command and starts
// its outbox effects after it, so a commit must survive a power loss: SQLite's
// default FULL (2). NORMAL (1) was tried for the event loop's sake and reverted;
// it can lose acknowledged commits after a power loss in WAL mode.
it.effect("keeps every commit durable across a power loss (synchronous = FULL)", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    assert.equal(rows[0]?.synchronous, 2);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
