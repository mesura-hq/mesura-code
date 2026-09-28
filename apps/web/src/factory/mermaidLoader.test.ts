/**
 * The Mermaid loader's cache and queue: failures are not kept, retained SVG
 * stays inside its byte budget, and work for diagrams no longer shown is
 * dropped. `MermaidDiagram` holds one request per mount, so these are the
 * loader's whole contract; the drawing itself is covered through
 * `ChatMarkdown.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MERMAID_CACHE_MAX_BYTES,
  MERMAID_MAX_QUEUED_RENDERS,
  requestMermaidDiagram,
} from "./mermaidLoader";

const stub = vi.hoisted(() => ({
  renders: [] as string[],
  failNext: false,
  svgChars: 16,
  gate: null as Promise<void> | null,
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (id: string, source: string) => {
      if (stub.gate !== null) await stub.gate;
      stub.renders.push(source);
      if (stub.failNext) {
        stub.failNext = false;
        throw new Error("Transient failure");
      }
      return { svg: `<svg id="${id}">${"x".repeat(stub.svgChars)}</svg>` };
    },
  },
}));

let sourceCounter = 0;
const uniqueSource = (label: string) => `flowchart LR\n  ${label}${(sourceCounter += 1)} --> B`;
const rendersOf = (source: string) => stub.renders.filter((entry) => entry === source).length;

beforeEach(() => {
  stub.renders = [];
  stub.failNext = false;
  stub.svgChars = 16;
  stub.gate = null;
});

describe("mermaid loader cache and queue", () => {
  it("shares one pending render per source and theme, so a mounted diagram sees one promise", async () => {
    const source = uniqueSource("shared");
    const first = requestMermaidDiagram(source, "dark");
    const second = requestMermaidDiagram(source, "dark");

    expect(second.result).toBe(first.result);
    expect(await first.result).toMatchObject({ ok: true });
    expect(rendersOf(source)).toBe(1);
  });

  it("does not keep a failed mermaid render, so showing the diagram again retries it", async () => {
    const source = uniqueSource("retry");
    stub.failNext = true;
    const failed = requestMermaidDiagram(source, "dark");
    expect(await failed.result).toEqual({ ok: false, source, message: "Transient failure" });

    const retried = requestMermaidDiagram(source, "dark");
    expect(retried.result).not.toBe(failed.result);
    expect(await retried.result).toMatchObject({ ok: true });
    expect(rendersOf(source)).toBe(2);
  });

  it("charges rendered SVG against the mermaid cache budget and evicts the oldest", async () => {
    // Each SVG takes a quarter of the budget, so the fourth pushes out the oldest.
    stub.svgChars = Math.floor(MERMAID_CACHE_MAX_BYTES / 2 / 4);
    const sources = [uniqueSource("big"), uniqueSource("big"), uniqueSource("big")];
    for (const source of sources) await requestMermaidDiagram(source, "dark").result;
    await requestMermaidDiagram(sources[1]!, "dark").result;
    expect(rendersOf(sources[1]!)).toBe(1);

    await requestMermaidDiagram(uniqueSource("big"), "dark").result;
    await requestMermaidDiagram(sources[0]!, "dark").result;
    expect(rendersOf(sources[0]!)).toBe(2);
  });

  it("skips a queued mermaid render once every diagram showing it has unmounted", async () => {
    let open = () => {};
    stub.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const busy = requestMermaidDiagram(uniqueSource("busy"), "dark");
    const releaseBusy = busy.retain();
    const gone = uniqueSource("gone");
    const release = requestMermaidDiagram(gone, "dark").retain();
    release();
    const kept = uniqueSource("kept");
    const keptRequest = requestMermaidDiagram(kept, "dark");
    const releaseKept = keptRequest.retain();

    open();
    await busy.result;
    await keptRequest.result;
    expect(rendersOf(gone)).toBe(0);
    expect(rendersOf(kept)).toBe(1);
    releaseBusy();
    releaseKept();
  });

  it("bounds the queued mermaid renders and answers the overflow with a retryable failure", async () => {
    let open = () => {};
    stub.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const requests = Array.from({ length: MERMAID_MAX_QUEUED_RENDERS + 2 }, () =>
      requestMermaidDiagram(uniqueSource("queued"), "dark"),
    );
    const overflow = await requests.at(-1)!.result;
    expect(overflow).toMatchObject({ ok: false });

    open();
    const settled = await Promise.all(
      requests.slice(0, MERMAID_MAX_QUEUED_RENDERS).map((r) => r.result),
    );
    expect(settled.every((result) => result.ok)).toBe(true);
  });
});
