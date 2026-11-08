import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatHiddenDuration,
  guardRecordingScreen,
  HIDDEN_MICROPHONE_CUTOFF_MS,
  setRecordingScreenEnvironment,
} from "./recordingScreen";
import { createFakeScreen } from "./recordingScreen.testFixtures";

afterEach(() => setRecordingScreenEnvironment(null));

function guard(capturing = () => true) {
  const onMicrophoneMayHaveStopped = vi.fn();
  const handle = guardRecordingScreen({ isCapturing: capturing, onMicrophoneMayHaveStopped });
  return { handle, onMicrophoneMayHaveStopped };
}

describe("recording screen guard", () => {
  it("holds the screen on while recording on a phone and lets it go when the recording ends", async () => {
    const screen = createFakeScreen();
    const { handle } = guard();
    expect(screen.wakeLock.request).toHaveBeenCalledWith("screen");
    await screen.grantNext();

    handle.release();
    expect(screen.sentinels[0]).toEqual({ released: true, releaseCalls: 1 });
    expect(screen.listenerCount()).toBe(0);
  });

  it("takes the screen back when the page returns, since the browser drops the lock on hide", async () => {
    const screen = createFakeScreen();
    guard();
    await screen.grantNext();
    screen.hideFor(5_000);
    expect(screen.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it("releases a lock granted after the recording already ended", async () => {
    const screen = createFakeScreen();
    const { handle } = guard();
    handle.release();
    await screen.grantNext();
    expect(screen.sentinels[0]).toEqual({ released: true, releaseCalls: 1 });
  });

  it("asks again for a lock the page lost to a hide before the grant arrived", async () => {
    const screen = createFakeScreen();
    guard();
    screen.hideFor(1_000);
    // The return found the first request still pending, so it asked nothing new.
    expect(screen.wakeLock.request).toHaveBeenCalledTimes(1);
    await screen.grantNext(true);
    expect(screen.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it("keeps recording when the lock is refused", async () => {
    const screen = createFakeScreen();
    const { onMicrophoneMayHaveStopped } = guard();
    await screen.refuseNext();
    screen.hideFor(HIDDEN_MICROPHONE_CUTOFF_MS);
    expect(screen.wakeLock.request).toHaveBeenCalledTimes(2);
    expect(onMicrophoneMayHaveStopped).toHaveBeenCalledWith(HIDDEN_MICROPHONE_CUTOFF_MS);
  });

  it("warns after a hide long enough for Android to cut the microphone", () => {
    const screen = createFakeScreen();
    const { onMicrophoneMayHaveStopped } = guard();
    screen.hideFor(4 * 60_000);
    expect(onMicrophoneMayHaveStopped).toHaveBeenCalledExactlyOnceWith(4 * 60_000);
  });

  it("stays quiet after a short hide", () => {
    const screen = createFakeScreen();
    const { onMicrophoneMayHaveStopped } = guard();
    screen.hideFor(HIDDEN_MICROPHONE_CUTOFF_MS - 1);
    expect(onMicrophoneMayHaveStopped).not.toHaveBeenCalled();
  });

  it("stays quiet after a long hide while the recording was paused", () => {
    const screen = createFakeScreen();
    const { onMicrophoneMayHaveStopped } = guard(() => false);
    screen.hideFor(4 * 60_000);
    expect(onMicrophoneMayHaveStopped).not.toHaveBeenCalled();
  });

  it("stays quiet for a hide the recording ended during", () => {
    const screen = createFakeScreen();
    const { handle, onMicrophoneMayHaveStopped } = guard();
    screen.hide();
    handle.release();
    screen.hideFor(4 * 60_000);
    expect(onMicrophoneMayHaveStopped).not.toHaveBeenCalled();
  });

  it("does nothing on desktop, where a hidden page keeps its microphone", () => {
    const screen = createFakeScreen({ phone: false });
    const { onMicrophoneMayHaveStopped } = guard();
    screen.hideFor(4 * 60_000);
    expect(screen.wakeLock.request).not.toHaveBeenCalled();
    expect(screen.listenerCount()).toBe(0);
    expect(onMicrophoneMayHaveStopped).not.toHaveBeenCalled();
  });

  it("still warns where the browser has no wake lock", () => {
    const screen = createFakeScreen({ wakeLock: false });
    const { onMicrophoneMayHaveStopped } = guard();
    screen.hideFor(2 * 60_000);
    expect(onMicrophoneMayHaveStopped).toHaveBeenCalledOnce();
  });

  it("states the hidden time in seconds under a minute and a half, in minutes above", () => {
    expect(formatHiddenDuration(52_000)).toBe("52 s");
    expect(formatHiddenDuration(89_400)).toBe("89 s");
    expect(formatHiddenDuration(90_000)).toBe("2 min");
    expect(formatHiddenDuration(4 * 60_000 + 10_000)).toBe("4 min");
  });
});
