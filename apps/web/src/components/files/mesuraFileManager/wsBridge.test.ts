import type { FileManagerEvent, FileManagerReply } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createWsBridge, type FileManagerTransport, type WsBridgeHooks } from "./wsBridge";

interface Recorded {
  readonly kind: "query" | "mutate";
  readonly sessionId: string;
  readonly channel: string;
  readonly payload: unknown;
}

/**
 * A transport whose session opens when the test says so, so the ready
 * barrier is observable: calls made before `open()` must not reach it.
 */
function fakeTransport(
  answer: (call: Recorded) => FileManagerReply | Promise<FileManagerReply>,
  options: { readonly openImmediately?: boolean } = {},
) {
  const calls: Recorded[] = [];
  let sink: ((event: FileManagerEvent) => void) | null = null;
  let lose: ((cause: unknown) => void) | null = null;
  let open: () => void = () => undefined;
  let refuse: (cause: unknown) => void = () => undefined;
  let stopped = 0;
  const transport: FileManagerTransport = {
    query: (input) => {
      const call = { kind: "query" as const, ...input };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
    mutate: (input) => {
      const call = { kind: "mutate" as const, ...input };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
    events: (_sessionId, onEvent, onLost) => {
      sink = onEvent;
      lose = onLost;
      const ready = new Promise<void>((resolve, reject) => {
        open = resolve;
        refuse = reject;
      });
      if (options.openImmediately !== false) open();
      return {
        ready,
        stop: () => {
          stopped += 1;
          sink = null;
        },
      };
    },
  };
  return {
    transport,
    calls,
    open: () => open(),
    refuse: (cause: unknown) => refuse(cause),
    lose: (cause: unknown) => lose?.(cause),
    push: (event: FileManagerEvent) => sink?.(event),
    get stopped() {
      return stopped;
    },
    get listening() {
      return sink !== null;
    },
  };
}

const ok = (value: unknown): FileManagerReply => ({ ok: true, value });

function hooks(overrides: Partial<WsBridgeHooks> = {}): WsBridgeHooks & {
  readonly writes: string[];
  readonly images: Blob[];
  readonly closes: number[];
  readonly lost: unknown[];
} {
  const writes: string[] = [];
  const images: Blob[] = [];
  const closes: number[] = [];
  const lost: unknown[] = [];
  return {
    writes,
    images,
    closes,
    lost,
    close: () => {
      closes.push(1);
    },
    httpBaseUrl: () => "http://host.example:7777/",
    clipboard: {
      writeText: async (text) => {
        writes.push(text);
      },
      writeImage: async (blob) => {
        images.push(blob);
      },
    },
    fetchBlob: async () => new Blob(["png"], { type: "image/png" }),
    onSessionLost: (cause) => {
      lost.push(cause);
    },
    ...overrides,
  };
}

describe("the WebSocket bridge", () => {
  it("routes read channels to query and write channels to mutate with the request untouched", async () => {
    const { transport, calls } = fakeTransport(() => ok(null));
    const bridge = createWsBridge(transport, hooks());
    const listing = { path: "/tmp", showHidden: false, sort: "alphabetical", reverse: false };

    await bridge.list(listing);
    await bridge.describe({ path: "/tmp/a" });
    await bridge.create({ path: "/tmp/b", kind: "file" });
    await bridge.trash({ paths: ["/tmp/b"] });

    expect(calls.map((call) => [call.kind, call.channel])).toEqual([
      ["query", "symmetria-fm:list"],
      ["query", "symmetria-fm:describe"],
      ["mutate", "symmetria-fm:create"],
      ["mutate", "symmetria-fm:trash"],
    ]);
    expect(calls[0]?.payload).toBe(listing);
    expect(new Set(calls.map((call) => call.sessionId)).size).toBe(1);
    expect(calls[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridge.version).toBe("mesura-code");
  });

  it("holds every call until the server has opened the session", async () => {
    const fake = fakeTransport(() => ok(null), { openImmediately: false });
    const bridge = createWsBridge(fake.transport, hooks());

    const pending = bridge.list({});
    await Promise.resolve();
    expect(fake.calls).toEqual([]);

    fake.open();
    expect(await pending).toEqual({ ok: true, value: null });
    expect(fake.calls).toHaveLength(1);
  });

  it("answers every call as a failure when the session could not open", async () => {
    const fake = fakeTransport(() => ok(null), { openImmediately: false });
    const bridge = createWsBridge(fake.transport, hooks());
    fake.refuse(new Error("not authorised"));

    expect(await bridge.list({})).toEqual({
      ok: false,
      error: { code: "read_failed", message: "not authorised" },
    });
    expect(fake.calls).toEqual([]);
  });

  it("reports a session lost after opening once, and fails fast from then on", async () => {
    const fake = fakeTransport(() => ok(null));
    const owned = hooks();
    const bridge = createWsBridge(fake.transport, owned);
    await bridge.list({});

    fake.lose("socket closed");

    expect(owned.lost).toEqual(["socket closed"]);
    expect(await bridge.create({})).toEqual({
      ok: false,
      error: { code: "write_failed", message: "the file manager's session was lost" },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("delivers a push only to the listener of its channel, until it unsubscribes", () => {
    const fake = fakeTransport(() => ok(null));
    const bridge = createWsBridge(fake.transport, hooks());
    const changed = vi.fn();
    const progress = vi.fn();
    const stopChanged = bridge.onChanged(changed);
    bridge.onTransferProgress(progress);

    fake.push({ channel: "symmetria-fm:changed", payload: { subscriptionId: "w1" } });
    expect(changed).toHaveBeenCalledWith({ subscriptionId: "w1" });
    expect(progress).not.toHaveBeenCalled();

    stopChanged();
    fake.push({ channel: "symmetria-fm:changed", payload: { subscriptionId: "w2" } });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("lets a listener re-arm itself during delivery without being visited twice", () => {
    const fake = fakeTransport(() => ok(null));
    const bridge = createWsBridge(fake.transport, hooks());
    let visits = 0;
    let stop: () => void = () => undefined;
    const listener = () => {
      visits += 1;
      stop();
      stop = bridge.onChanged(listener);
    };
    stop = bridge.onChanged(listener);

    fake.push({ channel: "symmetria-fm:changed", payload: {} });

    expect(visits).toBe(1);
  });

  it("opens the session's event stream on creation and closes it once on dispose", () => {
    const fake = fakeTransport(() => ok(null));
    const bridge = createWsBridge(fake.transport, hooks());

    expect(fake.listening).toBe(true);
    bridge.dispose();
    bridge.dispose();
    expect(fake.listening).toBe(false);
    expect(fake.stopped).toBe(1);
  });

  it("writes text to the browser clipboard without a server call", async () => {
    const fake = fakeTransport(() => ok(null));
    const owned = hooks();
    const bridge = createWsBridge(fake.transport, owned);

    const reply = await bridge.clipboard({ kind: "text", text: "hello" });

    expect(reply).toEqual({ ok: true, value: null });
    expect(owned.writes).toEqual(["hello"]);
    expect(fake.calls).toEqual([]);
  });

  it("copies an image by fetching its preview and writing the blob", async () => {
    const fetched: string[] = [];
    const fake = fakeTransport((call) =>
      call.channel === "symmetria-fm:preview-url"
        ? ok({ url: "/api/file-manager/preview/tok" })
        : ok(null),
    );
    const owned = hooks({
      fetchBlob: async (url) => {
        fetched.push(url);
        return new Blob(["png"], { type: "image/png" });
      },
    });
    const bridge = createWsBridge(fake.transport, owned);

    const reply = await bridge.clipboard({ kind: "image", path: "/tmp/a.png" });

    expect(reply).toEqual({ ok: true, value: null });
    expect(fetched).toEqual(["http://host.example:7777/api/file-manager/preview/tok"]);
    expect(owned.images).toHaveLength(1);
    expect(owned.images[0]?.type).toBe("image/png");
  });

  it("refuses a clipboard request it cannot read, and reports a refused clipboard", async () => {
    const owned = hooks({
      clipboard: {
        writeText: async () => {
          throw new Error("Document is not focused.");
        },
        writeImage: async () => undefined,
      },
    });
    const fake = fakeTransport(() => ok({ nothing: "here" }));
    const bridge = createWsBridge(fake.transport, owned);

    expect(await bridge.clipboard({ kind: "text", text: "x" })).toEqual({
      ok: false,
      error: { code: "write_failed", message: "Document is not focused." },
    });
    expect((await bridge.clipboard("nonsense")).ok).toBe(false);
    expect((await bridge.clipboard({ kind: "image" })).ok).toBe(false);
    // A malformed preview reply is a failure, never a fetch of "undefined".
    expect(await bridge.clipboard({ kind: "image", path: "/tmp/a.png" })).toEqual({
      ok: false,
      error: { code: "invalid_reply", message: "the preview reply carried no URL" },
    });
  });

  it("resolves preview URLs against the environment's HTTP base URL", async () => {
    const fake = fakeTransport((call) =>
      ok({
        url:
          call.channel === "symmetria-fm:preview-url"
            ? "/api/file-manager/preview/file-tok"
            : "/api/file-manager/preview/dir-tok",
      }),
    );
    const bridge = createWsBridge(fake.transport, hooks());

    const file = await bridge.previewUrl({ path: "/tmp/a.pdf" });
    const directory = await bridge.previewDirectoryUrl({ path: "/tmp/doc.md" });

    expect(file).toEqual({
      ok: true,
      value: { url: "http://host.example:7777/api/file-manager/preview/file-tok" },
    });
    expect(directory).toEqual({
      ok: true,
      value: { url: "http://host.example:7777/api/file-manager/preview/dir-tok" },
    });
  });

  it("reports a base URL it cannot resolve against as invalid_reply", async () => {
    const fake = fakeTransport(() => ok({ url: "/api/file-manager/preview/tok" }));
    const bridge = createWsBridge(fake.transport, hooks({ httpBaseUrl: () => "not a url" }));

    expect(await bridge.previewUrl({ path: "/tmp/a.pdf" })).toEqual({
      ok: false,
      error: { code: "invalid_reply", message: "the preview URL could not be resolved" },
    });
  });

  it("closes the layer on hideWindow and answers the window calls without the server", async () => {
    const fake = fakeTransport(() => ok(null));
    const owned = hooks();
    const bridge = createWsBridge(fake.transport, owned);

    await bridge.hideWindow({});
    await bridge.pickerConfirm({ fifo: "/tmp/f", paths: [] });
    await bridge.pickerCancel({ fifo: "/tmp/f" });
    const stop = bridge.onOpenPath(() => undefined);
    stop();

    expect(owned.closes).toEqual([1]);
    expect(fake.calls).toEqual([]);
  });

  it("turns a transport rejection into a failure reply, never a throw", async () => {
    const transport: FileManagerTransport = {
      query: () => Promise.reject(new Error("socket closed")),
      mutate: () => Promise.reject(new Error("socket closed")),
      events: () => ({ ready: Promise.resolve(), stop: () => undefined }),
    };
    const bridge = createWsBridge(transport, hooks());

    const read = await bridge.list({});
    const write = await bridge.create({});

    expect(read).toEqual({ ok: false, error: { code: "read_failed", message: "socket closed" } });
    expect(write).toEqual({ ok: false, error: { code: "write_failed", message: "socket closed" } });
  });
});
