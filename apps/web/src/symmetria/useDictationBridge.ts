import {
  SymmetriaDictationCommand,
  SymmetriaDictationSession,
  SymmetriaDictationSessionId,
  SymmetriaDictationSource,
  SymmetriaProtocolVersion,
  type SymmetriaDictationSession as DictationSession,
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
  readonly getShellAvailability: () => Promise<unknown>;
  readonly getConfirmationRecovery: () => Promise<unknown>;
  readonly subscribeShellAvailability: (listener: (available: boolean) => void) => () => void;
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
const decodeConfirmationRecovery = Schema.decodeUnknownResult(
  Schema.Struct({ session: SymmetriaDictationSession, commandId: CommandId }),
);

export function shouldResumeConfirmation(
  current: DictationSession | null,
  recovered: DictationSession,
): boolean {
  return (
    current?.phase === "confirming" &&
    current.sessionId === recovered.sessionId &&
    recovered.phase === "confirming"
  );
}

export function useDictationBridge(): void {
  useEffect(() => {
    const bridge = window.symmetriaDictationBridge;
    useDictationSessionStore.getState().setBridgeAvailable(false);
    if (!bridge) return;

    let active = true;
    let observedAvailabilityEvent = false;
    let confirmationRecoveryRequestKey: string | null = null;
    const unsubscribeAvailability = bridge.subscribeShellAvailability((available) => {
      observedAvailabilityEvent = true;
      useDictationSessionStore.getState().setBridgeAvailable(available);
    });
    void bridge
      .getShellAvailability()
      .then((available) => {
        if (active && !observedAvailabilityEvent && typeof available === "boolean") {
          useDictationSessionStore.getState().setBridgeAvailable(available);
        }
      })
      .catch(() => {
        if (active && !observedAvailabilityEvent) {
          useDictationSessionStore.getState().setBridgeAvailable(false);
        }
      });

    const requestConfirmationRecovery = (session: DictationSession): void => {
      const recoveryKey = session.sessionId;
      if (confirmationRecoveryRequestKey === recoveryKey) return;
      confirmationRecoveryRequestKey = recoveryKey;
      void bridge
        .getConfirmationRecovery()
        .then((raw) => {
          const decoded = decodeConfirmationRecovery(raw);
          if (!active) return;
          if (Result.isFailure(decoded)) {
            if (confirmationRecoveryRequestKey === recoveryKey) {
              confirmationRecoveryRequestKey = null;
            }
            return;
          }
          const currentSession = useDictationSessionStore.getState().session;
          if (!shouldResumeConfirmation(currentSession, decoded.success.session)) return;
          void dictationCoordinator
            .resumeConfirmation(decoded.success.session, decoded.success.commandId)
            .catch((cause: unknown) => {
              useDictationSessionStore
                .getState()
                .setError(cause instanceof Error ? cause.message : String(cause));
            });
        })
        .catch(() => {
          if (confirmationRecoveryRequestKey === recoveryKey) {
            confirmationRecoveryRequestKey = null;
          }
        });
    };

    const unsubscribeSession = bridge.subscribe((raw) => {
      if (raw === null) {
        dictationCoordinator.restoreSession(null);
        useDictationSessionStore.getState().setSession(null);
        return;
      }
      const decoded = decodeSession(raw);
      if (Result.isSuccess(decoded)) {
        dictationCoordinator.restoreSession(decoded.success);
        useDictationSessionStore.getState().setSession(decoded.success);
        if (decoded.success.phase === "confirming") requestConfirmationRecovery(decoded.success);
        else if (confirmationRecoveryRequestKey === decoded.success.sessionId) {
          confirmationRecoveryRequestKey = null;
        }
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
      active = false;
      useDictationSessionStore.getState().setBridgeAvailable(false);
      unsubscribeAvailability();
      unsubscribeRequests();
      unsubscribeSession();
    };
  }, []);
}
