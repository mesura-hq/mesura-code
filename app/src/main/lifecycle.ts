/**
 * Whether the window may die.
 *
 * Split out of `index.ts` because it is the one piece of the residency change
 * that is a decision rather than a wiring, and a decision is worth being able to
 * test without launching an application.
 *
 * **The trap this exists to avoid.** Intercepting the window's close event is
 * what makes the tabs, the cursor and the scroll survive — a window that is
 * never destroyed cannot lose them. But an interception with no way out makes
 * the process unkillable by the ordinary route: `systemctl --user stop` would
 * hang and only a `SIGKILL` would end it, which is a worse bug than the one
 * being fixed. So the interception yields the moment a deliberate quit starts.
 */
export interface Residency {
  /** Called from `before-quit`, after which no close is intercepted. */
  beginQuit(): void;
  /** False means let the close through and destroy the window. */
  shouldHideOnClose(): boolean;
}

export function createResidency(): Residency {
  // There is deliberately no `isQuitting()` reader. One was written and had no
  // caller, because `shouldHideOnClose` is the only question anybody actually
  // asks — an accessor beside it would be a second way to spell the same state
  // and the two would eventually be used interchangeably.
  let quitting = false;

  return {
    beginQuit: () => {
      quitting = true;
    },
    shouldHideOnClose: () => !quitting,
  };
}
