import { formatDuration, playedFraction } from "@symmetria/fm-core/preview/duration";
import { useEffect, useRef, useState } from "react";

import { lazyWorker } from "../../lazyWorker.ts";
import type { TagsRequest, TagsResponse } from "../../tags.worker.ts";
import { usePreviewUrl } from "./previewUrl.ts";
import { useMediaProgress } from "./useMediaProgress.ts";
import { Waveform } from "./Waveform.tsx";

export interface AudioPreviewProps {
  readonly path: string;
  readonly mime: string;
  /** Whether the user has asked for this file to be playing. Owned by `App`. */
  readonly playing: boolean;
}

const reader = lazyWorker(
  () => new Worker(new URL("../../tags.worker.ts", import.meta.url), { type: "module" }),
);

/** Drop the shared worker. For tests, which must not inherit another's. */
export function forgetTagsWorker(): void {
  reader.forget();
}

interface Tags {
  readonly title: string;
  readonly artist: string;
  readonly durationSeconds: number;
  readonly artUrl: string | null;
}

const NO_TAGS: Tags = { title: "", artist: "", durationSeconds: 0, artUrl: null };

/**
 * What the file says about itself, or nothing.
 *
 * Returns `NO_TAGS` while the answer is in flight AND when it never comes, and
 * the two are deliberately the same value: the pane draws the file either way,
 * so a caller has nothing to do differently.
 */
function useAudioTags(url: string | null): Tags {
  const [tags, setTags] = useState<Tags>(NO_TAGS);
  const nextId = useRef(0);

  useEffect(() => {
    // Clearing FIRST is what stops the previous file's title sitting under the
    // next file's name for as long as the parse takes.
    setTags(NO_TAGS);
    if (url === null) return;

    const instance = reader.get();
    if (instance === null) return;

    const id = ++nextId.current;
    let artUrl: string | null = null;

    const onMessage = (event: MessageEvent<TagsResponse>) => {
      // A stale answer belongs to a file the cursor has already left.
      if (event.data.id !== id) return;

      const picture = event.data.picture;
      if (picture !== null) {
        artUrl = URL.createObjectURL(new Blob([picture.bytes], { type: picture.mime }));
      }
      setTags({
        title: event.data.title,
        artist: event.data.artist,
        durationSeconds: event.data.durationSeconds,
        artUrl,
      });
    };

    instance.addEventListener("message", onMessage);
    const request: TagsRequest = { id, url };
    instance.postMessage(request);

    return () => {
      instance.removeEventListener("message", onMessage);
      // A resident application previews thousands of files in a session, so a
      // blob URL kept per cover art is a real leak rather than a tidy-up.
      if (artUrl !== null) URL.revokeObjectURL(artUrl);
    };
  }, [url]);

  return tags;
}

/** The last path segment. The fallback title, and always available. */
function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A sound file: what it is, and a way to hear it.
 *
 * Laid out like the Qt build's `AudioPreview.qml` — art, then title and artist,
 * then the transport — and it differs from the video pane in one deliberate
 * way: **there is no `autoPlay`**. Sound starting by itself as the cursor moves
 * through a directory is an interruption, not a preview, which is why the Qt
 * original sets `autoPlay: false` too. `Ctrl+P` is the only thing that starts
 * it, and the state behind that lives in `App` because it has to be cleared
 * when the cursor moves and only `App` knows where the cursor is.
 *
 * **This component is NOT remounted when the cursor moves between two audio
 * files.** Only its `path` prop changes, because the pane renders the same
 * component at the same position. An earlier comment here claimed the opposite
 * and every piece of state below was written trusting it — which is how the
 * duration and the playhead came to belong to whichever file had been shown
 * previously. Anything that describes the FILE is stored with the URL it
 * describes.
 */
export function AudioPreview({ path, mime, playing }: AudioPreviewProps) {
  const url = usePreviewUrl(path);
  const tags = useAudioTags(url);
  const element = useRef<HTMLAudioElement | null>(null);
  const progress = useMediaProgress(url, tags.durationSeconds);

  /**
   * Follow the play/pause request from above.
   *
   * Keyed on `url` as well as `playing` for the reason the video pane records
   * in full: the first render has no element at all, so an effect that runs
   * before the file arrives finds a null ref and never runs again.
   */
  useEffect(() => {
    const audio = element.current;
    if (audio === null || url === null) return;

    if (playing) {
      // `play()` rejects when the element has no source yet, which is not an
      // error worth surfacing in a preview pane — and an unhandled rejection
      // would reach the console.
      void audio.play().catch(() => undefined);
      return;
    }
    audio.pause();
  }, [playing, url]);

  if (url === null) return <div data-testid="preview-loading">reading…</div>;

  const duration = progress.duration;
  const length = duration === null ? "" : formatDuration(duration);

  // The single derivation of how far into the file we are. The waveform below
  // takes `position` and `duration` and reaches the same number by calling the
  // same function, so the fill and the drawing cannot disagree.
  const played = playedFraction(progress.position, duration);
  // The input addresses SECONDS, not a fraction, and must not exceed its own
  // `max`: a controlled value above it leaves React's record and the DOM's
  // disagreeing until the next `timeupdate` overwrites both — and a position
  // past the end is exactly the case `playedFraction`'s clamp exists for.
  // Derived from the raw inputs rather than back out of `played`, because that
  // round trip reintroduces float error into a value read back as a string.
  const seekPosition = Number.isFinite(progress.position)
    ? Math.min(progress.position, duration ?? 0)
    : 0;
  const spokenPosition =
    length === "" ? formatDuration(seekPosition) : `${formatDuration(seekPosition)} of ${length}`;

  return (
    <div className="preview preview--audio" data-testid="preview-audio">
      <div className="preview__art">
        {tags.artUrl === null ? (
          <div className="preview__art-placeholder" data-testid="preview-audio-art-placeholder">
            ♪
          </div>
        ) : (
          <img src={tags.artUrl} alt="" data-testid="preview-audio-art" />
        )}
      </div>

      <p className="preview__title" data-testid="preview-audio-title">
        {tags.title === "" ? fileNameOf(path) : tags.title}
      </p>
      <p className="preview__artist" data-testid="preview-audio-artist">
        {tags.artist}
      </p>
      <p className="preview__duration" data-testid="preview-audio-duration">
        {length === "" ? mime : length}
      </p>

      <Waveform url={url} position={progress.position} duration={duration} />

      {/* Three elements where a bare input would do, and the reason is that
          Chromium gives a range input a track and a thumb and NOTHING between
          them: there is no pseudo-element for the played portion, the way
          Firefox's `::-moz-range-progress` is. So the groove is drawn by the
          wrapper, the fill is a real element sized in percent, and the input
          rides on top contributing only its thumb.

          The alternative was a custom property set inline and read by
          `::-webkit-slider-runnable-track` as a gradient stop. It needs a cast
          to get past `CSSProperties`, which does not admit custom properties;
          a plain `width` needs none. */}
      <div className="preview__seek">
        <div
          className="preview__seek-played"
          data-testid="preview-audio-seek-played"
          style={{ width: `${played * 100}%` }}
        />
        <input
          className="preview__seek-input"
          data-testid="preview-audio-seek"
          type="range"
          min={0}
          max={duration ?? 0}
          step="any"
          value={seekPosition}
          aria-label="Seek"
          // Without this a screen reader announces the raw seconds — "one
          // hundred" for a position the pane itself renders as `1:40`.
          aria-valuetext={spokenPosition}
          disabled={duration === null}
          onChange={(event) => {
            const seconds = Number(event.target.value);
            progress.reportPosition(seconds);
            if (element.current !== null) element.current.currentTime = seconds;
          }}
        />
      </div>

      {/* biome-ignore lint/a11y/useMediaCaption: a preview of a sound file the
          user is pointing at has no caption track to offer, and an empty one
          would announce itself for nothing. */}
      <audio
        ref={element}
        src={url}
        data-testid="preview-audio-element"
        onTimeUpdate={(event) => progress.reportPosition(event.currentTarget.currentTime)}
        // `durationchange` as well as `loadedmetadata`: a stream reports
        // `Infinity` first and a real length later, and only the second is
        // usable — `useMediaProgress` discards the non-finite one.
        onLoadedMetadata={(event) => progress.reportDuration(event.currentTarget.duration)}
        onDurationChange={(event) => progress.reportDuration(event.currentTarget.duration)}
      />
    </div>
  );
}
