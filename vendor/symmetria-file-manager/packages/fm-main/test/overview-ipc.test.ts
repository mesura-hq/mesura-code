import type { OverviewReply } from "@symmetria/fm-core/overview/contract";
import { expect, it } from "vitest";
import { CHANNELS } from "../src/ipc/channels.ts";
import { createRegistry, type IpcHandler, type SenderHandle } from "../src/ipc/register.ts";

function harness(ignoreAbort = false) {
  const handlers = new Map<string, IpcHandler>();
  const pending: { signal: AbortSignal | undefined; resolve: (reply: OverviewReply) => void }[] =
    [];
  const registry = createRegistry(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    },
    {
      previewUrlFor: (token) => token,
      readOverviewDirectory: (_path, _limit, signal) =>
        new Promise((resolve, reject) => {
          pending.push({ signal, resolve });
          if (!ignoreAbort) signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    },
  );
  const a: SenderHandle = { send: () => undefined };
  const b: SenderHandle = { send: () => undefined };
  const invoke = (channel: string, payload: unknown, sender = a) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("missing handler");
    return handler(payload, sender);
  };
  return { registry, pending, a, b, invoke };
}
const request = { path: "/", requestId: "shared", limit: 10 };
it("rejects malformed requests at the registered boundary", async () => {
  const h = harness();
  expect(await h.invoke(CHANNELS.overview, { ...request, limit: 1001 })).toMatchObject({
    ok: false,
    error: { code: "invalid_request" },
  });
  expect(h.pending).toHaveLength(0);
  h.registry.dispose();
});
it("keeps request ownership across channels and independent senders", async () => {
  const h = harness();
  const a = h.invoke(CHANNELS.overview, request);
  const b = h.invoke(CHANNELS.overview, request, h.b);
  expect(
    await h.invoke(CHANNELS.list, {
      path: "/",
      showHidden: false,
      sort: "alphabetical",
      reverse: false,
      stream: false,
      streamId: "shared",
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  await h.invoke(CHANNELS.cancel, { streamId: "shared" });
  expect(await a).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(h.pending[1]?.signal?.aborted).toBe(false);
  h.pending[1]?.resolve({ entries: [], inspected: 0, truncated: false });
  expect(await b).toMatchObject({ ok: true });
  expect(h.registry.trackedWindows()).toBe(0);
  h.registry.dispose();
});
it("disposal cancels active requests and releases the sender", async () => {
  const h = harness();
  const reply = h.invoke(CHANNELS.overview, request);
  h.registry.disposeSender(h.a);
  expect(await reply).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(h.registry.trackedWindows()).toBe(0);
  h.registry.dispose();
});

it("discards a successful late completion after cancellation", async () => {
  const h = harness(true);
  const reply = h.invoke(CHANNELS.overview, request);
  await h.invoke(CHANNELS.cancel, { streamId: "shared" });
  h.pending[0]?.resolve({ entries: [], inspected: 0, truncated: false });
  expect(await reply).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(h.registry.trackedWindows()).toBe(0);
  h.registry.dispose();
});
