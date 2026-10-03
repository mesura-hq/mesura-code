import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vite-plus/test";

import {
  CenterOutWaveform,
  advanceWaveformHistory,
  mirroredBarXPositions,
  recordingAmplitudeAtDistance,
  shouldDrawStaticAudioUpdate,
  isRecordingWaveformSettled,
  shouldDrawWaveformFrame,
  waveformSmoothingAlpha,
} from "./CenterOutWaveform";

function approachTarget(frameDurationMs: number, durationMs: number): number {
  let value = 0;
  for (let elapsed = 0; elapsed < durationMs; elapsed += frameDurationMs) {
    value += (1 - value) * waveformSmoothingAlpha(frameDurationMs, 150);
  }
  return value;
}

it("keeps waveform smoothing stable across display refresh rates", () => {
  const sixtyHertz = approachTarget(1000 / 60, 500);
  const oneTwentyHertz = approachTarget(1000 / 120, 500);

  assert.closeTo(sixtyHertz, oneTwentyHertz, 0.015);
  assert.isAbove(sixtyHertz, 0.95);
});

it("keeps history sampling independent of display refresh rate", () => {
  const run = (frameDurationMs: number) => {
    let history: ReadonlyArray<number> = [];
    let lastSampleAt = -54;
    for (let timestamp = 0; timestamp <= 540; timestamp += frameDurationMs) {
      const advanced = advanceWaveformHistory({
        history,
        currentAmplitude: 0.75,
        lastSampleAt,
        timestamp,
      });
      history = advanced.history;
      lastSampleAt = advanced.lastSampleAt;
    }
    return { history, lastSampleAt };
  };

  assert.deepEqual(run(1000 / 60), run(1000 / 120));
});

it("caps canvas drawing at twelve stepped frames per second", () => {
  let lastDrawAt = 0;
  const drawTimes = [lastDrawAt];
  for (let timestamp = 1000 / 240; timestamp <= 1000; timestamp += 1000 / 240) {
    if (!shouldDrawWaveformFrame(timestamp, lastDrawAt)) continue;
    lastDrawAt = timestamp;
    drawTimes.push(timestamp);
  }

  assert.isAtMost(drawTimes.length, 13);
  assert.isAbove(drawTimes.length, 10);
  for (let index = 1; index < drawTimes.length; index += 1) {
    assert.isAtLeast(drawTimes[index]! - drawTimes[index - 1]!, 1000 / 12 - 0.01);
  }
});

it("stops redrawing a recording waveform whose level has settled", () => {
  const flat = Array.from({ length: 18 }, () => 0.4);
  assert.isTrue(
    isRecordingWaveformSettled({ history: flat, currentAmplitude: 0.4, targetAmplitude: 0.4 }),
  );
  assert.isFalse(
    isRecordingWaveformSettled({ history: flat, currentAmplitude: 0.3, targetAmplitude: 0.4 }),
  );
  assert.isFalse(
    isRecordingWaveformSettled({
      history: [0.6, ...flat.slice(1)],
      currentAmplitude: 0.4,
      targetAmplitude: 0.4,
    }),
  );
  assert.isFalse(
    isRecordingWaveformSettled({ history: [0.4], currentAmplitude: 0.4, targetAmplitude: 0.4 }),
  );
});

it("redraws audio updates without recurring motion when reduced motion is enabled", () => {
  assert.isTrue(
    shouldDrawStaticAudioUpdate({ active: true, phase: "recording", reducedMotion: true }),
  );
  assert.isFalse(
    shouldDrawStaticAudioUpdate({ active: false, phase: "recording", reducedMotion: true }),
  );
  assert.isFalse(
    shouldDrawStaticAudioUpdate({ active: true, phase: "processing", reducedMotion: true }),
  );
});

it("keeps each bar pair symmetric around the center gap", () => {
  const centerX = 120;
  for (let distance = 0; distance < 18; distance += 1) {
    const positions = mirroredBarXPositions(centerX, distance);
    assert.equal(centerX - (positions.left + 2), positions.right - centerX);
  }
});

it("uses the normal bar spacing at the center seam", () => {
  const center = mirroredBarXPositions(120, 0);
  const next = mirroredBarXPositions(120, 1);
  const centerGap = center.right - (center.left + 2);
  const regularGap = next.right - (center.right + 2);

  assert.equal(centerGap, regularGap);
});

it("uses the theme foreground for a white dark-theme waveform", () => {
  const markup = renderToStaticMarkup(
    createElement(CenterOutWaveform, {
      sessionId: "session-a",
      phase: "recording",
      audioLevel: 0.4,
      active: true,
      reducedMotion: false,
    }),
  );

  assert.include(markup, "text-foreground");
  assert.include(markup, 'data-dictation-waveform="center-out"');
});

it("moves each recorded sample continuously away from the center", () => {
  const history = [0.8, 0.4, 0.2];

  assert.equal(
    recordingAmplitudeAtDistance({
      history,
      currentAmplitude: 1,
      distance: 0,
      sampleProgress: 0.5,
    }),
    1,
  );
  assert.equal(
    recordingAmplitudeAtDistance({ history, currentAmplitude: 1, distance: 1, sampleProgress: 0 }),
    0.4,
  );
  assert.closeTo(
    recordingAmplitudeAtDistance({
      history,
      currentAmplitude: 1,
      distance: 1,
      sampleProgress: 0.5,
    }),
    0.6,
    0.0001,
  );
  assert.equal(
    recordingAmplitudeAtDistance({ history, currentAmplitude: 1, distance: 1, sampleProgress: 1 }),
    0.8,
  );
});
