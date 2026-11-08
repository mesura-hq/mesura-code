import { vi } from "vite-plus/test";

import { setRecordingScreenEnvironment } from "./recordingScreen";

/** A page and a wake lock whose requests resolve when the test says so. */
export function createFakeScreen(options: { phone?: boolean; wakeLock?: boolean } = {}) {
  let visibilityState: DocumentVisibilityState = "visible";
  let clock = 0;
  const listeners = new Set<() => void>();
  const pending: Array<{ resolve: (sentinel: WakeLockSentinel) => void; reject: () => void }> = [];
  const sentinels: Array<{ released: boolean; releaseCalls: number }> = [];

  const makeSentinel = (released = false) => {
    const state = { released, releaseCalls: 0 };
    sentinels.push(state);
    return {
      get released() {
        return state.released;
      },
      release: async () => {
        state.releaseCalls += 1;
        state.released = true;
      },
    } as unknown as WakeLockSentinel;
  };

  const wakeLock = {
    request: vi.fn(
      () =>
        new Promise<WakeLockSentinel>((resolve, reject) => {
          pending.push({ resolve, reject: () => reject(new Error("refused")) });
        }),
    ),
  };

  setRecordingScreenEnvironment({
    hiddenPageLosesMicrophone: options.phone ?? true,
    document: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as Document,
    wakeLock: options.wakeLock === false ? undefined : wakeLock,
    now: () => clock,
  });

  return {
    wakeLock,
    sentinels,
    listenerCount: () => listeners.size,
    /** `alreadyReleased`: the page hid between the request and the grant. */
    async grantNext(alreadyReleased = false) {
      pending.shift()!.resolve(makeSentinel(alreadyReleased));
      await Promise.resolve();
      await Promise.resolve();
    },
    async refuseNext() {
      pending.shift()!.reject();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** Hides the page for `ms`; the browser drops a held lock on hide, as Chrome does. */
    hideFor(ms: number) {
      visibilityState = "hidden";
      for (const sentinel of sentinels) sentinel.released = true;
      for (const listener of listeners) listener();
      clock += ms;
      visibilityState = "visible";
      for (const listener of listeners) listener();
    },
    hide() {
      visibilityState = "hidden";
      for (const sentinel of sentinels) sentinel.released = true;
      for (const listener of listeners) listener();
    },
  };
}
