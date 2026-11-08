/**
 * Puts the dictation session's two halves in order: the command socket listens before the
 * Hyprland binds point at it, and the binds are gone before it closes.
 */
export interface DictationSessionKeys {
  readonly setLive: (live: boolean) => void;
  readonly dispose: () => Promise<void>;
}

export function createDictationSessionKeys(input: {
  readonly binds: {
    readonly enabled: boolean;
    readonly setSessionActive: (active: boolean, socketListening?: boolean) => Promise<void>;
  };
  /** Starts or stops the socket; resolves with whether it listens afterwards. */
  readonly setSocketActive: (active: boolean) => Promise<boolean>;
  readonly onError?: (cause: unknown) => void;
}): DictationSessionKeys {
  let live = false;
  let disposed = false;
  // Serialized, so a quick start and end cannot leave binds pointing at a closed socket, and
  // teardown waits for a start that is still running instead of overtaking it.
  let change: Promise<unknown> = Promise.resolve();
  const enqueue = (step: () => Promise<unknown>) => {
    change = change.then(step).catch((cause: unknown) => input.onError?.(cause));
    return change;
  };
  const start = async () => input.binds.setSessionActive(true, await input.setSocketActive(true));
  const end = async () => {
    await input.binds.setSessionActive(false);
    await input.setSocketActive(false);
  };
  const setLive = (next: boolean) => {
    if (disposed || !input.binds.enabled || next === live) return;
    live = next;
    void enqueue(next ? start : end);
  };
  return {
    setLive,
    dispose: async () => {
      setLive(false);
      disposed = true;
      await change;
    },
  };
}
