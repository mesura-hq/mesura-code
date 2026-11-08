/**
 * Mesura: which clients of this host show the developer active, so the push
 * dispatcher can hold pushes while they work at another screen.
 *
 * In memory only: a restart forgets every report, which reads as nobody
 * active, and clients report again on their next change.
 */
import type { PushPresenceRecorded } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * An active report counts this long. A client re-reports while the
 * developer keeps working, so a report this old is from a client that went
 * quiet without closing, such as a laptop that slept.
 */
export const ACTIVE_REPORT_LIFETIME_MS = 2 * 60 * 1000;

interface Report {
  readonly active: boolean;
  readonly reportedAt: number;
  /** The open call that holds the report; null for `report`. */
  readonly callId: number | null;
}

export class ClientPresence extends Context.Service<
  ClientPresence,
  {
    /** Records one connection's latest report, replacing its earlier one. */
    readonly report: (connectionId: string, active: boolean) => Effect.Effect<void>;
    /** Ends one connection's report. */
    readonly disconnect: (connectionId: string) => Effect.Effect<void>;
    /** True while a connection's latest report is active and fresh. */
    readonly isAnyClientActive: () => Effect.Effect<boolean>;
    /**
     * Holds `active` for one connection while the stream runs: it emits once
     * the report is recorded and ends the report when it is interrupted.
     * A newer call from the same connection replaces it, so the older call's
     * end does not remove the newer report.
     */
    readonly holdReport: (
      connectionId: string,
      active: boolean,
    ) => Stream.Stream<PushPresenceRecorded>;
  }
>()("t3/push/ClientPresence") {}

export const make = Effect.sync(() => {
  const reports = new Map<string, Report>();
  let nextCallId = 0;

  const record = (connectionId: string, active: boolean, callId: number | null) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((reportedAt) => void reports.set(connectionId, { active, reportedAt, callId })),
    );

  const report: ClientPresence["Service"]["report"] = (connectionId, active) =>
    record(connectionId, active, null);

  const disconnect: ClientPresence["Service"]["disconnect"] = (connectionId) =>
    Effect.sync(() => void reports.delete(connectionId));

  const isAnyClientActive: ClientPresence["Service"]["isAnyClientActive"] = () =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        for (const entry of reports.values()) {
          if (entry.active && now - entry.reportedAt < ACTIVE_REPORT_LIFETIME_MS) return true;
        }
        return false;
      }),
    );

  const holdReport: ClientPresence["Service"]["holdReport"] = (connectionId, active) =>
    Stream.suspend(() => {
      const callId = nextCallId++;
      const release = Effect.sync(() => {
        if (reports.get(connectionId)?.callId === callId) reports.delete(connectionId);
      });
      return Stream.unwrap(
        record(connectionId, active, callId).pipe(
          Effect.as(Stream.succeed({ active }).pipe(Stream.concat(Stream.never))),
        ),
      ).pipe(Stream.ensuring(release));
    });

  return ClientPresence.of({ report, disconnect, isAnyClientActive, holdReport });
});

export const layer = Layer.effect(ClientPresence, make);
