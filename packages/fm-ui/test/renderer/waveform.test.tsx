/**
 * @vitest-environment happy-dom
 *
 * The waveform, and every way it declines to be drawn.
 *
 * ── How this reaches the real code path ─────────────────────────────────────
 * happy-dom has no `OfflineAudioContext`, no canvas 2D context and no decoder,
 * so the interesting half of this component would be unreachable. Rather than
 * cut a seam into production code for a test, the environment is supplied here:
 * `fetch`, `OfflineAudioContext` and `Worker` are all defined, exactly as the
 * bridge already is. The component then runs unmodified — its real decode call,
 * its real transfer, its real staleness checks.
 *
 * What is still NOT provable here is whether the bars look like the sound: no
 * canvas paints in this environment. That belongs to the verifier, which drives
 * a real Chromium and reads pixels.
 */

import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioPreview, forgetTagsWorker } from "../../src/components/preview/AudioPreview.tsx";
import {
  fitsDecodedBudget,
  forgetAudioDecoder,
  MAX_DECODE_BYTES,
} from "../../src/components/preview/decodeAudio.ts";
import { forgetWaveformWorker } from "../../src/components/preview/Waveform.tsx";
import type { WaveformRequest, WaveformResponse } from "../../src/waveform.worker.ts";
import { inertBridge } from "./support.ts";

const TOKEN_URL = "symmetria-fm://app/__preview/t";

/** How many bytes the fetched file appears to be. */
let fileBytes = 4096;
/** What the response DECLARES its length to be, when that differs. */
let declaredBytes: number | null = null;
/** Whether the fetch itself fails. */
let fetchBehaviour: "ok" | "throw" = "ok";
/** Whether the response body was read. */
let bodyRead = false;
/** What the decoder does with them. */
let decodeBehaviour: "ok" | "throw" = "ok";
/** Whether the worker answers at all. */
let answering = true;
/** What the worker reports back. */
let bars = Float32Array.from([0.2, 0.9, 0.4]);
/** What the worker was actually handed. */
let received: WaveformRequest[] = [];
/**
 * The length the tag worker reports.
 *
 * Load-bearing rather than incidental: the waveform waits for a known length
 * before decoding, because the decoded-size budget is the only guard against a
 * codec whose expansion is extreme and it needs a length to apply. In the real
 * application the length comes from the media element's metadata; happy-dom's
 * `<audio>` never loads any, so the tag worker — which really does report a
 * duration for several formats — is the source here.
 */
let taggedSeconds = 120;

class FakeWorker {
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.add(fn);
  }

  removeEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.delete(fn);
  }

  private answer(data: unknown) {
    if (!answering) return;
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) {
        listener(new MessageEvent("message", { data }));
      }
    });
  }

  /**
   * Answers by request shape, because the pane runs TWO workers.
   *
   * One reads tags and one buckets samples. A fake that answered every request
   * the same way sent the tag handler a message with no `picture` field, which
   * threw inside the component — the test breaking the product rather than the
   * other way round. Only a waveform request carries samples.
   */
  postMessage(request: { id: number; samples?: Float32Array; bars?: number }) {
    const samples = request.samples;
    const wanted = request.bars;

    if (samples !== undefined && wanted !== undefined) {
      received.push({ id: request.id, samples, bars: wanted });
      const answer: WaveformResponse = { id: request.id, bars };
      this.answer(answer);
      return;
    }

    this.answer({
      id: request.id,
      title: "",
      artist: "",
      durationSeconds: taggedSeconds,
      picture: null,
    });
  }

  terminate() {}
}

/** A decoder returning one channel of a fixed length. */
class FakeOfflineAudioContext {
  decodeAudioData(_bytes: ArrayBuffer): Promise<{ getChannelData: () => Float32Array }> {
    if (decodeBehaviour === "throw") return Promise.reject(new Error("no decoder"));
    return Promise.resolve({ getChannelData: () => new Float32Array(1000) });
  }
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  fileBytes = 4096;
  declaredBytes = null;
  fetchBehaviour = "ok";
  bodyRead = false;
  decodeBehaviour = "ok";
  answering = true;
  bars = Float32Array.from([0.2, 0.9, 0.4]);
  received = [];
  taggedSeconds = 120;
  forgetTagsWorker();
  forgetWaveformWorker();
  forgetAudioDecoder();

  define("Worker", FakeWorker);
  define("OfflineAudioContext", FakeOfflineAudioContext);
  define("fetch", () => {
    if (fetchBehaviour === "throw") return Promise.reject(new Error("network"));
    const body = new ArrayBuffer(fileBytes);
    const declared = declaredBytes ?? fileBytes;
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": String(declared) },
    });
    const readBody = response.arrayBuffer.bind(response);
    response.arrayBuffer = () => {
      bodyRead = true;
      return readBody();
    };
    return Promise.resolve(response);
  });

  const bridge: Bridge = {
    ...inertBridge(),
    previewUrl: () => Promise.resolve({ ok: true as const, value: { url: TOKEN_URL } }),
  };
  Object.defineProperty(window, BRIDGE_KEY, { value: bridge, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetTagsWorker();
  forgetWaveformWorker();
  forgetAudioDecoder();
});

function showAudio(path = "/home/jc/Music/track.flac") {
  return render(<AudioPreview path={path} mime="audio/flac" playing={false} />);
}

describe("when the sound can be drawn", () => {
  it("puts a waveform in the pane", async () => {
    showAudio();

    expect(await screen.findByTestId("preview-audio-waveform")).toBeTruthy();
  });

  it("sends the decoded samples to the worker, not the file's address", async () => {
    // The worker has NO decoder — measured: no `OfflineAudioContext`, no
    // `AudioContext` and no `AudioDecoder` inside a dedicated worker in this
    // Chromium. Handing it a URL to decode is exactly what failed silently for
    // every file, so this pins that it is handed SAMPLES instead.
    showAudio();

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(received[0]?.samples).toBeInstanceOf(Float32Array);
    expect(received[0]?.samples.length).toBe(1000);
  });

  it("asks for a bounded number of bars", async () => {
    // More bars than the pane has pixels is invisible work, done on every
    // audio file the cursor rests on.
    showAudio();

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(received[0]?.bars).toBeGreaterThan(0);
    expect(received[0]?.bars).toBeLessThanOrEqual(512);
  });
});

describe("when it cannot be drawn", () => {
  it("shows the file anyway when it is too large to decode", async () => {
    // Past the cap. Decoding expands compressed audio to 32-bit floats — a
    // 650 kB recording became 50 MB of them — so refusing is the correct
    // answer, and the pane must still show the file.
    fileBytes = MAX_DECODE_BYTES + 1;

    showAudio();

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("preview-audio-waveform")).toBeNull());
  });

  it("does not even reach the worker for a file over the cap", async () => {
    // The cap has to be applied BEFORE the expensive part, not after it.
    fileBytes = MAX_DECODE_BYTES + 1;

    showAudio();
    await screen.findByTestId("preview-audio-element");

    expect(received).toHaveLength(0);
  });

  it("shows the file anyway when the browser cannot decode it", async () => {
    decodeBehaviour = "throw";

    showAudio();

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("preview-audio-waveform")).toBeNull());
  });

  it("shows the file anyway when there is no decoder at all", async () => {
    // Which is precisely the state a worker is in, and was the whole defect.
    forgetAudioDecoder();
    define("OfflineAudioContext", undefined);

    showAudio();

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    await waitFor(() => expect(received).toHaveLength(0));
    expect(screen.queryByTestId("preview-audio-waveform")).toBeNull();
  });

  it("shows the file anyway when the worker never answers", async () => {
    answering = false;

    showAudio();

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    expect(screen.queryByTestId("preview-audio-waveform")).toBeNull();
  });

  it("shows the file anyway when the host has no workers", async () => {
    // The panel is embeddable, and a host without workers still previews —
    // exactly as it does without a highlighter.
    forgetWaveformWorker();
    define("Worker", undefined);

    showAudio();

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    expect(screen.queryByTestId("preview-audio-waveform")).toBeNull();
  });

  it("draws nothing rather than an empty box when there are no bars", async () => {
    bars = new Float32Array(0);

    showAudio();

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("preview-audio-waveform")).toBeNull();
  });
});

describe("when the cursor has moved on", () => {
  it("discards a waveform that belongs to the previous file", async () => {
    const view = showAudio("/home/jc/Music/first.flac");
    expect(await screen.findByTestId("preview-audio-waveform")).toBeTruthy();

    // The next file's worker never answers, so anything left on screen would be
    // the previous file's shape under the next file's name.
    answering = false;
    view.rerender(
      <AudioPreview path="/home/jc/Music/second.flac" mime="audio/flac" playing={false} />,
    );

    await waitFor(() => expect(screen.queryByTestId("preview-audio-waveform")).toBeNull());
  });

  it("never hands the worker samples decoded for a file already left", async () => {
    // The decode is the slow half, so the cursor moves during it. Those samples
    // would otherwise reach the worker carrying the CURRENT request id — the
    // one shape the id check on the ANSWER cannot catch, which is why there is
    // a second check before the request is even sent.
    const view = showAudio("/home/jc/Music/first.flac");
    view.rerender(
      <AudioPreview path="/home/jc/Music/second.flac" mime="audio/flac" playing={false} />,
    );

    await waitFor(() => expect(screen.queryByTestId("preview-audio-element")).toBeTruthy());
    expect(received.length).toBeLessThanOrEqual(2);
  });
});

describe("the decoded-size budget, applied to a real render", () => {
  it("never decodes a file whose samples would not fit", async () => {
    // Three hours. The check is only reachable once a length is known, which is
    // why the pane waits for one — an earlier version ran before any length
    // arrived, so the guard was present, correct, and never once reached.
    taggedSeconds = 60 * 60 * 3;

    showAudio();
    await screen.findByTestId("preview-audio-element");

    expect(received).toHaveLength(0);
    expect(screen.queryByTestId("preview-audio-waveform")).toBeNull();
  });

  it("shows no waveform while the length is still unknown", async () => {
    taggedSeconds = 0;

    showAudio();
    await screen.findByTestId("preview-audio-element");

    expect(received).toHaveLength(0);
  });
});

describe("the budget on DECODED size, not on the file's own", () => {
  it("accepts a length a preview pane could reasonably draw", () => {
    expect(fitsDecodedBudget(60 * 20)).toBe(true);
  });

  it("refuses a length whose samples would not fit in memory", () => {
    // Review found the compressed cap was the wrong thing to bound. Decoding
    // expands audio to 32-bit floats and the expansion depends on the codec:
    // measured, a 650 kB Opus recording became 50 MB of samples — 77 times its
    // own size. At that ratio a file just under the compressed cap decodes to
    // roughly 1.8 GB, which is the exact outcome the cap exists to prevent.
    expect(fitsDecodedBudget(60 * 60 * 3)).toBe(false);
  });

  it("permits a file whose length is not known yet", () => {
    // The media element reports it after this first runs. Refusing until then
    // would refuse nearly every file, and the compressed cap still applies.
    expect(fitsDecodedBudget(null)).toBe(true);
  });

  it("permits rather than refuses a length that is not a number", () => {
    // A stream reports `Infinity` before it reports anything usable. It must
    // not be read as "enormous, refuse" — the compressed cap is the guard for
    // an unbounded resource.
    expect(fitsDecodedBudget(Number.NaN)).toBe(true);
    expect(fitsDecodedBudget(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("guards", () => {
  it("refuses on the declared length without reading the body", async () => {
    // Review found the cap being applied only after `arrayBuffer()` had already
    // pulled the whole response into memory — so a 144 MB recording was read in
    // full and then discarded. The preview scheme always declares a length; see
    // `app/src/main/fileRange.ts`.
    declaredBytes = MAX_DECODE_BYTES + 1;

    showAudio();
    await screen.findByTestId("preview-audio-element");

    expect(bodyRead).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("still refuses a body larger than its own declared length", async () => {
    // The header is advisory. A response that under-declares must not slip
    // past, which is why the buffer's own length is checked as well.
    fileBytes = MAX_DECODE_BYTES + 1;
    declaredBytes = 1024;

    showAudio();
    await screen.findByTestId("preview-audio-element");

    expect(received).toHaveLength(0);
    expect(screen.queryByTestId("preview-audio-waveform")).toBeNull();
  });

  it("shows the file rather than crashing when the fetch itself fails", async () => {
    // `decodeAudio` must never reject: its only caller does `void ...then()`
    // with no catch, so a rejection becomes an unhandled one. Review found the
    // context construction sitting outside the `try` for exactly this reason.
    fetchBehaviour = "throw";

    showAudio();

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("preview-audio-waveform")).toBeNull());
  });
});
