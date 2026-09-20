import { describe, expect, it } from "vitest";

import { createResidency } from "../src/main/lifecycle.ts";

/**
 * Whether the window may die.
 *
 * Review asked for this file by name: the module's own header says it was split
 * out of `index.ts` because "a decision is worth being able to test without
 * launching an application", and until now its only coverage was indirect,
 * through a probe inside a real Electron launch.
 *
 * The second test is the one that matters. Intercepting the window's close is
 * what makes the tabs, cursor and scroll survive — but an interception with no
 * way out makes the process unkillable by the ordinary route, so
 * `systemctl --user stop` would hang and only a SIGKILL would end it. That is a
 * worse defect than the one being fixed, and it is invisible until somebody
 * tries to stop the service.
 */
describe("createResidency", () => {
  it("hides on close while the program is meant to keep running", () => {
    expect(createResidency().shouldHideOnClose()).toBe(true);
  });

  it("stops intercepting once a deliberate quit has begun", () => {
    const residency = createResidency();

    residency.beginQuit();

    expect(residency.shouldHideOnClose()).toBe(false);
  });

  it("does not un-quit", () => {
    // `beginQuit` is one-way on purpose: a quit that could be cancelled halfway
    // would leave the close handler guessing which half it is in.
    const residency = createResidency();

    residency.beginQuit();
    residency.beginQuit();

    expect(residency.shouldHideOnClose()).toBe(false);
  });

  it("keeps two instances independent", () => {
    // They hold their own state rather than sharing a module-level flag, which
    // is what makes the module safe to import from more than one place.
    const first = createResidency();
    const second = createResidency();

    first.beginQuit();

    expect(second.shouldHideOnClose()).toBe(true);
  });
});
