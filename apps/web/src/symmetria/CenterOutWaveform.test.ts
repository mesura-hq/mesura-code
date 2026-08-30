import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vite-plus/test";

import {
  CenterOutWaveform,
  mirroredBarXPositions,
  recordingAmplitudeAtDistance,
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
