import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../index.html?raw";
import { resolveEnvironmentIdentificationPillLabel } from "./branding.logic";

/**
 * The boot shell resolves the stage before React mounts, so it carries its own
 * copy of the rule in `branding.ts`. These tests run that copy directly, which
 * is what stops the two from drifting apart.
 */
const stageScript = (() => {
  const match = indexHtml.match(/<script data-boot="stage">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Could not find the stage boot script in index.html");
  return match[1];
})();

interface StageElement {
  textContent: string;
  hidden: boolean;
}

function runStageScript(input: {
  /** Replaces the `%DEV%` placeholder the way Vite's HTML env hook does. */
  readonly isDev: boolean;
  /** The `content` of the app-channel meta, or null when the tag is absent. */
  readonly channel: string | null;
  /** What `desktopBridge.getAppBranding()` returns, or "throw" to make it fail. */
  readonly injectedStageLabel?: string | "throw";
  /** Set false to make `getElementById` return null. */
  readonly hasStageElement?: boolean;
}): StageElement | null {
  const stageElement: StageElement = { textContent: "", hidden: true };
  const hasStageElement = input.hasStageElement ?? true;

  const desktopBridge =
    input.injectedStageLabel === undefined
      ? undefined
      : {
          getAppBranding: () => {
            if (input.injectedStageLabel === "throw") throw new Error("bridge unavailable");
            return { stageLabel: input.injectedStageLabel };
          },
        };

  const fakeWindow = { desktopBridge };
  const fakeDocument = {
    querySelector: (selector: string) =>
      selector === 'meta[name="app-channel"]' && input.channel !== null
        ? { content: input.channel }
        : null,
    getElementById: (id: string) =>
      id === "boot-shell-stage" && hasStageElement ? stageElement : null,
  };

  const source = stageScript.replaceAll("%DEV%", String(input.isDev));
  new Function("window", "document", source)(fakeWindow, fakeDocument);
  return hasStageElement ? stageElement : null;
}

function expectLabel(element: StageElement | null, label: string | null): void {
  if (label === null) {
    expect(element?.hidden).toBe(true);
    expect(element?.textContent).toBe("");
    return;
  }
  expect(element?.hidden).toBe(false);
  expect(element?.textContent).toBe(label);
}

describe("index.html stage boot script", () => {
  it("names the dev build and leaves a release build unmarked", () => {
    expectLabel(runStageScript({ isDev: true, channel: "" }), "Dev");
    expectLabel(runStageScript({ isDev: false, channel: "" }), null);
  });

  it("prefers the label the desktop shell injects over the build", () => {
    expectLabel(
      runStageScript({ isDev: true, channel: "", injectedStageLabel: "Nightly" }),
      "Nightly",
    );
    // The desktop release build is Alpha even though it is not a dev build.
    expectLabel(runStageScript({ isDev: true, channel: "", injectedStageLabel: "Alpha" }), null);
  });

  it("falls back to the build when the desktop bridge throws or says nothing", () => {
    expectLabel(runStageScript({ isDev: true, channel: "", injectedStageLabel: "throw" }), "Dev");
    expectLabel(runStageScript({ isDev: true, channel: "", injectedStageLabel: "   " }), "Dev");
  });

  it("reads the hosted channel from the meta tag", () => {
    expectLabel(runStageScript({ isDev: false, channel: "nightly" }), "Nightly");
    expectLabel(runStageScript({ isDev: false, channel: "NIGHTLY " }), "Nightly");
    // Latest is a hosted release, so it stays unmarked like Alpha.
    expectLabel(runStageScript({ isDev: false, channel: "latest" }), null);
  });

  it("degrades safely when Vite leaves the placeholder unsubstituted", () => {
    const element = runStageScript({ isDev: false, channel: "%VITE_HOSTED_APP_CHANNEL%" });
    expectLabel(element, null);
  });

  it("survives a missing meta tag and a missing stage element", () => {
    expectLabel(runStageScript({ isDev: true, channel: null }), "Dev");
    expect(() => runStageScript({ isDev: true, channel: "", hasStageElement: false })).not.toThrow();
  });

  it("agrees with the runtime resolver on every stage label", () => {
    for (const [stageLabel, isDev] of [
      ["Dev", true],
      ["Nightly", false],
      ["Alpha", false],
    ] as const) {
      const element = runStageScript({ isDev, channel: "", injectedStageLabel: stageLabel });
      expectLabel(element, resolveEnvironmentIdentificationPillLabel(stageLabel));
    }
  });
});
