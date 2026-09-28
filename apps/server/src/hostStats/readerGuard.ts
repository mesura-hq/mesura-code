import * as Effect from "effect/Effect";

/**
 * Turns any failure or defect of one reader into `nulls` for that reader's
 * fields, so a broken source never costs the rest of the sample.
 */
export const withNullsOnFailure =
  <A>(nulls: A) =>
  <E, R>(reader: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    reader.pipe(Effect.catchCause(() => Effect.succeed(nulls)));
