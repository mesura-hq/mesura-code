// Entry point: the Factory run finish announcement `ThreadNotificationCoordinator` drives, from
// one thread observation to the next.
import { describe, expect, it } from "vite-plus/test";

import { createFactoryRunFinishes, factoryRunJustFinished } from "./factoryRunNotification";

const run = (status: "running" | "waiting" | "unclosed" | "done" | "degraded" | "stopped") => ({
  status,
});

describe("factory run finish notification", () => {
  it("announces a run that reaches done or degraded while observed, and nothing else", () => {
    expect(factoryRunJustFinished(run("running"), run("done"))).toBe("done");
    expect(factoryRunJustFinished(run("unclosed"), run("done"))).toBe("done");
    expect(factoryRunJustFinished(run("unclosed"), run("degraded"))).toBe("degraded");
    // A stopped run already asks for the developer as Needs input.
    expect(factoryRunJustFinished(run("running"), run("stopped"))).toBeNull();
    // First sighting, an already finished run, and a thread without a run announce nothing.
    expect(factoryRunJustFinished(undefined, run("done"))).toBeNull();
    expect(factoryRunJustFinished(run("done"), run("done"))).toBeNull();
    expect(factoryRunJustFinished(run("running"), null)).toBeNull();
  });

  it("holds a finish for the turn's completion while the coordinator executes, and announces it once", () => {
    const finishes = createFactoryRunFinishes<string>();
    finishes.record("thread", "done");
    expect(finishes.takeUnannounced("thread", true)).toBeUndefined();
    expect(finishes.take("thread")).toBe("done");
    expect(finishes.take("thread")).toBeUndefined();
    expect(finishes.takeUnannounced("thread", false)).toBeUndefined();
  });

  it("announces a finish on its own when no completion is coming, and forgets departed threads", () => {
    const finishes = createFactoryRunFinishes<string>();
    finishes.record("idle", "degraded");
    expect(finishes.takeUnannounced("idle", false)).toBe("degraded");
    finishes.record("archived", "done");
    finishes.retain(new Set(["idle"]));
    expect(finishes.take("archived")).toBeUndefined();
  });
});
