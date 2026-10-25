import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EditorSessionEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { createManager } from "./Manager.testkit.ts";

/**
 * How long a key's text waits for its cursor when the cursor has to be read.
 *
 * The one place these tests wait on a clock, and deliberately: what they pin
 * is the bound itself, `TEXT_WAIT_MS` in `Manager.ts`, and a duration cannot
 * be shown without one. Every threshold here sits well clear of the values it
 * guards, so a fast machine cannot pass for the wrong reason and a loaded one
 * does not fail against them.
 */

const layer = NodeServices.layer;

it.layer(layer, { excludeTestServices: true })("the hold of text for its cursor", (it) => {
  it.effect("keeps text with its cursor when the cursor read is slow", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      fake.lines = ["old"];
      yield* manager.open({
        threadId: "thread-slow",
        cwd: root,
        relativePath: "a.ts",
        lines: ["old"],
      });
      const arrivals: Array<{ readonly event: EditorSessionEvent; readonly at: number }> = [];
      const unsubscribe = yield* manager.attachStream({ threadId: "thread-slow" }, (event) =>
        Effect.sync(() => {
          // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- Manager measures its held-text deadline with performance.now(); the Effect TestClock cannot drive that deadline.
          arrivals.push({ event, at: performance.now() });
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.settleForTest({ threadId: "thread-slow" });
      arrivals.length = 0;

      // No push from the plugin, so the frame reads the cursor, and the read
      // takes a hundred milliseconds.
      fake.holdReplies(
        (method, params) =>
          method === "nvim_exec_lua" && String(params[0]).includes("mesura.cursor_state"),
      );
      fake.cursor = { line: 1, col: 2 };
      // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- Manager measures its held-text deadline with performance.now(); the Effect TestClock cannot drive that deadline.
      const sentAt = performance.now();
      fake.notify("nvim_buf_lines_event", [2, 8, 0, 1, ["xold"], false]);
      fake.notify("redraw", [["mode_change", ["insert", 1]], ["flush"]]);
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- The held reply models a cursor read delayed on Manager's performance.now() clock; preserve the 100 ms timing contract.
      yield* Effect.sleep("100 millis");
      fake.releaseReplies();
      yield* manager.settleForTest({ threadId: "thread-slow" });

      const lines = arrivals.findIndex((arrival) => arrival.event.type === "lines");
      const cursor = arrivals.findIndex(
        (arrival) => arrival.event.type === "cursor" && arrival.event.col === 2,
      );
      assert.notStrictEqual(lines, -1);
      assert.isAtLeast(
        (arrivals[lines]?.at ?? 0) - sentAt,
        80,
        "the text went out before its cursor had been read",
      );
      assert.isAbove(cursor, lines);
      assert.isFalse(
        arrivals.slice(lines + 1, cursor).some((arrival) => arrival.event.type === "lines"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("sends held text alone after a second when Neovim never answers the cursor read", () =>
    Effect.gen(function* () {
      const { manager, fake, root } = yield* createManager();
      fake.lines = ["old"];
      yield* manager.open({
        threadId: "thread-held",
        cwd: root,
        relativePath: "a.ts",
        lines: ["old"],
      });
      const textSent = yield* Deferred.make<void>();
      const arrivals: Array<{ readonly event: EditorSessionEvent; readonly at: number }> = [];
      const unsubscribe = yield* manager.attachStream({ threadId: "thread-held" }, (event) =>
        Effect.sync(() => {
          // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- Manager measures its held-text deadline with performance.now(); the Effect TestClock cannot drive that deadline.
          arrivals.push({ event, at: performance.now() });
          if (event.type === "lines") Deferred.doneUnsafe(textSent, Effect.void);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      // A main loop held by a prompt: the cursor read stays unanswered until the text is sent.
      fake.holdReplies(
        (method, params) =>
          method === "nvim_exec_lua" && String(params[0]).includes("mesura.cursor_state"),
      );
      fake.cursor = { line: 1, col: 2 };
      // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- Manager measures its held-text deadline with performance.now(); the Effect TestClock cannot drive that deadline.
      const sentAt = performance.now();
      fake.notify("nvim_buf_lines_event", [2, 9, 0, 1, ["xold"], false]);
      fake.notify("redraw", [["mode_change", ["insert", 1]], ["flush"]]);
      yield* Deferred.await(textSent);

      const lines = arrivals.find((arrival) => arrival.event.type === "lines");
      assert.isDefined(lines, "the text never went out while the read was stuck");
      const waited = (lines?.at ?? 0) - sentAt;
      assert.isAtLeast(waited, 950);
      assert.isBelow(waited, 2500, "and it is not held for ever");

      // The caret follows once Neovim answers.
      fake.releaseReplies();
      yield* manager.settleForTest({ threadId: "thread-held" });
      assert.isTrue(
        arrivals.some((arrival) => arrival.event.type === "cursor" && arrival.event.col === 2),
      );
    }).pipe(Effect.scoped),
  );
});
