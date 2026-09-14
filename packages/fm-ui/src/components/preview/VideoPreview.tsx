import { useEffect, useRef, useState } from "react";

import { usePreviewUrl } from "./previewUrl.ts";

export interface VideoPreviewProps {
  readonly path: string;
  readonly mime: string;
}

/**
 * A video, playing silently on a loop.
 *
 * Parity with the Qt build's `VideoPreview.qml`, which autoplays and loops
 * forever and attaches no audio output at all. Three of the four attributes
 * below are load-bearing and each of them fails silently when it is missing:
 *
 * - **`muted`** decides whether anything happens. Chromium blocks autoplay with
 *   sound, so an unmuted element refuses to start and reports nothing.
 * - **`loop`** is what makes it a preview rather than a clip that stops.
 * - **`playsInline`** stops a host that honours it from going fullscreen.
 *
 * The browser does the decoding, which is why this file contains no codec
 * knowledge: measured on Electron 41, Chromium plays H.264, HEVC, AV1, VP8,
 * VP9 and Matroska carrying H.264. A container it cannot decode raises `error`
 * and takes the failure path below, which is the same path a file whose name
 * lies about its contents takes.
 */
export function VideoPreview({ path, mime }: VideoPreviewProps) {
  const url = usePreviewUrl(path);
  const element = useRef<HTMLVideoElement | null>(null);

  // The failure is remembered AS a path, not as a flag an effect resets. A flag
  // needs clearing when the file changes, and an effect that only clears it
  // reads none of what it depends on; comparing paths makes "this failure
  // belongs to that file" the value itself. Taken from `ImagePreview`, where
  // verification found the version without it failing in total silence.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const failed = failedPath === path;

  /**
   * Stop decoding while nobody can see it.
   *
   * The window is a resident daemon — hidden far more often than it is closed —
   * and autoplay on every cursor settle would otherwise leave it decoding video
   * for as long as it stays hidden. This is the bound that makes parity
   * affordable, and it is deliberately NOT a size limit: a small file hidden
   * for an hour costs more than a large one watched for a second.
   *
   * **The state is applied on arrival too, not only on the transition.** A
   * listener alone covers the window being hidden while a video plays, and
   * misses the case that actually happens more often: the window is ALREADY
   * hidden and the cursor moves, mounting a fresh element whose `autoPlay`
   * starts decoding with no transition left to stop it. Found in review.
   *
   * **It depends on `url`, and an empty dependency list is WRONG here.** The
   * first render has no `<video>` at all — the component shows "reading…" until
   * the main process answers — so an effect that runs once runs while the ref
   * is still null, returns immediately, and never runs again once the element
   * exists. That is not a theory: written with `[]`, the guard below caught it,
   * and the already-hidden case stayed unfixed while looking fixed. Keying on
   * `url` also re-applies the state for each new file, which is what a pane the
   * cursor moves through needs.
   */
  useEffect(() => {
    // Nothing to apply before the URL arrives: until then this component renders
    // "reading…" and there is no element to pause. Reading `url` here is also
    // what makes it an honest dependency rather than a bare trigger the linter
    // would strip.
    if (url === null) return;

    const applyVisibility = () => {
      const video = element.current;
      if (video === null) return;

      if (document.visibilityState === "hidden") {
        video.pause();
        return;
      }
      // `play()` rejects when the element has no source yet or the document is
      // still not allowed to autoplay. Neither is an error worth surfacing in a
      // preview pane, and an unhandled rejection would reach the console.
      void video.play().catch(() => undefined);
    };

    if (document.visibilityState === "hidden") applyVisibility();

    document.addEventListener("visibilitychange", applyVisibility);
    return () => document.removeEventListener("visibilitychange", applyVisibility);
  }, [url]);

  if (url === null) return <div data-testid="preview-loading">reading…</div>;

  if (failed) {
    return (
      <p className="preview__failed" data-testid="preview-video-failed">
        not a playable {mime} video
      </p>
    );
  }

  return (
    <div className="preview preview--video" data-testid="preview-video">
      {/* `object-fit: contain` in the stylesheet keeps the aspect ratio, which
          is why no width or height is set here. No caption track is offered
          because the element is muted by construction: there is no audio to
          caption, and an empty track would be worse than none. */}
      <video
        ref={element}
        src={url}
        autoPlay
        loop
        muted
        playsInline
        data-testid="preview-video-element"
        onError={() => setFailedPath(path)}
      />
    </div>
  );
}
