import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const visibility = vi.hoisted(() => ({
  notify: (_entry: { isIntersecting: boolean }) => {},
}));
vi.mock("~/lib/observeIntersection", () => ({
  observeIntersection: (_element: Element, notify: typeof visibility.notify) => {
    visibility.notify = notify;
    return () => {};
  },
}));

import { act, fakeTimers, render } from "../../test/render";
import { useDictationSessionStore } from "./dictationSessionStore";
import { SidebarDictationWaveform } from "./SidebarDictationWaveform";

function setup() {
  useDictationSessionStore.setState({
    session: {
      sessionId: "waveform-session",
      mode: "inject",
      thread: {
        kind: "thread",
        environmentId: EnvironmentId.make("waveform-environment"),
        threadId: ThreadId.make("waveform-thread"),
      },
      startedAt: 0,
      bankedMs: 0,
      runningSince: 0,
      level: 0,
      sampledAt: 0,
    },
  });
  visibility.notify = () => {};
  return { [Symbol.dispose]: () => useDictationSessionStore.setState({ session: null }) };
}

function setLevel(level: number) {
  const session = useDictationSessionStore.getState().session!;
  useDictationSessionStore.setState({ session: { ...session, level } });
}

function bars(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-dictation-waveform] > span"));
}

const transforms = (container: HTMLElement) => bars(container).map((bar) => bar.style.transform);

describe("the sidebar waveform", () => {
  it("moves microphone samples symmetrically from the center at 10 Hz", async () => {
    using _setup = setup();
    await using screen = await render(<SidebarDictationWaveform recording />);
    using _timers = fakeTimers();
    visibility.notify({ isIntersecting: true });
    setLevel(1);
    vi.advanceTimersByTime(99);
    expect(transforms(screen.container)).toEqual(Array(5).fill("scaleY(0.142857)"));
    vi.advanceTimersByTime(1);
    expect(bars(screen.container)[2]!.style.transform).toBe("scaleY(1)");
    setLevel(0);
    vi.advanceTimersByTime(100);
    const values = transforms(screen.container);
    expect(values[0]).toBe(values[4]);
    expect(values[1]).toBe(values[3]);
    expect(values[1]).toBe("scaleY(0.785714)");
    expect(values[2]).toBe("scaleY(0.142857)");
    vi.advanceTimersByTime(100);
    expect(bars(screen.container)[0]!.style.transform).toBe("scaleY(0.571429)");
  });

  it("stops sampling off screen, when paused and when the document is hidden", async () => {
    using _setup = setup();
    await using screen = await render(<SidebarDictationWaveform recording />);
    using _timers = fakeTimers();
    visibility.notify({ isIntersecting: true });
    visibility.notify({ isIntersecting: false });
    const frozen = transforms(screen.container);
    setLevel(1);
    vi.advanceTimersByTime(300);
    expect(transforms(screen.container)).toEqual(frozen);
    visibility.notify({ isIntersecting: true });
    const session = useDictationSessionStore.getState().session!;
    useDictationSessionStore.setState({ session: { ...session, runningSince: null } });
    const paused = transforms(screen.container);
    vi.advanceTimersByTime(300);
    expect(transforms(screen.container)).toEqual(paused);
    using hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    useDictationSessionStore.setState({ session });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(300);
    expect(transforms(screen.container)).toEqual(paused);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(1);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a deterministic travelling wave for transcription", async () => {
    using _setup = setup();
    await using screen = await render(<SidebarDictationWaveform recording={false} />);
    using _timers = fakeTimers();
    visibility.notify({ isIntersecting: true });
    const first = transforms(screen.container);
    vi.advanceTimersByTime(100);
    const next = transforms(screen.container);
    expect(next).not.toEqual(first);
    expect(next[0]).toBe(next[4]);
    expect(next[1]).toBe(next[3]);
    visibility.notify({ isIntersecting: false });
    vi.advanceTimersByTime(300);
    expect(transforms(screen.container)).toEqual(next);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])(
    "keeps static bars with reduced motion (recording: %s)",
    async (recording) => {
      using _setup = setup();
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      using _matches = vi.spyOn(media, "matches", "get").mockReturnValue(true);
      using _matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue(media);
      await using screen = await render(<SidebarDictationWaveform recording={recording} />);
      using _timers = fakeTimers();
      visibility.notify({ isIntersecting: true });
      const initial = transforms(screen.container);
      setLevel(1);
      vi.advanceTimersByTime(300);
      expect(transforms(screen.container)).toEqual(initial);
      expect(bars(screen.container)).toHaveLength(5);
      expect(vi.getTimerCount()).toBe(0);
      _matches.mockReturnValue(false);
      await act(() => media.dispatchEvent(new Event("change")));
      expect(vi.getTimerCount()).toBe(1);
    },
  );
});
