import {
  SymmetriaDictationCommand,
  SymmetriaDictationSession,
  SymmetriaDictationSessionId,
  SymmetriaDictationSource,
  SymmetriaProtocolVersion,
} from "@symmetria/broker-contract";
import { CommandId, IsoDateTime } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { dictationCoordinator, type DictationReservationRequest } from "./dictationCoordinator";
import { useDictationSessionStore } from "./dictationSessionStore";

type SymmetriaDictationBridge = {
  readonly subscribe: (listener: (session: unknown) => void) => () => void;
  readonly onRequest: (listener: (request: unknown) => void) => () => void;
  readonly resolveRequest: (requestId: string, result: unknown) => void;
  readonly sendCommand: (command: unknown) => Promise<unknown>;
};

declare global {
  interface Window {
    symmetriaDictationBridge?: SymmetriaDictationBridge;
  }
}

const ReservationRequest = Schema.Struct({
  protocolVersion: SymmetriaProtocolVersion,
  sessionId: SymmetriaDictationSessionId,
  commandId: CommandId,
  createdAt: IsoDateTime,
  source: SymmetriaDictationSource,
});
const decodeReservation = Schema.decodeUnknownResult(ReservationRequest);
const decodeCommand = Schema.decodeUnknownResult(SymmetriaDictationCommand);
const decodeSession = Schema.decodeUnknownResult(SymmetriaDictationSession);

export function useDictationBridge(): void {
  useEffect(() => {
    const bridge = window.symmetriaDictationBridge;
    if (!bridge) return;

    const unsubscribeSession = bridge.subscribe((raw) => {
      if (raw === null) {
        useDictationSessionStore.getState().setSession(null);
        return;
      }
      const decoded = decodeSession(raw);
      if (Result.isSuccess(decoded)) {
        useDictationSessionStore.getState().setSession(decoded.success);
      }
    });

    const unsubscribeRequests = bridge.onRequest((raw) => {
      if (typeof raw !== "object" || raw === null) return;
      const request = raw as Record<string, unknown>;
      const requestId = request["requestId"];
      const kind = request["kind"];
      if (typeof requestId !== "string") return;

      if (kind === "reserve-target") {
        const decoded = decodeReservation(request["request"]);
        if (Result.isFailure(decoded)) {
          bridge.resolveRequest(requestId, { error: "invalid reservation request" });
          return;
        }
        void dictationCoordinator.reserve(decoded.success as DictationReservationRequest).then(
          (reservation) => bridge.resolveRequest(requestId, reservation),
          (cause: unknown) =>
            bridge.resolveRequest(requestId, {
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        );
        return;
      }

      if (kind === "deliver") {
        const decoded = decodeCommand(request["command"]);
        if (Result.isFailure(decoded) || decoded.success.type !== "dictation.deliver") {
          bridge.resolveRequest(requestId, { error: "invalid delivery command" });
          return;
        }
        void dictationCoordinator.deliver(decoded.success).then(
          (receipt) => bridge.resolveRequest(requestId, receipt),
          (cause: unknown) =>
            bridge.resolveRequest(requestId, {
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        );
      }
    });

    return () => {
      unsubscribeRequests();
      unsubscribeSession();
    };
  }, []);
}
