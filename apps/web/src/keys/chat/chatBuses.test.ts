// No `@vitest-environment` pragma on purpose: these run in Node, where `window`
// is undefined. `MessagesTimeline.test.tsx` renders the timeline there through
// `react-test-renderer`, so the minimap's effect subscribes to the turn-jump
// bus, and the selection toolbar's effect subscribes to the cite bus, with no
// DOM at all.
import { describe, expect, it } from "vite-plus/test";

import { requestChatCite, subscribeChatCiteRequest } from "./chatCiteBus";
import { requestTurnJump, subscribeTurnJumpRequest } from "./chatTurnBus";

describe("chat buses without a window", () => {
  it("runs the chat bus specs where window is undefined", () => {
    expect(typeof window).toBe("undefined");
  });

  it("subscribes to the turn-jump bus without a window and unsubscribes as a no-op", () => {
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = subscribeTurnJumpRequest(() => {});
    }).not.toThrow();
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it("answers a turn-jump request without a window with null", () => {
    expect(requestTurnJump("previous")).toBeNull();
    expect(requestTurnJump("next")).toBeNull();
  });

  it("subscribes to the cite bus without a window and unsubscribes as a no-op", () => {
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = subscribeChatCiteRequest(() => {});
    }).not.toThrow();
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it("answers a cite request without a window with false", () => {
    expect(requestChatCite()).toBe(false);
  });
});
