import { act, fakeTimers } from "../../../../../test/render";
/**
 * Entry point: `useNvimFileEditor`, the hook `MonacoFileSurface` mounts for
 * modal editing, rendered under React with the status strip below it as
 * `MonacoFileSurface` renders it. Keys enter where Monaco delivers them, the
 * editor's `onKeyDown`, and leave through the real `editorSession.input`
 * command to an RPC session whose replies the test controls. See
 * `~/test/nvimEditorHarness.tsx` for what is real and what is replaced.
 *
 * Phase 1 of the editor latency cycle, criteria 1 to 3:
 * - 1: while an `editorSession.input` request is in flight, later keys are
 *   accumulated and sent as one request when it settles; at most one input
 *   request per thread is in flight.
 * - 2: a batch never exceeds the contract's 1024-character bound and is split
 *   in order instead, never inside one key's notation.
 * - 3: a failed input request (disconnect, server error) never applies a key
 *   twice and never drops one silently: the keys are re-sent in order once
 *   the session is reachable, or the loss is shown in the status strip as an
 *   element marked `data-nvim-input-lost`.
 *
 * Criterion 5 (the latency benchmark) has no spec: the coordinator and the
 * verifier run `bench/bench.sh` for it.
 */
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => () => import("~/test/nvimEditorHarness"));
vi.mock("~/connection/runtime", async () => (await harness()).mockConnectionRuntime());
vi.mock("~/state/server", async () => (await harness()).mockServerState());
vi.mock("monaco-editor", async () => (await harness()).mockMonacoEditor());

import {
  ESCAPE,
  HARNESS_ENVIRONMENT_ID,
  HARNESS_RELATIVE_PATH,
  INPUT_KEYS_LIMIT,
  editorTransport,
  flushHarness,
  harnessThreadRef,
  mountNvimEditor,
  printable,
  settleUntil,
  waitForReal,
} from "~/test/nvimEditorHarness";
import { NvimStatusStrip } from "./NvimStatusStrip";
import { useNvimFileEditor } from "./useNvimFileEditor";

const EXTERNAL_EDITS = { isApplying: () => false, run: (body: () => void) => body() };
const NO_SAVE = () => {};
/** The hook's latest result, for the surface's own calls into it (an agent's edit). */
const latestEditor: { current: ReturnType<typeof useNvimFileEditor> | null } = { current: null };

function EditorUnderTest({ editor }: { readonly editor: unknown }) {
  const nvim = useNvimFileEditor({
    editor: editor as Parameters<typeof useNvimFileEditor>[0]["editor"],
    model: null,
    environmentId: HARNESS_ENVIRONMENT_ID,
    threadRef: harnessThreadRef,
    cwd: "/harness/project",
    relativePath: HARNESS_RELATIVE_PATH,
    enabled: true,
    externalEdits: EXTERNAL_EDITS,
    flushSave: NO_SAVE,
  });
  useEffect(() => {
    latestEditor.current = nvim;
  });
  return (
    <NvimStatusStrip
      mode={nvim.mode}
      jumping={nvim.jumping}
      cmdline={nvim.cmdline}
      message={nvim.message}
      fallback={nvim.fallback}
      onRetry={nvim.retry}
      keysDelivery={nvim.keysDelivery}
    />
  );
}

let mounted: Awaited<ReturnType<typeof mountNvimEditor>> | undefined;

async function mount() {
  mounted = await mountNvimEditor({
    renderEditor: (editor) => <EditorUnderTest editor={editor} />,
  });
  return mounted;
}

async function setupBrowserFixture0() {

  editorTransport.reset();

return {async [Symbol.asyncDispose]() {

  editorTransport.autoReplyAll();
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();

}};
}



const inputPayloads = () => editorTransport.inputs().map((request) => request.payload);

/** What the strip says about undelivered keys: `KEYS LOST`, the retry notice, or null. */
const keysNotice = (container: HTMLElement) =>
  container.querySelector("[data-nvim-status-strip] [data-nvim-input-lost]")?.textContent ?? null;

/** True when no key the developer typed reached Neovim twice. */
const appliedWithoutRepeats = (typed: string, applied: string) => {
  // Every key here is one character, and each was typed once, so a key that
  // reached Neovim twice shows up as a character counted twice.
  const counts = new Map<string, number>();
  for (const character of applied) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts].every(([character, count]) => count <= typed.split(character).length - 1);
};

describe("modal editor key delivery while a request is in flight", () => {
  it("coalesces the keys typed during an in-flight input request into one request", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press } = await mount();
    editorTransport.holdReplies();

    await press(printable("a"));
    await settleUntil(() => editorTransport.inputs().length === 1, "the first key was sent");

    await press(printable("b"));
    await press(printable("c"));
    await press(printable("d"));
    await flushHarness();
    expect(inputPayloads(), "nothing else is sent while the first request is in flight").toEqual([
      "a",
    ]);

    editorTransport.replyNext({ kind: "ok" });
    await settleUntil(() => editorTransport.inputs().length >= 2, "the next batch was sent");
    await flushHarness();

    expect(
      inputPayloads(),
      "the three keys typed while `a` was in flight go out as one request",
    ).toEqual(["a", "bcd"]);
    expect(editorTransport.maxInFlightInputs).toBe(1);

    editorTransport.autoReplyAll();
    await flushHarness();
    expect(editorTransport.appliedKeys()).toBe("abcd");
  });
});

describe("modal editor key batches and the contract's keys bound", () => {
  it("splits an accumulated batch longer than 1024 characters in order, at key boundaries", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press } = await mount();
    editorTransport.holdReplies();

    await press(printable("i"));
    await settleUntil(() => editorTransport.inputs().length === 1, "the first key was sent");

    // Letters with an Escape every seventh key: `<Esc>` is five characters of
    // notation for one key, so a split that counts characters alone lands
    // inside one sooner or later, and Neovim would read `<Es` as three letters.
    const typed: string[] = [];
    for (let index = 0; index < 1100; index += 1) {
      const isEscape = index % 7 === 6;
      const init = isEscape ? ESCAPE : printable(String.fromCharCode(97 + (index % 26)));
      typed.push(isEscape ? "<Esc>" : String(init.key));
      await press(init);
    }
    const expected = `i${typed.join("")}`;
    expect(expected.length).toBeGreaterThan(INPUT_KEYS_LIMIT);

    editorTransport.autoReplyAll();
    await settleUntil(
      () => editorTransport.appliedKeys().length >= expected.length,
      "every typed key reached Neovim",
    );
    await flushHarness();

    const payloads = inputPayloads();
    for (const payload of payloads) expect(payload.length).toBeLessThanOrEqual(INPUT_KEYS_LIMIT);
    expect(editorTransport.appliedKeys()).toBe(expected);

    // Request boundaries fall between keys, never inside `<Esc>`.
    const keyBoundaries = new Set<number>([0]);
    let offset = 1;
    keyBoundaries.add(offset);
    for (const key of typed) {
      offset += key.length;
      keyBoundaries.add(offset);
    }
    let requestBoundary = 0;
    for (const payload of payloads) {
      requestBoundary += payload.length;
      expect(keyBoundaries.has(requestBoundary), `a request ends at ${requestBoundary}`).toBe(true);
    }

    // The 1100 keys typed behind `i` need two requests of at most 1024
    // characters; a split into a handful is allowed, one per key is not.
    expect(payloads.length - 1).toBeLessThanOrEqual(4);
    expect(editorTransport.maxInFlightInputs).toBe(1);
  });

  /**
   * Guard (already true at the base, and must stay so): an operator and its
   * motion typed across a batch boundary reach Neovim in order, `d` before
   * `w`. Neovim reads `nvim_input` as typeahead, so `d` and `w` in two calls
   * are still `dw` when nothing lands between them.
   */
  it("keeps an operator typed in one batch before its motion typed in the next", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press } = await mount();
    editorTransport.holdReplies();

    await press(printable("x"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`x` was sent");
    await press(printable("d"));
    editorTransport.replyNext({ kind: "ok" });
    await settleUntil(() => editorTransport.inputs().length === 2, "`d` was sent");
    await press(printable("w"));
    editorTransport.replyNext({ kind: "ok" });
    await settleUntil(() => editorTransport.inputs().length === 3, "`w` was sent");
    editorTransport.autoReplyAll();
    await flushHarness();

    expect(editorTransport.appliedKeys()).toBe("xdw");
    expect(editorTransport.maxInFlightInputs).toBe(1);
  });
});

describe("modal editor keys after a failed input request", () => {
  it("re-sends the keys of an input request lost to a disconnect, once, in order, or shows the loss", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press, container } = await mount();
    editorTransport.holdReplies();

    await press(printable("a"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`a` was sent");
    await press(printable("b"));
    await flushHarness();

    // The socket closes with `a` in flight: it never reached Neovim.
    editorTransport.disconnect();
    await flushHarness();

    editorTransport.reconnect();
    editorTransport.autoReplyAll();
    await flushHarness();
    await press(printable("c"));
    await flushHarness(20);

    const applied = editorTransport.appliedKeys();
    expect(appliedWithoutRepeats("abc", applied), `applied ${JSON.stringify(applied)}`).toBe(true);
    if (applied !== "abc") {
      // A retry notice is not an outcome: keys still waiting are neither
      // delivered nor reported lost.
      expect(
        keysNotice(container),
        `Neovim was given ${JSON.stringify(applied)} for "abc" typed, and the strip does not say they are lost`,
      ).toBe("KEYS LOST");
    }
  });

  it("delivers the keys typed while the socket was reconnecting, in order, once it is back", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press, container } = await mount();
    editorTransport.holdReplies();

    await press(printable("a"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`a` was sent");

    // The socket drops with `a` in flight, and the developer keeps typing
    // while it reconnects: five keys, each a chance to burn a retry.
    editorTransport.disconnect();
    for (const key of "bcdef") {
      await press(printable(key));
      await flushHarness();
    }

    editorTransport.reconnect();
    editorTransport.autoReplyAll();
    await settleUntil(
      () => editorTransport.appliedKeys() === "abcdef",
      "every key typed across the reconnect reached Neovim",
    );
    await flushHarness();

    expect(editorTransport.appliedKeys()).toBe("abcdef");
    expect(keysNotice(container), "the keys arrived, so nothing is reported").toBeNull();
  });

  it("re-sends on the session's return even after wire failures have backed the lane off", async () => {
await using _browserFixture0 = await setupBrowserFixture0();
using _timers = fakeTimers();
    const { press } = await mount();
    editorTransport.holdReplies();

    await press(printable("a"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`a` was sent");

    // The socket fails requests before the supervisor notices: each try
    // fails on the wire while the session still reads as connected.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      editorTransport.replyNext({ kind: "disconnect" });
      await waitForReal(
        () => editorTransport.inputs().length === attempt + 1,
        5_000,
        `retry ${attempt} was sent`,
      );
    }
    // The fourth failure leaves the lane waiting out its longest pause yet.
    editorTransport.replyNext({ kind: "disconnect" });
    await flushHarness();

    // Then the session goes away for a while, and comes back.
    editorTransport.disconnect();
    await press(printable("b"));
    await act(() => vi.advanceTimersByTimeAsync(300));
    editorTransport.reconnect();
    editorTransport.autoReplyAll();
    // The next backoff exceeds 500 ms. A reconnect must flush the lane before
    // that timer, even when no real time passes in the browser runner.
    await flushHarness();
    await act(() => vi.advanceTimersByTimeAsync(499));
    await flushHarness();
    expect(
      editorTransport.appliedKeys(),
      "the keys waited for a backed-off timer instead of the session's return",
    ).toBe("ab");
  });

  it("re-sends the keys of an input request the server refused, once, in order, or shows the loss", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press, container } = await mount();
    editorTransport.holdReplies();

    await press(printable("a"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`a` was sent");
    await press(printable("b"));
    await flushHarness();

    // The server answers `a` with an error: Neovim was not given it.
    editorTransport.replyNext({ kind: "server-error" });
    await flushHarness();

    editorTransport.autoReplyAll();
    await flushHarness();
    await press(printable("c"));
    await flushHarness(20);

    const applied = editorTransport.appliedKeys();
    expect(appliedWithoutRepeats("abc", applied), `applied ${JSON.stringify(applied)}`).toBe(true);
    if (applied !== "abc") {
      // A retry notice is not an outcome: keys still waiting are neither
      // delivered nor reported lost.
      expect(
        keysNotice(container),
        `Neovim was given ${JSON.stringify(applied)} for "abc" typed, and the strip does not say they are lost`,
      ).toBe("KEYS LOST");
    }
  });
});

/**
 * Guards: behaviour this phase must not break, green at the base.
 */
describe("modal editor key delivery guards", () => {
  it("delivers a long mixed key sequence to Neovim in order with nothing held back", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press } = await mount();

    const presses: Array<{ readonly init: KeyboardEventInit; readonly keys: string }> = [];
    const named: ReadonlyArray<{ readonly init: KeyboardEventInit; readonly keys: string }> = [
      { init: ESCAPE, keys: "<Esc>" },
      { init: { key: "Enter", code: "Enter" }, keys: "<CR>" },
      { init: { key: "Backspace", code: "Backspace" }, keys: "<BS>" },
      { init: { key: "w", code: "KeyW", ctrlKey: true }, keys: "<C-w>" },
      { init: { key: "<", code: "Comma", shiftKey: true }, keys: "<lt>" },
      { init: { key: "Tab", code: "Tab", shiftKey: true }, keys: "<S-Tab>" },
    ];
    for (let index = 0; index < 240; index += 1) {
      const special = index % 5 === 4 ? named[(index / 5) % named.length] : undefined;
      if (special !== undefined) {
        presses.push(special);
        continue;
      }
      const character = "dwciaxjk0$G"[index % 11] ?? "x";
      presses.push({ init: printable(character), keys: character });
    }

    for (const { init } of presses) {
      await press(init);
      // Each key waits for the one before it to land, so nothing is in flight
      // when the next is typed: every key is a request of its own, sent at once.
      await settleUntil(
        () => editorTransport.inputs().every((request) => request.settled),
        "the key was answered",
      );
    }

    expect(inputPayloads()).toEqual(presses.map(({ keys }) => keys));
    expect(editorTransport.appliedKeys()).toBe(presses.map(({ keys }) => keys).join(""));
    expect(editorTransport.maxInFlightInputs).toBe(1);
  });

  it("keeps a mouse cursor move in order with the keys around it, never beside them", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press, click } = await mount();
    editorTransport.holdReplies();

    await press(printable("d"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`d` was sent");
    await click(3, 4);
    await press(printable("w"));
    await flushHarness();

    // An operator waiting for its motion, a click, then a key: the click must
    // land between them, in that order, and never while either is in flight.
    for (let round = 0; round < 6; round += 1) {
      if (editorTransport.requests.some((request) => !request.settled)) {
        const waiting = editorTransport.requests.find((request) => !request.settled);
        if (waiting === undefined) break;
        editorTransport.replyNext({ kind: "ok" }, waiting.method);
      }
      await flushHarness();
    }
    editorTransport.autoReplyAll();
    await flushHarness();

    expect(editorTransport.applied).toEqual([
      { method: "input", payload: "d" },
      { method: "setCursor", payload: "3:4" },
      { method: "input", payload: "w" },
    ]);
    expect(editorTransport.maxInFlightKeyLane).toBe(1);
  });
});

describe("modal editor calls that share the key lane with a coalesced batch", () => {
  it("keeps a click and an agent's edit in order around a coalesced batch in flight", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const { press, click } = await mount();
    editorTransport.holdReplies();

    await press(printable("a"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`a` was sent");
    // While `a` is in flight: two keys, a click, an agent's edit, two more keys.
    await press(printable("b"));
    await press(printable("c"));
    await click(3, 4);
    let taken = false;
    await act(async () => {
      taken =
        latestEditor.current?.takeExternalEdit({
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 1,
          text: "!",
        }) ?? false;
    });
    expect(taken, "the driver handed the agent's edit to Neovim").toBe(true);
    await press(printable("d"));
    await press(printable("e"));

    // Answer each call as it arrives, one at a time.
    for (let round = 0; round < 10; round += 1) {
      const waiting = editorTransport.requests.find(
        (request) => !request.settled && request.method !== "viewport" && request.method !== "open",
      );
      if (waiting !== undefined) editorTransport.replyNext({ kind: "ok" }, waiting.method);
      await flushHarness();
    }
    editorTransport.autoReplyAll();
    await flushHarness();

    const lane = editorTransport.requests
      .filter((request) => ["input", "setCursor", "replaceText"].includes(request.method))
      .map((request) => `${request.method}(${request.payload})`);
    expect(lane).toEqual(["input(a)", "input(bc)", "setCursor(3:4)", "replaceText()", "input(de)"]);
    expect(editorTransport.maxInFlightKeyLane).toBe(1);
  });
});

/**
 * The terminal outcomes, on a controlled clock: keys that cannot be delivered
 * end as `KEYS LOST`, never as a retry notice that stays up forever.
 */
describe("modal editor keys that cannot be delivered", () => {
  async function setupBrowserFixture1() {

return {async [Symbol.asyncDispose]() {

    vi.useRealTimers();
  
}};
}

  /** Moves the fake clock on, letting promises and React run as it goes. */
  async function advance(milliseconds: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  }

  it("reports keys lost once the session has been gone for the outage limit", async () => {
await using _browserFixture0 = await setupBrowserFixture0();
await using _browserFixture1 = await setupBrowserFixture1();

    const { press, container } = await mount();
    using _timers = fakeTimers();
    editorTransport.holdReplies();
    await press(printable("a"));
    await advance(10);
    expect(editorTransport.inputs()).toHaveLength(1);

    editorTransport.disconnect();
    await press(printable("b"));
    await advance(30_000);
    expect(keysNotice(container), "still within the outage limit").toBe("KEYS NOT SENT, RETRYING");

    await advance(31_000);
    expect(keysNotice(container)).toBe("KEYS LOST");
    expect(editorTransport.appliedKeys()).toBe("");

    // The session comes back: later keys go through, and the notice clears.
    editorTransport.reconnect();
    editorTransport.autoReplyAll();
    await press(printable("c"));
    await advance(10);
    expect(editorTransport.appliedKeys()).toBe("c");
    expect(keysNotice(container)).toBeNull();
  });

  it("reports keys lost after the server has refused them six times", async () => {
await using _browserFixture0 = await setupBrowserFixture0();
await using _browserFixture1 = await setupBrowserFixture1();

    const { press, container } = await mount();
    using _timers = fakeTimers();
    editorTransport.holdReplies();
    await press(printable("a"));
    await advance(10);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(editorTransport.inputs(), `attempt ${attempt} was sent`).toHaveLength(attempt);
      editorTransport.replyNext({ kind: "server-error" });
      await advance(attempt < 6 ? 4_100 : 10);
    }
    expect(keysNotice(container)).toBe("KEYS LOST");
    expect(editorTransport.inputs(), "and it stopped retrying").toHaveLength(6);
    expect(editorTransport.appliedKeys()).toBe("");
  });

  it("reports keys lost at once when the server cannot vouch for a re-sent batch", async () => {
await using _browserFixture0 = await setupBrowserFixture0();
await using _browserFixture1 = await setupBrowserFixture1();

    const { press, container } = await mount();
    editorTransport.holdReplies();
    await press(printable("a"));
    await settleUntil(() => editorTransport.inputs().length === 1, "`a` was sent");
    await press(printable("b"));
    editorTransport.replyNext({ kind: "input-lost" });
    await flushHarness();

    expect(keysNotice(container)).toBe("KEYS LOST");
    expect(editorTransport.inputs(), "nothing was re-sent").toHaveLength(1);
  });
});
