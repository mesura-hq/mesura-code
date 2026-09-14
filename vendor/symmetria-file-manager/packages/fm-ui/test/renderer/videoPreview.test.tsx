/**
 * @vitest-environment happy-dom
 *
 * The video branch.
 *
 * happy-dom has no media pipeline: there is no decoder, `play()` is not
 * implemented, and `HTMLMediaElement.paused` never changes on its own. So this
 * file asserts the INSTRUCTIONS given to the element — the attributes, the
 * source, the failure path and the visibility wiring — and leaves "does it
 * actually play" to the verifier, which drives a real Electron.
 *
 * Asserting the attributes is not a weaker test than asserting playback. Three
 * of the four are load-bearing and each fails silently when absent: without
 * `muted` Chromium refuses to autoplay at all, without `loop` a preview stops
 * after one pass, and without `playsInline` a host that honours it takes the
 * whole screen.
 */

import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentPreview } from "../../src/components/preview/DocumentPreview.tsx";
import * as imageModule from "../../src/components/preview/ImagePreview.tsx";
import { ImagePreview } from "../../src/components/preview/ImagePreview.tsx";
import { PreviewPane } from "../../src/components/preview/PreviewPane.tsx";
import * as previewUrlModule from "../../src/components/preview/previewUrl.ts";
import { VideoPreview } from "../../src/components/preview/VideoPreview.tsx";
import { inertBridge } from "./support.ts";

const TOKEN_URL = "symmetria-fm://app/__preview/t";

beforeEach(() => {
  const bridge: Bridge = {
    ...inertBridge(),
    previewUrl: () => Promise.resolve({ ok: true as const, value: { url: TOKEN_URL } }),
  };

  Object.defineProperty(window, BRIDGE_KEY, { value: bridge, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VideoPreview", () => {
  it("plays silently and on a loop, without taking the screen", async () => {
    render(<VideoPreview path="/home/jc/Videos/clip.mp4" mime="video/mp4" />);

    const video = await screen.findByTestId("preview-video-element");

    // `muted` is the one that decides whether anything happens at all:
    // Chromium blocks autoplay with sound, so an unmuted element silently
    // refuses to start. It is also parity — the Qt original attaches no audio
    // output to its player.
    expect(video).toHaveProperty("autoplay", true);
    expect(video).toHaveProperty("loop", true);
    expect(video).toHaveProperty("muted", true);

    // The attributes as well as the properties, and `playsinline` ONLY as an
    // attribute: happy-dom does not implement the `playsInline` IDL property
    // (measured — it reads `undefined`), while React does render the attribute
    // (measured — it is present on the element). The attribute is what Chromium
    // reads, so this asserts the instruction where it can be observed.
    expect(video.hasAttribute("autoplay")).toBe(true);
    expect(video.hasAttribute("loop")).toBe(true);
    expect(video.hasAttribute("muted")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
  });

  it("loads from the application's own scheme, never from the disk", async () => {
    // The renderer has no filesystem. The main process authorises the path and
    // names an address for it; a `file://` here would mean that boundary had
    // been crossed.
    render(<VideoPreview path="/home/jc/Videos/clip.mp4" mime="video/mp4" />);

    const video = await screen.findByTestId("preview-video-element");

    expect(video.getAttribute("src")).toBe(TOKEN_URL);
    expect(video.getAttribute("src")).not.toMatch(/^file:/);
  });

  it("says so when the bytes are not a playable video", async () => {
    // Routing is decided by the NAME, so a `.mp4` that is not one can only be
    // caught here, at the decode. The image branch had exactly this hole and it
    // presented as a pane collapsed to zero height — a rendering fault to look
    // at, rather than a file that could not be read.
    render(<VideoPreview path="/home/jc/Videos/lying.mp4" mime="video/mp4" />);

    const video = await screen.findByTestId("preview-video-element");
    fireEvent.error(video);

    const failed = await screen.findByTestId("preview-video-failed");
    expect(failed.textContent).toContain("video/mp4");
  });

  it("pauses while the window is hidden and plays again when it returns", async () => {
    // The window is a resident daemon: it is hidden far more often than it is
    // closed, and a hidden window decoding video forever is the cost autoplay
    // would otherwise carry all day.
    render(<VideoPreview path="/home/jc/Videos/clip.mp4" mime="video/mp4" />);

    // SAFETY: this test id is set on the `<video>` element in `VideoPreview`
    // and on nothing else in the tree, so the node found here is that element.
    const video = (await screen.findByTestId("preview-video-element")) as HTMLVideoElement;
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
    const play = vi.spyOn(video, "play").mockImplementation(() => Promise.resolve());

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(pause).toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(play).toHaveBeenCalled();
  });
});

describe("guards", () => {
  it("does not start decoding when it mounts into an already-hidden window", async () => {
    // Found in review. The listener alone covers "playing, then hidden" and
    // misses the case that happens more often: the window is ALREADY hidden and
    // the cursor moves on, mounting a fresh element whose `autoPlay` starts
    // decoding with no transition left to stop it. A resident daemon spends
    // most of its life hidden, so this is the common path, not the corner.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });

    const pauses: string[] = [];
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      pauses.push(this.getAttribute("data-testid") ?? "");
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());

    render(<VideoPreview path="/home/jc/Videos/clip.mp4" mime="video/mp4" />);
    await screen.findByTestId("preview-video-element");

    expect(pause).toHaveBeenCalled();
    expect(pauses).toContain("preview-video-element");

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("is what the pane reaches for on a video route", async () => {
    // The component and the router are each tested on their own; this pins the
    // wire between them. A branch added to the router and not to the pane
    // renders nothing at all, and neither of those tests would notice.
    render(
      <PreviewPane
        route={{ kind: "video", mime: "video/mp4" }}
        path="/home/jc/Videos/clip.mp4"
        size={1024}
      />,
    );

    expect(screen.getByTestId("column-preview").dataset.kind).toBe("video");
    await screen.findByTestId("preview-video-element");
  });

  it("no longer offers the unbuilt apology for a video", () => {
    // The pane's `unbuilt` branch can still be reached — by audio, archives and
    // spreadsheets — so this asserts the route, not the branch's removal.
    render(
      <PreviewPane
        route={{ kind: "video", mime: "video/mp4" }}
        path="/home/jc/Videos/clip.mp4"
        size={1024}
      />,
    );

    expect(screen.queryByTestId("preview-unbuilt")).toBeNull();
  });
});

describe("the extracted preview-URL hook", () => {
  it("is a module of its own, not a member of one of its consumers", () => {
    // Four components share it now. A hook living inside one of them is the
    // shape that produces a circular import the moment the second one grows.
    //
    // Asserting where it is NOT is what pins the extraction: it used to be
    // exported from `ImagePreview.tsx`, and a re-export left behind there would
    // let the old import path keep working and the move quietly undo itself.
    expect(Object.keys(imageModule)).not.toContain("usePreviewUrl");
    expect(Object.keys(previewUrlModule)).toContain("usePreviewUrl");
  });

  it("still resolves the image preview's URL", async () => {
    render(<ImagePreview path="/home/jc/Pictures/a.png" mime="image/png" />);

    const image = await screen.findByTestId("preview-image-element");
    expect(image.getAttribute("src")).toBe(TOKEN_URL);
  });

  it("still resolves the document preview's URL", async () => {
    // Untested before this phase, and the one consumer whose URL must come from
    // this scheme for a reason of Chromium's: its viewer refuses a `blob:` from
    // a custom scheme and resolves the embed to an error page, invisibly.
    render(<DocumentPreview path="/home/jc/paper.pdf" mime="application/pdf" />);

    const embed = await screen.findByTestId("preview-document-embed");
    expect(embed.getAttribute("src")).toBe(TOKEN_URL);
  });
});
