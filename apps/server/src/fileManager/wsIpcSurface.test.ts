import type { FileManagerEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { createWsIpcSurface } from "./wsIpcSurface.ts";

function collector() {
  const events: FileManagerEvent[] = [];
  return { events, push: (event: FileManagerEvent) => events.push(event) };
}

const s1 = { owner: "client-a", sessionId: "s1" };
const s2 = { owner: "client-a", sessionId: "s2" };
/** The same id as `s1`, chosen by another connection. */
const s1Elsewhere = { owner: "client-b", sessionId: "s1" };

describe("the WebSocket-shaped IPC surface", () => {
  it("answers a query for a session nobody opened with invalid_request", async () => {
    const transport = createWsIpcSurface();
    transport.surface.handle("symmetria-fm:list", async () => ({ ok: true, value: null }));

    const reply = await transport.invoke(s1, "symmetria-fm:list", {});

    expect(reply).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "session not open" },
    });
  });

  it("answers an unknown channel with invalid_request without throwing", async () => {
    const transport = createWsIpcSurface();
    transport.openSession(s1, collector().push);

    const reply = await transport.invoke(s1, "symmetria-fm:nope", {});

    expect(reply).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "unknown channel" },
    });
  });

  it("routes a handler's push to the session that made the request", async () => {
    const transport = createWsIpcSurface();
    const first = collector();
    const second = collector();
    transport.openSession(s1, first.push);
    transport.openSession(s2, second.push);
    transport.surface.handle("symmetria-fm:watch", async (payload, from) => {
      from.send("symmetria-fm:changed", { echoed: payload });
      return { ok: true, value: null };
    });

    await transport.invoke(s1, "symmetria-fm:watch", { subscriptionId: "w1" });

    expect(first.events).toEqual([
      { channel: "symmetria-fm:changed", payload: { echoed: { subscriptionId: "w1" } } },
    ]);
    expect(second.events).toEqual([]);
  });

  it("keeps two connections' sessions apart even when they chose the same id", async () => {
    const transport = createWsIpcSurface();
    const a = collector();
    const b = collector();
    expect(transport.openSession(s1, a.push)).not.toBeNull();
    expect(transport.openSession(s1Elsewhere, b.push)).not.toBeNull();
    transport.surface.handle("symmetria-fm:watch", async (_payload, from) => {
      from.send("symmetria-fm:changed", { subscriptionId: "w1" });
      return { ok: true, value: null };
    });

    await transport.invoke(s1Elsewhere, "symmetria-fm:watch", {});

    expect(a.events).toEqual([]);
    expect(b.events).toHaveLength(1);
    expect(transport.closeSession(s1)).not.toBeNull();
    // The other connection's session outlives it.
    const reply = await transport.invoke(s1Elsewhere, "symmetria-fm:watch", {});
    expect(reply.ok).toBe(true);
  });

  it("hands back the same handle on close, once, and refuses the session afterwards", async () => {
    const transport = createWsIpcSurface();
    const opened = transport.openSession(s1, collector().push);

    expect(transport.closeSession(s1)).toBe(opened);
    expect(transport.closeSession(s1)).toBeNull();
    const reply = await transport.invoke(s1, "symmetria-fm:list", {});
    expect(reply.ok).toBe(false);
  });

  it("refuses to open a session id twice for one connection while the first is open", () => {
    const transport = createWsIpcSurface();
    const first = transport.openSession(s1, collector().push);

    expect(transport.openSession(s1, collector().push)).toBeNull();
    expect(transport.closeSession(s1)).toBe(first);
  });

  it("reports a handler that throws as the host's fault, naming the channel", async () => {
    const transport = createWsIpcSurface();
    transport.openSession(s1, collector().push);
    transport.surface.handle("symmetria-fm:list", async () => {
      throw new Error("boom");
    });

    const reply = await transport.invoke(s1, "symmetria-fm:list", {});

    expect(reply).toEqual({
      ok: false,
      error: { code: "invalid_reply", message: "symmetria-fm:list: boom" },
    });
  });
});
