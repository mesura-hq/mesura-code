// @effect-diagnostics globalDate:off globalTimers:off -- The broker core runs from socket callbacks outside an Effect fiber. Its one lease timer is cancellable and disposed with the layer.
import {
  SYMMETRIA_PROTOCOL_MAJOR,
  SYMMETRIA_PROTOCOL_MINOR,
  SymmetriaDictationTarget as SymmetriaDictationTargetSchema,
  type SymmetriaDictationTarget,
  type SymmetriaDictationCommand,
  type SymmetriaDictationReceipt,
  type SymmetriaDictationSession,
} from "@symmetria/broker-contract";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  DICTATION_COMMAND_CHANNEL,
  DICTATION_RENDERER_REQUEST_CHANNEL,
  DICTATION_SHELL_AVAILABILITY_CHANNEL,
  DICTATION_SNAPSHOT_CHANNEL,
  GET_DICTATION_CONFIRMATION_RECOVERY_CHANNEL,
  GET_DICTATION_SHELL_AVAILABILITY_CHANNEL,
  GET_DICTATION_SNAPSHOT_CHANNEL,
  RESOLVE_DICTATION_RENDERER_REQUEST_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  defaultRuntimeDir,
  prepareSocketPath,
  removeSocketPath,
  restrictSocketPath,
} from "./socketFiles.ts";
import { createDictationSessionServer } from "./dictationSocket.ts";
import { dictationSocketPath } from "./dictationSocketFiles.ts";
import {
  DICTATION_CAPABILITIES,
  parseDictationClientMessage,
  parseDictationReceipt,
  type DictationReserveRequest,
  type DictationServerMessage,
} from "./dictationProtocol.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";

export type ReservedDictationTarget = {
  readonly target: SymmetriaDictationTarget;
  readonly projectName: string | null;
};

export type DictationBrokerOptions = {
  readonly reserveTarget: (request: DictationReserveRequest) => Promise<ReservedDictationTarget>;
  readonly deliver: (
    command: Extract<SymmetriaDictationCommand, { type: "dictation.deliver" }>,
    reservedTarget: SymmetriaDictationTarget,
  ) => Promise<SymmetriaDictationReceipt>;
  readonly scheduleLeaseExpiration?: (expiresAt: string, expire: () => void) => () => void;
  readonly isShellAvailable?: () => boolean;
  readonly reportDiagnostic?: (event: DictationReceiptTransitionDiagnostic) => void;
  readonly now?: () => number;
};

export type DictationReceiptTransitionDiagnostic = {
  readonly event: "symmetria.dictation.receipt-transition";
  readonly source: "initial" | "late";
  readonly decision: "applied" | "duplicate" | "rejected" | "stale";
  readonly sessionId: string;
  readonly commandId: string;
  readonly outcome: SymmetriaDictationReceipt["outcome"];
  readonly code?: string;
  readonly phaseBefore: SymmetriaDictationSession["phase"] | null;
  readonly phaseAfter: SymmetriaDictationSession["phase"] | null;
  readonly rejectionReason?:
    | "missing-session"
    | "session-mismatch"
    | "command-mismatch"
    | "target-mismatch"
    | "message-mismatch"
    | "terminal-phase"
    | "missing-recorded-receipt"
    | "definitive-failure";
  readonly elapsedMs?: number;
};

export type LocalDictationBroker = {
  readonly reserve: (request: DictationReserveRequest) => Promise<SymmetriaDictationSession>;
  readonly command: (
    command: SymmetriaDictationCommand,
  ) => Promise<SymmetriaDictationReceipt | null>;
  readonly snapshot: () => SymmetriaDictationSession | null;
  readonly confirmationRecovery: () => {
    readonly session: SymmetriaDictationSession;
    readonly commandId: string;
  } | null;
  readonly frame: () => {
    readonly revision: number;
    readonly session: SymmetriaDictationSession | null;
  };
  /** Sends the held snapshot immediately, then all later state. */
  readonly subscribe: (
    listener: (snapshot: SymmetriaDictationSession | null) => void,
  ) => () => void;
  /** Sends only later state. The socket writes its own opening snapshot first. */
  readonly watch: (listener: (snapshot: SymmetriaDictationSession) => void) => () => void;
  readonly watchFrames: (
    listener: (frame: {
      readonly revision: number;
      readonly session: SymmetriaDictationSession | null;
    }) => void,
  ) => () => void;
  readonly watchReceipts: (listener: (receipt: SymmetriaDictationReceipt) => void) => () => void;
  readonly reportLateReceipt: (receipt: SymmetriaDictationReceipt) => boolean;
  readonly expirePresentation: (now: string) => void;
  readonly dispose: () => void;
};

const targetsEqual = (left: SymmetriaDictationTarget, right: SymmetriaDictationTarget): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const withReplayApplication = (receipt: SymmetriaDictationReceipt): SymmetriaDictationReceipt => ({
  ...receipt,
  application: "replay",
});

const phaseForControl = (
  phase: SymmetriaDictationSession["phase"],
  action: Extract<SymmetriaDictationCommand, { type: "dictation.control" }>["action"],
): SymmetriaDictationSession["phase"] => {
  switch (action) {
    case "pause":
      return "paused";
    case "resume":
    case "restart":
    case "start":
      return "recording";
    case "stop":
      return "processing";
    case "cancel":
      return "cancelled";
    case "retry":
      return "delivering";
    case "send-now":
      return phase === "grace" ? "delivering" : phase;
  }
};

const isTerminalPhase = (phase: SymmetriaDictationSession["phase"]): boolean =>
  phase === "completed" || phase === "failed" || phase === "cancelled";

const isUncertainDeliveryFailure = (receipt: SymmetriaDictationReceipt): boolean =>
  receipt.outcome === "failed" &&
  (receipt.code === "deadline_exceeded" || receipt.code === "renderer_lost");

const isAuthoritativeTurnRunningReceipt = (receipt: SymmetriaDictationReceipt): boolean =>
  receipt.outcome === "turn-running" && receipt.messageId === `dictation-${receipt.commandId}`;

export function createDictationBroker(options: DictationBrokerOptions): LocalDictationBroker {
  const now = options.now ?? Date.now;
  let session: SymmetriaDictationSession | null = null;
  let revision = 0;
  let cancelLeaseExpiration: (() => void) | null = null;
  const listeners = new Set<(snapshot: SymmetriaDictationSession) => void>();
  const frameListeners = new Set<
    (frame: {
      readonly revision: number;
      readonly session: SymmetriaDictationSession | null;
    }) => void
  >();
  const receiptListeners = new Set<(receipt: SymmetriaDictationReceipt) => void>();
  const commandLedger = new Map<string, Promise<SymmetriaDictationReceipt | null>>();
  const retryableDeliveryCommands = new Set<string>();
  const appliedDeliveryReceipts = new Map<string, SymmetriaDictationReceipt>();
  const reservationLedger = new Map<string, Promise<SymmetriaDictationSession>>();
  let pendingReservation: {
    readonly sessionId: string;
    readonly promise: Promise<SymmetriaDictationSession>;
  } | null = null;
  let activeDeliveryCommandId: string | null = null;
  let activeDeliveryStartedAt: number | null = null;

  const reportDiagnostic = (event: DictationReceiptTransitionDiagnostic): void => {
    try {
      options.reportDiagnostic?.(event);
    } catch {
      // Observability must never alter broker state transitions.
    }
  };

  const reportReceiptTransition = (
    receipt: SymmetriaDictationReceipt,
    source: DictationReceiptTransitionDiagnostic["source"],
    decision: DictationReceiptTransitionDiagnostic["decision"],
    phaseBefore: SymmetriaDictationSession["phase"] | null,
    phaseAfter: SymmetriaDictationSession["phase"] | null,
    rejectionReason?: DictationReceiptTransitionDiagnostic["rejectionReason"],
  ): void => {
    reportDiagnostic({
      event: "symmetria.dictation.receipt-transition",
      source,
      decision,
      sessionId: receipt.sessionId,
      commandId: receipt.commandId,
      outcome: receipt.outcome,
      ...(receipt.outcome === "failed" || receipt.outcome === "refused"
        ? { code: receipt.code }
        : {}),
      phaseBefore,
      phaseAfter,
      ...(rejectionReason ? { rejectionReason } : {}),
      ...(activeDeliveryStartedAt === null
        ? {}
        : { elapsedMs: Math.max(0, now() - activeDeliveryStartedAt) }),
    });
  };

  const publish = (): void => {
    if (session === null) return;
    revision += 1;
    for (const listener of listeners) listener(session);
    for (const listener of frameListeners) listener({ revision, session });
  };

  const expirePresentation = (now: string): void => {
    if (session === null || !session.presentation.mesuraOwnsPresentation) return;
    const expiresAt = session.presentation.leaseExpiresAt;
    if (expiresAt === null || Date.parse(expiresAt) > Date.parse(now)) return;
    cancelLeaseExpiration?.();
    cancelLeaseExpiration = null;
    session = {
      ...session,
      presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
    };
    publish();
  };

  const reserve = (request: DictationReserveRequest): Promise<SymmetriaDictationSession> => {
    const key = `${request.sessionId}:${request.commandId}`;
    const recorded = reservationLedger.get(key);
    if (recorded !== undefined) return recorded;

    if (pendingReservation !== null) {
      if (pendingReservation.sessionId === request.sessionId) return pendingReservation.promise;
      return Promise.reject(new Error("another dictation reservation is already in progress"));
    }
    if (session !== null && session.sessionId === request.sessionId)
      return Promise.resolve(session);
    if (session !== null && !isTerminalPhase(session.phase)) {
      return Promise.reject(new Error("another dictation session is already active"));
    }
    if (request.source === "mesura" && options.isShellAvailable?.() === false) {
      return Promise.reject(new Error("Symmetria Shell dictation is unavailable"));
    }
    cancelLeaseExpiration?.();
    cancelLeaseExpiration = null;

    const pending = Promise.resolve()
      .then(() => options.reserveTarget(request))
      .then((reservation) => {
        session = {
          protocolVersion: request.protocolVersion,
          sessionId: request.sessionId,
          target: reservation.target,
          source: request.source,
          phase: "recording",
          mode: "submit",
          projectName: reservation.projectName,
          startedAt: request.createdAt,
          elapsedMs: 0,
          audioLevel: null,
          graceRemainingMs: null,
          presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
        };
        activeDeliveryCommandId = null;
        activeDeliveryStartedAt = null;
        retryableDeliveryCommands.clear();
        appliedDeliveryReceipts.clear();
        publish();
        return session;
      })
      .finally(() => {
        if (pendingReservation?.sessionId === request.sessionId) pendingReservation = null;
      });
    pendingReservation = { sessionId: request.sessionId, promise: pending };
    reservationLedger.set(key, pending);
    return pending;
  };

  const applyCommand = async (
    command: SymmetriaDictationCommand,
  ): Promise<SymmetriaDictationReceipt | null> => {
    const reserved = session;
    if (reserved === null || reserved.sessionId !== command.sessionId) {
      if (command.type !== "dictation.deliver") return null;
      const receipt: SymmetriaDictationReceipt = {
        outcome: "refused",
        protocolVersion: command.protocolVersion,
        sessionId: command.sessionId,
        commandId: command.commandId,
        target: command.target,
        application: "first",
        code: "target_missing",
        detail: "the reserved dictation session is not available",
      };
      reportReceiptTransition(receipt, "initial", "applied", null, null);
      return receipt;
    }

    switch (command.type) {
      case "dictation.mode.set":
        if (
          reserved.phase !== "recording" &&
          reserved.phase !== "paused" &&
          reserved.phase !== "processing" &&
          reserved.phase !== "grace"
        ) {
          return null;
        }
        session = { ...reserved, mode: command.mode };
        publish();
        return null;
      case "dictation.control":
        if (command.action === "retry") {
          const sessionPrefix = `${command.sessionId}:`;
          let retryAccepted = false;
          for (const key of retryableDeliveryCommands) {
            if (!key.startsWith(sessionPrefix)) continue;
            retryAccepted = true;
            commandLedger.delete(key);
            retryableDeliveryCommands.delete(key);
            appliedDeliveryReceipts.delete(key);
          }
          if (!retryAccepted) return null;
        }
        session = {
          ...reserved,
          phase: phaseForControl(reserved.phase, command.action),
          lastControl: { commandId: command.commandId, action: command.action },
        };
        publish();
        return null;
      case "dictation.state.update":
        session = {
          ...reserved,
          phase: command.phase,
          elapsedMs: command.elapsedMs,
          audioLevel: command.audioLevel,
          graceRemainingMs: command.graceRemainingMs,
        };
        publish();
        return null;
      case "dictation.action.acknowledge": {
        const acknowledged = { ...reserved };
        if (
          command.actionKind === "control" &&
          acknowledged.lastControl?.commandId === command.acknowledgedCommandId
        ) {
          delete acknowledged.lastControl;
        }
        if (
          command.actionKind === "vocabulary" &&
          acknowledged.lastVocabulary?.commandId === command.acknowledgedCommandId
        ) {
          delete acknowledged.lastVocabulary;
        }
        session = acknowledged;
        publish();
        return null;
      }
      case "dictation.vocabulary.add":
        session = {
          ...reserved,
          lastVocabulary: { commandId: command.commandId, action: "add", word: command.word },
        };
        publish();
        return null;
      case "dictation.vocabulary.remove":
        session = {
          ...reserved,
          lastVocabulary: {
            commandId: command.commandId,
            action: "remove",
            index: command.index,
          },
        };
        publish();
        return null;
      case "dictation.vocabulary.toggle":
        session = {
          ...reserved,
          lastVocabulary: { commandId: command.commandId, action: "toggle" },
        };
        publish();
        return null;
      case "dictation.presentation": {
        if (!targetsEqual(command.target, reserved.target)) return null;
        cancelLeaseExpiration?.();
        cancelLeaseExpiration = null;
        const mesuraOwnsPresentation =
          command.focused && command.visible && command.displayedTarget;
        session = {
          ...reserved,
          presentation: {
            mesuraOwnsPresentation,
            leaseExpiresAt: mesuraOwnsPresentation ? command.leaseExpiresAt : null,
          },
        };
        if (mesuraOwnsPresentation && options.scheduleLeaseExpiration !== undefined) {
          cancelLeaseExpiration = options.scheduleLeaseExpiration(command.leaseExpiresAt, () =>
            expirePresentation(command.leaseExpiresAt),
          );
        }
        publish();
        return null;
      }
      case "dictation.deliver": {
        if (!targetsEqual(command.target, reserved.target)) {
          const receipt: SymmetriaDictationReceipt = {
            outcome: "refused",
            protocolVersion: command.protocolVersion,
            sessionId: command.sessionId,
            commandId: command.commandId,
            target: reserved.target,
            application: "first",
            code: "target_missing",
            detail: "the delivery target differs from the reserved target",
          };
          reportReceiptTransition(
            receipt,
            "initial",
            "applied",
            reserved.phase,
            reserved.phase,
            "target-mismatch",
          );
          return receipt;
        }
        session = { ...reserved, phase: "delivering", mode: command.mode };
        activeDeliveryCommandId = command.commandId;
        activeDeliveryStartedAt = now();
        publish();
        let receipt: SymmetriaDictationReceipt;
        try {
          receipt = await options.deliver(command, reserved.target);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          receipt = {
            outcome: "failed",
            protocolVersion: command.protocolVersion,
            sessionId: command.sessionId,
            commandId: command.commandId,
            target: reserved.target,
            application: "first",
            code: detail.includes("deadline") ? "deadline_exceeded" : "renderer_lost",
            detail,
          };
        }
        const commandKey = `${command.sessionId}:${command.commandId}`;
        const racedLateReceipt = appliedDeliveryReceipts.get(commandKey);
        if (racedLateReceipt !== undefined) {
          reportReceiptTransition(receipt, "initial", "stale", session.phase, session.phase);
          return racedLateReceipt;
        }
        const receiptMatchesCommand =
          receipt.sessionId === command.sessionId &&
          receipt.commandId === command.commandId &&
          targetsEqual(receipt.target, reserved.target);
        if (!receiptMatchesCommand) {
          receipt = {
            outcome: "failed",
            protocolVersion: command.protocolVersion,
            sessionId: command.sessionId,
            commandId: command.commandId,
            target: reserved.target,
            application: "first",
            code: "malformed_input",
            detail: "the renderer receipt does not match the delivery command",
          };
        }
        const phase =
          receipt.outcome === "confirmation-pending"
            ? "confirming"
            : receipt.outcome === "failed" || receipt.outcome === "refused"
              ? "failed"
              : "completed";
        const phaseBefore = session.phase;
        session = { ...session, phase };
        appliedDeliveryReceipts.set(commandKey, receipt);
        cancelLeaseExpiration?.();
        cancelLeaseExpiration = null;
        publish();
        reportReceiptTransition(receipt, "initial", "applied", phaseBefore, phase);
        return receipt;
      }
      case "dictation.reserve":
        return null;
    }
  };

  const command = (
    nextCommand: SymmetriaDictationCommand,
  ): Promise<SymmetriaDictationReceipt | null> => {
    // Progress is a replace-only snapshot update. Reapplying the same values is
    // idempotent, and retaining four updates per second in the durable command
    // ledger would grow memory for the lifetime of the desktop process.
    if (nextCommand.type === "dictation.state.update") return applyCommand(nextCommand);
    const key = `${nextCommand.sessionId}:${nextCommand.commandId}`;
    const recorded = commandLedger.get(key);
    if (recorded !== undefined) {
      return recorded.then((receipt) => (receipt === null ? null : withReplayApplication(receipt)));
    }
    const pending = applyCommand(nextCommand);
    commandLedger.set(key, pending);
    if (nextCommand.type === "dictation.deliver") {
      void pending.then((receipt) => {
        if (
          receipt?.outcome === "failed" &&
          (receipt.code === "provider_start_failed" ||
            receipt.code === "persistence_failed" ||
            receipt.code === "deadline_exceeded")
        ) {
          retryableDeliveryCommands.add(key);
        } else {
          retryableDeliveryCommands.delete(key);
        }
      });
    }
    return pending;
  };

  const watch = (listener: (snapshot: SymmetriaDictationSession) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const reportLateReceipt = (receipt: SymmetriaDictationReceipt): boolean => {
    const phaseBefore = session?.phase ?? null;
    if (session === null) {
      reportReceiptTransition(receipt, "late", "rejected", null, null, "missing-session");
      return false;
    }
    if (receipt.sessionId !== session.sessionId) {
      reportReceiptTransition(
        receipt,
        "late",
        "rejected",
        phaseBefore,
        phaseBefore,
        "session-mismatch",
      );
      return false;
    }
    if (receipt.commandId !== activeDeliveryCommandId) {
      reportReceiptTransition(
        receipt,
        "late",
        "rejected",
        phaseBefore,
        phaseBefore,
        "command-mismatch",
      );
      return false;
    }
    if (!targetsEqual(receipt.target, session.target)) {
      reportReceiptTransition(
        receipt,
        "late",
        "rejected",
        phaseBefore,
        phaseBefore,
        "target-mismatch",
      );
      return false;
    }
    if (receipt.outcome === "turn-running" && !isAuthoritativeTurnRunningReceipt(receipt)) {
      reportReceiptTransition(
        receipt,
        "late",
        "rejected",
        phaseBefore,
        phaseBefore,
        "message-mismatch",
      );
      return false;
    }
    const commandKey = `${receipt.sessionId}:${receipt.commandId}`;
    if (isTerminalPhase(session.phase)) {
      const recorded = appliedDeliveryReceipts.get(commandKey);
      if (recorded !== undefined && JSON.stringify(recorded) === JSON.stringify(receipt)) {
        reportReceiptTransition(receipt, "late", "duplicate", phaseBefore, phaseBefore);
        return true;
      }
      if (session.phase !== "failed") {
        reportReceiptTransition(
          receipt,
          "late",
          "rejected",
          phaseBefore,
          phaseBefore,
          "terminal-phase",
        );
        return false;
      }
      if (recorded === undefined) {
        reportReceiptTransition(
          receipt,
          "late",
          "rejected",
          phaseBefore,
          phaseBefore,
          "missing-recorded-receipt",
        );
        return false;
      }
      if (!isUncertainDeliveryFailure(recorded)) {
        reportReceiptTransition(
          receipt,
          "late",
          "rejected",
          phaseBefore,
          phaseBefore,
          "definitive-failure",
        );
        return false;
      }
    }
    const phase =
      receipt.outcome === "confirmation-pending"
        ? "confirming"
        : receipt.outcome === "failed" || receipt.outcome === "refused"
          ? "failed"
          : "completed";
    session = { ...session, phase };
    appliedDeliveryReceipts.set(commandKey, receipt);
    commandLedger.set(commandKey, Promise.resolve(receipt));
    if (
      receipt.outcome === "failed" &&
      (receipt.code === "provider_start_failed" ||
        receipt.code === "persistence_failed" ||
        receipt.code === "deadline_exceeded")
    ) {
      retryableDeliveryCommands.add(commandKey);
    } else {
      retryableDeliveryCommands.delete(commandKey);
    }
    publish();
    reportReceiptTransition(receipt, "late", "applied", phaseBefore, phase);
    for (const listener of receiptListeners) listener(receipt);
    return true;
  };

  return {
    reserve,
    command,
    snapshot: () => session,
    confirmationRecovery: () =>
      session?.phase === "confirming" && activeDeliveryCommandId !== null
        ? { session, commandId: activeDeliveryCommandId }
        : null,
    frame: () => ({ revision, session }),
    watch,
    watchFrames: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    watchReceipts: (listener) => {
      receiptListeners.add(listener);
      return () => receiptListeners.delete(listener);
    },
    reportLateReceipt,
    subscribe: (listener) => {
      listener(session);
      return watch(listener);
    },
    expirePresentation,
    dispose: () => {
      cancelLeaseExpiration?.();
      cancelLeaseExpiration = null;
      listeners.clear();
      frameListeners.clear();
      receiptListeners.clear();
    },
  };
}

export const isolateDictationBrokerStartup = <A, E, R, R2>(options: {
  readonly start: Effect.Effect<A, E, R>;
  readonly fallback: () => A;
  readonly onFailure: (cause: Cause.Cause<E>) => Effect.Effect<void, never, R2>;
}) =>
  options.start.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return options.onFailure(cause).pipe(Effect.as(options.fallback()));
    }),
  );

const { logInfo, logWarning } = makeComponentLogger("symmetria-dictation-broker");
const RENDERER_DEADLINE_MS = 5_000;

type RendererRequest =
  | { readonly kind: "reserve-target"; readonly request: DictationReserveRequest }
  | {
      readonly kind: "deliver";
      readonly command: Extract<SymmetriaDictationCommand, { type: "dictation.deliver" }>;
      readonly target: SymmetriaDictationTarget;
    };

export type RendererRequestDiagnostic = {
  readonly event: "symmetria.dictation.renderer-request";
  readonly action: "dispatched" | "resolved" | "abandoned" | "send-failed";
  readonly requestId: string;
  readonly kind: RendererRequest["kind"];
  readonly sessionId: string;
  readonly commandId: string;
  readonly elapsedMs?: number;
};

export function createRendererRequestBridge(options: {
  readonly newRequestId: () => string;
  readonly send: (request: RendererRequest & { readonly requestId: string }) => void;
  readonly now?: () => number;
  readonly observe?: (event: RendererRequestDiagnostic) => void;
}) {
  const now = options.now ?? Date.now;
  const pending = new Map<
    string,
    {
      readonly resolve: (result: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly diagnostic: Omit<RendererRequestDiagnostic, "event" | "action" | "elapsedMs">;
      readonly startedAt: number;
    }
  >();
  const observe = (event: RendererRequestDiagnostic): void => {
    try {
      options.observe?.(event);
    } catch {
      // Observability must never alter renderer request delivery.
    }
  };
  const diagnosticFor = (
    requestId: string,
    request: RendererRequest,
  ): Omit<RendererRequestDiagnostic, "event" | "action" | "elapsedMs"> => {
    const correlation = request.kind === "deliver" ? request.command : request.request;
    return {
      requestId,
      kind: request.kind,
      sessionId: correlation.sessionId,
      commandId: correlation.commandId,
    };
  };

  return {
    dispatch: (request: RendererRequest) => {
      const requestId = options.newRequestId();
      const diagnostic = diagnosticFor(requestId, request);
      const startedAt = now();
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, diagnostic, startedAt });
        observe({
          event: "symmetria.dictation.renderer-request",
          action: "dispatched",
          ...diagnostic,
        });
        try {
          options.send({ requestId, ...request });
        } catch (cause) {
          pending.delete(requestId);
          observe({
            event: "symmetria.dictation.renderer-request",
            action: "send-failed",
            ...diagnostic,
            elapsedMs: Math.max(0, now() - startedAt),
          });
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
      return {
        requestId,
        response,
        abandon: () => {
          const request = pending.get(requestId);
          if (request === undefined) return false;
          pending.delete(requestId);
          observe({
            event: "symmetria.dictation.renderer-request",
            action: "abandoned",
            ...request.diagnostic,
            elapsedMs: Math.max(0, now() - request.startedAt),
          });
          return true;
        },
      };
    },
    resolve: (requestId: string, result: unknown): boolean => {
      const request = pending.get(requestId);
      if (request === undefined) return false;
      pending.delete(requestId);
      observe({
        event: "symmetria.dictation.renderer-request",
        action: "resolved",
        ...request.diagnostic,
        elapsedMs: Math.max(0, now() - request.startedAt),
      });
      request.resolve(result);
      return true;
    },
    rejectAll: (error: Error): void => {
      for (const request of pending.values()) {
        observe({
          event: "symmetria.dictation.renderer-request",
          action: "abandoned",
          ...request.diagnostic,
          elapsedMs: Math.max(0, now() - request.startedAt),
        });
        request.reject(error);
      }
      pending.clear();
    },
    pendingCount: (): number => pending.size,
  };
}

export class DictationBroker extends Context.Service<
  DictationBroker,
  {
    readonly socketPath: Option.Option<string>;
    readonly broker: LocalDictationBroker;
  }
>()("@t3tools/desktop/symmetria/DictationBroker") {}

const decodeTarget = Schema.decodeUnknownResult(SymmetriaDictationTargetSchema);

const makeRequired = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runSync = Effect.runSyncWith(context);
  const runPromise = Effect.runPromiseWith(context);
  let rendererRequestCounter = 0;
  const rendererRequests = createRendererRequestBridge({
    newRequestId: () => `dictation-renderer-${(rendererRequestCounter += 1)}`,
    send: (request) => {
      const targetWindow = runSync(electronWindow.currentMainOrFirst);
      if (Option.isNone(targetWindow)) throw new Error("the Mesura renderer is unavailable");
      targetWindow.value.webContents.send(DICTATION_RENDERER_REQUEST_CHANNEL, request);
    },
    observe: (event) => runSync(logInfo("renderer request", event)),
  });
  let shellConnectionCount = 0;

  const requestRenderer = async (request: RendererRequest): Promise<unknown> => {
    const dispatch = rendererRequests.dispatch(request);
    const timed = await runPromise(
      Effect.promise(() => dispatch.response).pipe(
        Effect.timeoutOption(Duration.millis(RENDERER_DEADLINE_MS)),
      ),
    );
    if (Option.isSome(timed)) return timed.value;
    dispatch.abandon();
    throw new Error("the Mesura renderer response deadline expired");
  };

  const broker = createDictationBroker({
    reportDiagnostic: (event) => runSync(logInfo("receipt transition", event)),
    isShellAvailable: () => shellConnectionCount > 0,
    reserveTarget: async (request) => {
      const raw = await requestRenderer({ kind: "reserve-target", request });
      if (typeof raw !== "object" || raw === null) {
        throw new Error("the renderer returned an invalid reservation");
      }
      const result = raw as Record<string, unknown>;
      const target = decodeTarget(result["target"]);
      if (Result.isFailure(target)) {
        throw new Error(`the renderer returned an invalid target: ${target.failure.message}`);
      }
      const projectName = result["projectName"];
      if (projectName !== null && typeof projectName !== "string") {
        throw new Error("the renderer returned an invalid project name");
      }
      return { target: target.success, projectName };
    },
    deliver: async (command, target) => {
      const raw = await requestRenderer({ kind: "deliver", command, target });
      const receipt = parseDictationReceipt(raw);
      if (receipt === null) throw new Error("the renderer returned an invalid delivery receipt");
      return receipt;
    },
    scheduleLeaseExpiration: (expiresAt, expire) => {
      const delayMs = Math.max(0, Date.parse(expiresAt) - Date.now());
      const timer = setTimeout(expire, delayMs);
      return () => clearTimeout(timer);
    },
  });

  yield* ipc.handle({
    channel: RESOLVE_DICTATION_RENDERER_REQUEST_CHANNEL,
    handler: (raw: unknown) =>
      Effect.sync(() => {
        if (typeof raw !== "object" || raw === null) return;
        const response = raw as Record<string, unknown>;
        const requestId = response["requestId"];
        if (typeof requestId !== "string") return;
        rendererRequests.resolve(requestId, response["result"]);
      }),
  });

  yield* ipc.handle({
    channel: GET_DICTATION_SNAPSHOT_CHANNEL,
    handler: () => Effect.sync(() => broker.frame()),
  });

  yield* ipc.handle({
    channel: GET_DICTATION_CONFIRMATION_RECOVERY_CHANNEL,
    handler: () => Effect.sync(() => broker.confirmationRecovery()),
  });

  yield* ipc.handle({
    channel: GET_DICTATION_SHELL_AVAILABILITY_CHANNEL,
    handler: () => Effect.sync(() => shellConnectionCount > 0),
  });

  yield* ipc.handle({
    channel: DICTATION_COMMAND_CHANNEL,
    handler: (raw: unknown) =>
      Effect.promise(async () => {
        if (
          typeof raw === "object" &&
          raw !== null &&
          (raw as Record<string, unknown>)["type"] === "dictation.late-receipt"
        ) {
          const receipt = parseDictationReceipt((raw as Record<string, unknown>)["receipt"]);
          if (receipt === null || !broker.reportLateReceipt(receipt)) {
            return {
              type: "dictation.error",
              code: "malformed_input",
              detail: "the late dictation receipt does not match the active session",
            } satisfies DictationServerMessage;
          }
          return { type: "dictation.receipt", receipt } satisfies DictationServerMessage;
        }
        const parsed = parseDictationClientMessage(raw);
        if (!parsed.ok || parsed.message.type === "dictation.hello") {
          return {
            type: "dictation.error",
            code: parsed.ok ? "malformed_input" : parsed.code,
            detail: parsed.ok ? "the renderer must send a command" : parsed.detail,
          } satisfies DictationServerMessage;
        }
        if (parsed.message.type === "dictation.reserve.request") {
          const session = await broker.reserve(parsed.message);
          return { type: "dictation.snapshot", session } satisfies DictationServerMessage;
        }
        const receipt = await broker.command(parsed.message);
        return receipt === null
          ? ({
              type: "dictation.snapshot",
              session: broker.snapshot(),
            } satisfies DictationServerMessage)
          : ({ type: "dictation.receipt", receipt } satisfies DictationServerMessage);
      }),
  });

  const unsubscribeRenderer = broker.watchFrames((frame) => {
    runPromise(electronWindow.sendAll(DICTATION_SNAPSHOT_CHANNEL, frame)).catch((cause) => {
      runSync(
        logWarning("renderer snapshot delivery failed", {
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    });
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribeRenderer();
      broker.dispose();
      rendererRequests.rejectAll(new Error("the dictation broker stopped"));
    }),
  );

  const socketPath = yield* dictationSocketPath(defaultRuntimeDir(), process.pid);
  const start = Effect.gen(function* () {
    yield* prepareSocketPath(socketPath);
    const server = createDictationSessionServer({
      snapshot: broker.snapshot,
      subscribe: broker.watch,
      subscribeReceipts: (listener) =>
        broker.watchReceipts((receipt) => listener({ type: "dictation.receipt", receipt })),
      onCapabilityChange: (available) => {
        shellConnectionCount = Math.max(0, shellConnectionCount + (available ? 1 : -1));
        runPromise(
          electronWindow.sendAll(DICTATION_SHELL_AVAILABILITY_CHANNEL, shellConnectionCount > 0),
        ).catch((cause) => {
          runSync(
            logWarning("dictation Shell availability delivery failed", {
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          );
        });
      },
      handle: async (message) => {
        if (message.type === "dictation.hello") {
          return {
            type: "dictation.hello",
            protocolVersion: {
              major: SYMMETRIA_PROTOCOL_MAJOR,
              minor: SYMMETRIA_PROTOCOL_MINOR,
            },
            capabilities: DICTATION_CAPABILITIES,
          };
        }
        if (message.type === "dictation.reserve.request") {
          return { type: "dictation.snapshot", session: await broker.reserve(message) };
        }
        const receipt = await broker.command(message);
        return receipt === null ? null : { type: "dictation.receipt", receipt };
      },
      onError: (error) => {
        runSync(logWarning("dictation session connection error", { message: error.message }));
      },
    });
    server.on("error", (error) => {
      runSync(logWarning("dictation session server error", { message: error.message }));
    });

    yield* Effect.acquireRelease(
      Effect.tryPromise(() => listenOnPath(server, socketPath)),
      () =>
        Effect.promise(() => closeServer(server)).pipe(
          Effect.andThen(removeSocketPath(socketPath)),
          Effect.orDie,
        ),
    );
    yield* restrictSocketPath(socketPath);
    yield* logInfo("dictation session socket listening", { socketPath });
    return socketPath;
  });

  const bound = yield* start.pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      logWarning("dictation session socket did not start", {
        socketPath,
        message: cause instanceof Error ? cause.message : String(cause),
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );

  return DictationBroker.of({ socketPath: bound, broker });
});

const unavailableBroker = (): LocalDictationBroker =>
  createDictationBroker({
    reserveTarget: async () => {
      throw new Error("the dictation broker is unavailable");
    },
    deliver: async () => {
      throw new Error("the dictation broker is unavailable");
    },
  });

export const make = isolateDictationBrokerStartup({
  start: makeRequired,
  fallback: () =>
    DictationBroker.of({ socketPath: Option.none<string>(), broker: unavailableBroker() }),
  onFailure: (cause) =>
    logWarning("dictation broker did not start", {
      message: Cause.pretty(cause),
    }),
});

export const layer = Layer.effect(DictationBroker, make);
