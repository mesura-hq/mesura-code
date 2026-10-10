import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly focusConfirm?: boolean;
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly focusConfirm: boolean;
  readonly resolve: (confirmed: boolean) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

/** The shown state; `focusConfirm` appears only when the request asked for it. */
function confirmingState(pending: PendingConfirmation): ConfirmDialogState {
  return {
    status: "confirming",
    message: pending.message,
    variant: pending.variant,
    ...(pending.focusConfirm ? { focusConfirm: true } : {}),
  };
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that can present themed confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * Requests a themed confirmation when a host is mounted. An undefined result
 * means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  if (registeredHostCount === 0) return undefined;

  const confirmation = new Promise<boolean>((resolve) => {
    const pending = {
      message,
      variant: options?.variant ?? "default",
      focusConfirm: options?.initialFocus === "confirm",
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish(confirmingState(pending));
  });

  return confirmation;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({ status: "closing", message: state.message, variant: state.variant });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish(confirmingState(next));
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
