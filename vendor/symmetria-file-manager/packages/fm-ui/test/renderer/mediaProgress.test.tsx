/**
 * @vitest-environment happy-dom
 *
 * Where a media element is, and how long its file is.
 *
 * Every case here came from verification driving the real application, and the
 * REVISIT case is the one worth reading: a first fix paired each number with
 * the URL it was measured against, which is right for moving to another file
 * and wrong for coming back to one. The element reloads and resets to zero
 * while the remembered position matches the same URL again, so the seek control
 * sat at 1.48 seconds of a file playing from the start.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useMediaProgress } from "../../src/components/preview/useMediaProgress.ts";

afterEach(cleanup);

const A = "symmetria-fm://app/__preview/a";
const B = "symmetria-fm://app/__preview/b";

describe("what a fresh file reports", () => {
  it("starts at zero with no length known", () => {
    const { result } = renderHook(() => useMediaProgress(A, 0));

    expect(result.current.position).toBe(0);
    expect(result.current.duration).toBeNull();
  });

  it("uses the parser's length until the element supplies its own", () => {
    // `parseBlob` is asked NOT to compute a duration, so for most formats this
    // is zero and the element is the only source. When a parser DOES report one
    // it is a usable stand-in for the moment before metadata loads.
    const { result } = renderHook(() => useMediaProgress(A, 215));

    expect(result.current.duration).toBe(215);
  });

  it("prefers the element's length over the parser's", () => {
    // The element's number is what the seek control actually addresses, so a
    // disagreement must resolve in its favour rather than the other way.
    const { result } = renderHook(() => useMediaProgress(A, 215));

    act(() => result.current.reportDuration(121.96));

    expect(result.current.duration).toBe(121.96);
  });

  it("refuses a length that is not one", () => {
    // A stream reports `Infinity` before it reports anything usable, and `NaN`
    // arrives before metadata. Neither may become the seek control's range.
    const { result } = renderHook(() => useMediaProgress(A, 0));

    act(() => result.current.reportDuration(Number.POSITIVE_INFINITY));
    expect(result.current.duration).toBeNull();

    act(() => result.current.reportDuration(Number.NaN));
    expect(result.current.duration).toBeNull();
  });
});

describe("moving between files", () => {
  it("does not carry one file's position onto the next", () => {
    const { result, rerender } = renderHook(({ url }) => useMediaProgress(url, 0), {
      initialProps: { url: A },
    });
    act(() => result.current.reportPosition(42));
    expect(result.current.position).toBe(42);

    rerender({ url: B });

    expect(result.current.position).toBe(0);
  });

  it("does not carry one file's length onto the next", () => {
    // The defect that started this: a 122-second recording showed `0:00`
    // because the pane was reading a number that belonged to another file.
    const { result, rerender } = renderHook(({ url }) => useMediaProgress(url, 0), {
      initialProps: { url: A },
    });
    act(() => result.current.reportDuration(4));
    expect(result.current.duration).toBe(4);

    rerender({ url: B });

    expect(result.current.duration).toBeNull();
  });

  it("forgets a file's position when the cursor comes BACK to it", () => {
    // The regression the URL-keyed fix introduced, and the reason this hook
    // keys on the LOAD rather than the address. Reassigning `src` resets the
    // element's `currentTime` to zero, so a remembered position that matches
    // the URL again disagrees with the element it is meant to describe.
    const { result, rerender } = renderHook(({ url }) => useMediaProgress(url, 0), {
      initialProps: { url: A },
    });
    act(() => result.current.reportPosition(1.48));

    rerender({ url: B });
    rerender({ url: A });

    expect(result.current.position).toBe(0);
  });

  it("forgets a file's length when the cursor comes back to it", () => {
    const { result, rerender } = renderHook(({ url }) => useMediaProgress(url, 0), {
      initialProps: { url: A },
    });
    act(() => result.current.reportDuration(4));

    rerender({ url: B });
    rerender({ url: A });

    expect(result.current.duration).toBeNull();
  });

  it("reports the new file's values on the very first render after a move", () => {
    // Not one render later. An effect-based reset would paint the outgoing
    // file's numbers once beside the incoming file's name, which is the flicker
    // this hook adjusts state during render to avoid.
    const { result, rerender } = renderHook(({ url }) => useMediaProgress(url, 0), {
      initialProps: { url: A },
    });
    act(() => {
      result.current.reportPosition(42);
      result.current.reportDuration(90);
    });

    rerender({ url: B });

    expect(result.current.position).toBe(0);
    expect(result.current.duration).toBeNull();
  });
});

describe("before a file has arrived", () => {
  it("reports nothing rather than guessing", () => {
    const { result } = renderHook(() => useMediaProgress(null, 0));

    expect(result.current.position).toBe(0);
    expect(result.current.duration).toBeNull();
  });
});
