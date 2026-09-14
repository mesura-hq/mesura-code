import { playedFraction } from "@symmetria/fm-core/preview/duration";
import { useEffect, useRef, useState } from "react";
import { lazyWorker } from "../../lazyWorker.ts";
import type { WaveformRequest, WaveformResponse } from "../../waveform.worker.ts";
import { decodeAudio, fitsDecodedBudget } from "./decodeAudio.ts";

export interface WaveformProps {
  /** The token URL of the file to draw, or `null` before one arrives. */
  readonly url: string | null;
  /** Seconds played, for the split between drawn-behind and drawn-ahead. */
  readonly position: number;
  /** The file's length, or `null` when it is not known yet. */
  readonly duration: number | null;
}

/**
 * How many bars to ask for.
 *
 * A preview pane is a few hundred pixels wide, and a bar narrower than a pixel
 * is invisible work done on every audio file the cursor rests on. Fixed rather
 * than measured from the element: measuring would make the decode depend on
 * layout, and re-decoding because a pane got wider is a poor trade for a shape
 * nobody is inspecting at that resolution.
 */
const BAR_COUNT = 256;

const reader = lazyWorker(
  () => new Worker(new URL("../../waveform.worker.ts", import.meta.url), { type: "module" }),
);

/** Drop the shared worker. For tests, which must not inherit another's. */
export function forgetWaveformWorker(): void {
  reader.forget();
}

/**
 * The file's shape, or `null` when there is not one to draw.
 *
 * `null` covers every reason at once — too large, undecodable, no worker, still
 * decoding — because the pane does the same thing for all of them: show the
 * file without a waveform. A reason worth telling the user apart from another
 * would need a different return type; none of these is.
 */
function useWaveform(url: string | null, seconds: number | null): Float32Array | null {
  const [bars, setBars] = useState<Float32Array | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    // Clear FIRST, so the previous file's shape never sits under the next
    // file's name while this one decodes.
    setBars(null);
    if (url === null) return;

    // **Wait for the length before decoding anything.** The budget check is the
    // only guard against a codec whose expansion is extreme — measured, 77×
    // for Opus — and it needs a length to apply. An earlier version ran on the
    // URL alone, where `seconds` is always null on the one pass it makes, so
    // the check was present, correct, and never once reached.
    //
    // Waiting costs nothing visible: the media element reports its length from
    // metadata, which it loads in parallel with everything here.
    if (seconds === null) return;
    if (!fitsDecodedBudget(seconds)) return;

    const id = ++nextId.current;
    let listening: Worker | null = null;
    // Abandon the download when the cursor moves on. Without it, sweeping
    // through a directory of audio runs a full fetch and decode for every file
    // passed over and keeps only the last one's answer.
    const abort = new AbortController();

    const onMessage = (event: MessageEvent<WaveformResponse>) => {
      // A stale answer belongs to a file the cursor has already left.
      if (event.data.id !== id) return;
      setBars(event.data.bars.length === 0 ? null : event.data.bars);
    };

    void decodeAudio(url, seconds, abort.signal).then((decoded) => {
      // The decode is the slow half, so the cursor may well have moved during
      // it. Without this the next file would be handed the previous file's
      // samples — and they would arrive with the CURRENT id, so the check
      // above could not catch them.
      if (id !== nextId.current) return;
      // Nothing to draw: too large, undecodable, or no decoder at all. All
      // three leave `bars` null, which the pane renders as one fewer thing.
      if (decoded.kind !== "samples") return;

      const instance = reader.get();
      if (instance === null) return;

      listening = instance;
      instance.addEventListener("message", onMessage);
      const request: WaveformRequest = { id, samples: decoded.samples, bars: BAR_COUNT };
      // TRANSFERRED, not copied: copying 12.5 million samples was measured at
      // 17 ms on this thread, which is most of what moving the work off it
      // saves in the first place.
      instance.postMessage(request, { transfer: [decoded.samples.buffer] });
    });

    return () => {
      abort.abort();
      listening?.removeEventListener("message", onMessage);
    };
  }, [url, seconds]);

  return bars;
}

/**
 * A palette token's value, or `null` when it is not declared.
 *
 * **No hardcoded fallback, deliberately.** A canvas cannot use `var(--token)`,
 * so the value has to be read out — but writing a hex literal here as a safety
 * net breaks the palette invariant `theme.test.ts` enforces, and it breaks it
 * for a case that means the whole stylesheet failed to load. When a token is
 * missing this component does what it does for every other thing it cannot
 * draw: it draws nothing.
 */
function tokenColour(canvas: HTMLCanvasElement, name: string): string | null {
  const value = getComputedStyle(canvas).getPropertyValue(name).trim();
  return value === "" ? null : value;
}

/**
 * Draw the bars, mirrored around the midline, split at the playhead.
 *
 * A canvas rather than a few hundred DOM elements: this repaints roughly four
 * times a second while a file plays, and that many nodes reflowing at that rate
 * is the kind of cost a preview pane cannot carry.
 */
function paint(canvas: HTMLCanvasElement, bars: Float32Array, playedFraction: number): void {
  const context = canvas.getContext("2d");
  // happy-dom has no 2D context, and neither would a host that disabled canvas.
  // Nothing else in the pane depends on this having run.
  if (context === null) return;

  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (bars.length === 0) return;

  const played = tokenColour(canvas, "--primary");
  const ahead = tokenColour(canvas, "--muted-foreground");
  // Two bars in one colour would say the file is entirely played or entirely
  // unplayed, which is worse than an empty box.
  if (played === null || ahead === null) return;

  const middle = height / 2;
  const barWidth = width / bars.length;
  // At least one pixel of gap, and at least one pixel of bar: a sub-pixel bar
  // renders as nothing at all.
  const drawnWidth = Math.max(1, barWidth - 1);
  const boundary = playedFraction * bars.length;

  // `entries()` rather than an index, so `magnitude` is a `number` instead of
  // `number | undefined` and no assertion is needed to say so.
  for (const [i, magnitude] of bars.entries()) {
    // Half the height is the maximum swing in each direction, and a bar of at
    // least one pixel so that silence is still a visible line rather than a gap.
    //
    // Clamped at 1: decoded PCM carries inter-sample peaks above full scale on
    // a hotly mastered track, and `peakBuckets` reports the magnitude it finds
    // rather than a normalised one. Unclamped, such a bar is drawn past the top
    // edge — the canvas hides it silently, which is the shape of defect this
    // run keeps finding.
    const half = Math.max(1, Math.min(magnitude, 1) * middle);

    context.fillStyle = i < boundary ? played : ahead;
    context.fillRect(i * barWidth, middle - half, drawnWidth, half * 2);
  }
}

/**
 * A sound file drawn as its own shape.
 *
 * ── It repaints on `timeupdate`, deliberately, and NOT on a timer ───────────
 * The Qt build this replaces repaints every 50 ms because QML gives it no
 * playback event to hang off. The browser fires `timeupdate` about four times a
 * second while playing and NOT AT ALL while paused, which is both cheaper and
 * correct at the ends — a timer keeps waking a paused pane forever. This
 * component takes `position` as a prop for exactly that reason: the audio
 * element's own event drives it. **Do not "restore parity" by adding a timer.**
 */
export function Waveform({ url, position, duration }: WaveformProps) {
  const bars = useWaveform(url, duration);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  const played = playedFraction(position, duration);

  useEffect(() => {
    if (canvas.current === null || bars === null) return;
    paint(canvas.current, bars, played);
  }, [bars, played]);

  // Nothing to draw is not an error and not an empty box: the pane simply has
  // one fewer thing in it, and every other part of it still works.
  if (bars === null) return null;

  return (
    <canvas
      ref={canvas}
      className="preview__waveform"
      data-testid="preview-audio-waveform"
      // Fixed backing-store size, styled to fill its width. The drawing is a
      // silhouette rather than a diagram, so stretching it costs nothing a
      // reader would notice, and it keeps the paint independent of layout.
      width={BAR_COUNT * 2}
      height={72}
    />
  );
}
