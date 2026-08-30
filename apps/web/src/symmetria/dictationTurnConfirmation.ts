import type {
  SymmetriaDictationReceipt,
  SymmetriaDictationSessionId,
  SymmetriaDictationTarget,
  SymmetriaProtocolVersion,
} from "@symmetria/broker-contract";
import type { CommandId, EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";

export type DictationConfirmableTurn = {
  readonly turnId: TurnId;
  readonly state: "running" | "interrupted" | "completed" | "error";
  readonly userMessageId: MessageId | null;
};

type ConfirmationIdentity = {
  readonly protocolVersion: SymmetriaProtocolVersion;
  readonly sessionId: SymmetriaDictationSessionId;
  readonly commandId: CommandId;
  readonly target: SymmetriaDictationTarget;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
};

export type WaitForDictationTurnOptions = ConfirmationIdentity & {
  readonly read: () => DictationConfirmableTurn | null;
  readonly subscribe: (listener: (turn: DictationConfirmableTurn | null) => void) => () => void;
  readonly deadline: Promise<unknown>;
  readonly keepWatchingAfterDeadline?: boolean;
  readonly onLateReceipt?: (receipt: SymmetriaDictationReceipt) => void;
};

const receiptFor = (
  identity: ConfirmationIdentity,
  turn: DictationConfirmableTurn,
): SymmetriaDictationReceipt | null => {
  if (turn.userMessageId !== identity.messageId) return null;
  if (turn.state === "running") {
    return {
      outcome: "turn-running",
      protocolVersion: identity.protocolVersion,
      sessionId: identity.sessionId,
      commandId: identity.commandId,
      target: identity.target,
      application: "first",
      messageId: identity.messageId,
      turnId: turn.turnId,
    };
  }
  if (turn.state === "error") {
    return {
      outcome: "failed",
      protocolVersion: identity.protocolVersion,
      sessionId: identity.sessionId,
      commandId: identity.commandId,
      target: identity.target,
      application: "first",
      code: "provider_turn_failed",
      detail: "the correlated provider turn entered the error state",
    };
  }
  return null;
};

export async function waitForDictationTurn(
  options: WaitForDictationTurnOptions,
): Promise<SymmetriaDictationReceipt> {
  let deadlineReached = false;
  let observedSettled = false;
  const subscription: { unsubscribe?: () => void } = {};
  const resolver: { resolve?: (receipt: SymmetriaDictationReceipt) => void } = {};
  const observed = new Promise<SymmetriaDictationReceipt>((resolve) => {
    resolver.resolve = resolve;
  });
  const accept = (turn: DictationConfirmableTurn | null): void => {
    if (turn === null) return;
    const receipt = receiptFor(options, turn);
    if (receipt === null) return;
    if (deadlineReached) {
      options.onLateReceipt?.(receipt);
      subscription.unsubscribe?.();
      return;
    }
    if (observedSettled) return;
    observedSettled = true;
    subscription.unsubscribe?.();
    resolver.resolve?.(receipt);
  };

  // Subscribe first, then read. An update between the two is either delivered
  // by the subscription or visible in the second read; it cannot fall between them.
  subscription.unsubscribe = options.subscribe(accept);
  if (observedSettled) subscription.unsubscribe();
  else accept(options.read());

  const winner = await Promise.race([
    observed.then((receipt) => ({ kind: "receipt" as const, receipt })),
    options.deadline.then(() => ({ kind: "deadline" as const })),
  ]);
  if (winner.kind === "receipt") return winner.receipt;

  deadlineReached = true;
  if (options.keepWatchingAfterDeadline !== true) subscription.unsubscribe?.();
  return {
    outcome: "confirmation-pending",
    protocolVersion: options.protocolVersion,
    sessionId: options.sessionId,
    commandId: options.commandId,
    target: options.target,
    application: "first",
  };
}

const confirmationDeadline = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });

export function confirmDirectedDictationTurn(
  identity: ConfirmationIdentity,
  options: {
    readonly deadlineMs?: number;
    readonly onLateReceipt?: (receipt: SymmetriaDictationReceipt) => void;
  } = {},
): Promise<SymmetriaDictationReceipt> {
  const threadRef = { environmentId: identity.environmentId, threadId: identity.threadId };
  const atom = environmentThreadShells.threadShellAtom(threadRef);
  const toTurn = (): DictationConfirmableTurn | null => {
    const latest = appAtomRegistry.get(atom)?.latestTurn ?? null;
    return latest === null
      ? null
      : {
          turnId: latest.turnId,
          state: latest.state,
          userMessageId: latest.userMessageId ?? null,
        };
  };
  return waitForDictationTurn({
    ...identity,
    read: toTurn,
    subscribe: (listener) =>
      appAtomRegistry.subscribe(
        atom,
        (thread) => {
          const latest = thread?.latestTurn ?? null;
          listener(
            latest === null
              ? null
              : {
                  turnId: latest.turnId,
                  state: latest.state,
                  userMessageId: latest.userMessageId ?? null,
                },
          );
        },
        { immediate: true },
      ),
    deadline: confirmationDeadline(options.deadlineMs ?? 15_000),
    keepWatchingAfterDeadline: true,
    ...(options.onLateReceipt ? { onLateReceipt: options.onLateReceipt } : {}),
  });
}
