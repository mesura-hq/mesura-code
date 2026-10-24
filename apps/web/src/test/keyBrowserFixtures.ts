import { vi } from "vite-plus/test";

import {
  composerSurface,
  registerComposerVimAdapter,
  type ComposerVimAdapter,
} from "~/keys/composer/composerSurface";

/** Owns a DOM fixture without replacing the browser runner's document body. */
export function mountKeyDom(html = "") {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return {
    container,
    byTestId: (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!,
    [Symbol.dispose]() {
      window.getSelection()?.removeAllRanges();
      container.remove();
    },
  };
}

/**
 * Captures an app installer that has no uninstall API. Each test then owns the
 * listeners, while the app's module keeps its normal install-once identity.
 */
export function createWindowListenerFixture(install: () => void) {
  const listeners: Array<{
    readonly type: string;
    readonly listener: EventListenerOrEventListenerObject;
    readonly options?: boolean | AddEventListenerOptions | undefined;
  }> = [];
  {
    using _capture = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        listeners.push({ type, listener, options });
      });
    install();
  }
  return () => {
    for (const { type, listener, options } of listeners) {
      window.addEventListener(type, listener, options);
    }
    return {
      [Symbol.dispose]() {
        for (const { type, listener, options } of listeners) {
          window.removeEventListener(type, listener, options);
        }
      },
    };
  };
}

const composerListeners = createWindowListenerFixture(() => {
  const unregister = registerComposerVimAdapter({
    read: () => ({ prompt: "", cursor: 0 }),
    write: () => {},
    setCursor: () => {},
  });
  unregister();
});

/** Owns the composer adapter, focus listeners, and surface reset for one test. */
export function registerTestComposerAdapter(adapter: ComposerVimAdapter) {
  using stack = new DisposableStack();
  stack.use(composerListeners());
  stack.defer(registerComposerVimAdapter(adapter));
  stack.defer(() => composerSurface.reset());
  const lifetime = stack.move();
  return {
    dispose: () => lifetime.dispose(),
    [Symbol.dispose]: () => lifetime.dispose(),
  };
}
