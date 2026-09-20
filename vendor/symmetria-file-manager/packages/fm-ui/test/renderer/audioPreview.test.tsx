/**
 * @vitest-environment happy-dom
 *
 * The audio branch: what the pane says about a file, and what `Ctrl+P` does.
 *
 * happy-dom has no decoder and no media pipeline, so `play()` and `pause()` are
 * spied rather than observed and the real thing is the verifier's to drive.
 * What IS real here is the worker wiring: a fake `Worker` is installed so the
 * request/response discipline — including discarding an answer for a file the
 * cursor has already left — runs for real rather than being asserted about.
 */

import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioPreview, forgetTagsWorker } from "../../src/components/preview/AudioPreview.tsx";
import { PreviewPane } from "../../src/components/preview/PreviewPane.tsx";
import type { TagsRequest, TagsResponse } from "../../src/tags.worker.ts";
import { inertBridge } from "./support.ts";

const TOKEN_URL = "symmetria-fm://app/__preview/t";

/** What the fake worker answers with, per test. */
let answer: Omit<TagsResponse, "id"> = {
  title: "",
  artist: "",
  durationSeconds: 0,
  picture: null,
};

/** Requests the component sent, so a test can assert what was asked. */
let sent: TagsRequest[] = [];

/** Whether the fake worker answers at all, for the never-answers case. */
let answering = true;

class FakeWorker {
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.add(fn);
  }

  removeEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.delete(fn);
  }

  postMessage(request: TagsRequest) {
    sent.push(request);
    if (!answering) return;
    const data: TagsResponse = { ...answer, id: request.id };
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) {
        listener(new MessageEvent("message", { data }));
      }
    });
  }

  terminate() {}
}

beforeEach(() => {
  sent = [];
  answering = true;
  answer = { title: "", artist: "", durationSeconds: 0, picture: null };
  forgetTagsWorker();

  // Installed by definition rather than by assignment, which is how this file
  // installs the bridge too. The fake implements exactly the four members the
  // component uses and no assertion is needed to say so — an assertion chain
  // here would only be claiming a resemblance nothing checks.
  Object.defineProperty(globalThis, "Worker", {
    value: FakeWorker,
    configurable: true,
    writable: true,
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
});

describe("what the pane says about the file", () => {
  it("shows the title and the artist the tags carry", async () => {
    answer = {
      title: "Recuerdos de la Alhambra",
      artist: "Andrés Segovia",
      durationSeconds: 215,
      picture: null,
    };

    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    await waitFor(() =>
      expect(screen.getByTestId("preview-audio-title").textContent).toContain(
        "Recuerdos de la Alhambra",
      ),
    );
    expect(screen.getByTestId("preview-audio-artist").textContent).toContain("Andrés Segovia");
  });

  it("falls back to the filename when the file carries no title", async () => {
    // Most files a file manager meets have no tags at all. A blank line where
    // the name should be reads as a failure; the name is always available.
    render(
      <AudioPreview path="/home/jc/Music/voice-memo-004.ogg" mime="audio/ogg" playing={false} />,
    );

    expect((await screen.findByTestId("preview-audio-title")).textContent).toContain(
      "voice-memo-004.ogg",
    );
  });

  it("shows the duration as minutes and seconds", async () => {
    answer = { title: "", artist: "", durationSeconds: 215, picture: null };

    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    await waitFor(() =>
      expect(screen.getByTestId("preview-audio-duration").textContent).toContain("3:35"),
    );
  });

  it("asks the worker for the file's own URL, not for its path", async () => {
    // The worker has no filesystem either. It fetches the same token URL the
    // element plays from, which is the only address the renderer has.
    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.url).toBe(TOKEN_URL);
  });
});

describe("cover art", () => {
  it("renders the picture the file carries", async () => {
    answer = {
      title: "",
      artist: "",
      durationSeconds: 0,
      picture: { bytes: new Uint8Array([1, 2, 3, 4]).buffer, mime: "image/jpeg" },
    };

    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    const art = await screen.findByTestId("preview-audio-art");
    expect(art.getAttribute("src")).toBeTruthy();
    expect(screen.queryByTestId("preview-audio-art-placeholder")).toBeNull();
  });

  it("shows a placeholder when there is none", async () => {
    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    expect(await screen.findByTestId("preview-audio-art-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("preview-audio-art")).toBeNull();
  });
});

describe("the transport", () => {
  it("plays and pauses as the playing flag changes, and not on its own", async () => {
    // The element is deliberately NOT `autoPlay`: sound starting by itself as
    // the cursor moves is an interruption, which is why the Qt original sets
    // `autoPlay: false` too. Only `Ctrl+P` starts it.
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    const view = render(
      <AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />,
    );

    const element = await screen.findByTestId("preview-audio-element");
    expect(element.hasAttribute("autoplay")).toBe(false);
    expect(play).not.toHaveBeenCalled();

    view.rerender(
      <AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={true} />,
    );
    await waitFor(() => expect(play).toHaveBeenCalled());

    view.rerender(
      <AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />,
    );
    await waitFor(() => expect(pause).toHaveBeenCalled());
  });

  it("offers a seek control across the whole file", async () => {
    answer = { title: "", artist: "", durationSeconds: 215, picture: null };

    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    // SAFETY: this test id is on the range input in `AudioPreview` and on
    // nothing else, so the node found here is that input.
    const seek = (await screen.findByTestId("preview-audio-seek")) as HTMLInputElement;

    // The control exists before its range is known — the length arrives with
    // the tags, and until then the control is deliberately disabled with a
    // range of zero. Waiting for the ELEMENT and then reading `max` reads
    // whichever state won the race; waiting for the RANGE is the real
    // condition, and it is also what makes the change below reach a control
    // that is no longer disabled.
    await waitFor(() => expect(seek.max).toBe("215"));

    fireEvent.change(seek, { target: { value: "100" } });
    await waitFor(() => expect(seek.value).toBe("100"));
  });

  it("sizes the played fill from the position, not from the element", async () => {
    // The fill is a real element rather than a pseudo-element because Chromium
    // gives a range input a track and a thumb and nothing between them. Being a
    // real element, it can be wrong independently of the control — stuck at 0%,
    // or wired to the wrong number — and nothing else in this file would see it.
    answer = { title: "", artist: "", durationSeconds: 215, picture: null };

    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    // SAFETY: this test id is on the range input in `AudioPreview` and on
    // nothing else, so the node found here is that input.
    const seek = (await screen.findByTestId("preview-audio-seek")) as HTMLInputElement;
    await waitFor(() => expect(seek.max).toBe("215"));

    fireEvent.change(seek, { target: { value: "43" } });

    const fill = await screen.findByTestId("preview-audio-seek-played");
    await waitFor(() => expect(fill.style.width).toBe("20%"));
  });

  it("stops the fill and the control at the end when the element runs past it", async () => {
    // A media element reports a `currentTime` a hair past its own `duration` at
    // the very end of a file. Unclamped, the fill spans wider than its groove
    // and the input's controlled value sits above its own `max`, which leaves
    // React's record and the DOM's disagreeing until the next `timeupdate`.
    answer = { title: "", artist: "", durationSeconds: 215, picture: null };

    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    // SAFETY: this test id is on the range input in `AudioPreview` and on
    // nothing else, so the node found here is that input.
    const seek = (await screen.findByTestId("preview-audio-seek")) as HTMLInputElement;
    await waitFor(() => expect(seek.max).toBe("215"));

    const audio = screen.getByTestId("preview-audio-element");
    Object.defineProperty(audio, "currentTime", { value: 300, configurable: true });
    fireEvent.timeUpdate(audio);

    const fill = await screen.findByTestId("preview-audio-seek-played");
    await waitFor(() => expect(fill.style.width).toBe("100%"));
    expect(seek.value).toBe("215");
  });
});

describe("when the tags cannot be read", () => {
  it("shows the file anyway rather than an error", async () => {
    // Tags are decoration, exactly as highlighting is. A file whose tag block
    // is corrupt still plays, and a pane that refuses to draw because it could
    // not read a title has turned a cosmetic failure into a functional one.
    answering = false;

    render(<AudioPreview path="/home/jc/Music/broken.mp3" mime="audio/mpeg" playing={false} />);

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    expect(screen.getByTestId("preview-audio-title").textContent).toContain("broken.mp3");
  });

  it("works with no worker at all", async () => {
    // The panel is embeddable, and a host without workers must still preview.
    // `CodePreview` established the same fallback for highlighting.
    forgetTagsWorker();
    // Removing the global IS the condition under test; the component's own
    // guard is `typeof Worker === "undefined"`.
    Object.defineProperty(globalThis, "Worker", { value: undefined, configurable: true });

    render(<AudioPreview path="/home/jc/Music/track.flac" mime="audio/flac" playing={false} />);

    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
    expect(screen.getByTestId("preview-audio-title").textContent).toContain("track.flac");
  });

  it("discards an answer that belongs to a file the cursor has left", async () => {
    // The pane is debounced but the worker is not instant, so an answer for the
    // previous file can arrive after the next one is on screen. Showing it
    // would put one file's title beside another file's name.
    answer = { title: "First", artist: "", durationSeconds: 0, picture: null };

    const view = render(
      <AudioPreview path="/home/jc/Music/first.flac" mime="audio/flac" playing={false} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("preview-audio-title").textContent).toContain("First"),
    );

    answering = false;
    view.rerender(
      <AudioPreview path="/home/jc/Music/second.flac" mime="audio/flac" playing={false} />,
    );

    // The second file's request goes unanswered, so the pane must fall back to
    // the second file's NAME rather than keep showing the first file's title.
    await waitFor(() =>
      expect(screen.getByTestId("preview-audio-title").textContent).toContain("second.flac"),
    );
  });
});

describe("guards", () => {
  it("is what the pane reaches for on an audio route", async () => {
    // The component and the router are each tested on their own; this pins the
    // wire between them. A branch added to the router and not to the pane
    // renders nothing at all, and neither of those tests would notice.
    render(
      <PreviewPane
        route={{ kind: "audio", mime: "audio/flac" }}
        path="/home/jc/Music/track.flac"
        size={1024}
      />,
    );

    expect(screen.getByTestId("column-preview").dataset.kind).toBe("audio");
    expect(await screen.findByTestId("preview-audio-element")).toBeTruthy();
  });

  it("no longer offers the unbuilt apology for audio", () => {
    render(
      <PreviewPane
        route={{ kind: "audio", mime: "audio/flac" }}
        path="/home/jc/Music/track.flac"
        size={1024}
      />,
    );

    expect(screen.queryByTestId("preview-unbuilt")).toBeNull();
  });

  it("does not sound a file the pane is not showing", async () => {
    // `playing` is decided by comparing the request's path with the PREVIEW's
    // path, and the preview lags the cursor by the debounce. The pane must
    // never start a file it is not displaying.
    render(
      <PreviewPane
        route={{ kind: "audio", mime: "audio/flac" }}
        path="/home/jc/Music/track.flac"
        size={1024}
        audioPlaying={false}
      />,
    );

    const element = await screen.findByTestId("preview-audio-element");
    expect(element.hasAttribute("autoplay")).toBe(false);
  });
});
