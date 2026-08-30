import type { SymmetriaDictationPhase } from "@symmetria/broker-contract";
import { memo, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { shouldAnimateDictationWaveform } from "./dictationPresentation";

const HALF_BAR_COUNT = 18;
const NOISE_FLOOR = 0.025;
const INPUT_GAIN = 15;
const ATTACK_TIME_MS = 42;
const RELEASE_TIME_MS = 150;
const HISTORY_SAMPLE_INTERVAL_MS = 54;
const FRAME_INTERVAL_MS = 1000 / 60;
const FRAME_EPSILON_MS = 0.01;
const BAR_WIDTH = 2;
const BAR_GAP = 2;
const CENTER_GAP = 2;
const MIN_BAR_HEIGHT = 2;
const MAX_BAR_HEIGHT = 20;

function normalizedAmplitude(audioLevel: number): number {
  if (audioLevel <= NOISE_FLOOR) return 0;
  const scaled = Math.min(1, ((audioLevel - NOISE_FLOOR) / (1 - NOISE_FLOOR)) * INPUT_GAIN);
  return Math.sqrt(scaled);
}

export function waveformSmoothingAlpha(deltaMs: number, timeConstantMs: number): number {
  return 1 - Math.exp(-Math.max(0, deltaMs) / timeConstantMs);
}

function processingAmplitude(distance: number, timestamp: number): number {
  const spatialPhase = (distance / Math.max(1, HALF_BAR_COUNT - 1)) * Math.PI;
  const wavePosition = spatialPhase - timestamp * 0.0065;
  const primaryWave = 0.5 + 0.5 * Math.sin(wavePosition);
  return Math.max(0, Math.min(1, primaryWave + Math.sin(wavePosition * 2) * 0.1));
}

export function recordingAmplitudeAtDistance(input: {
  readonly history: ReadonlyArray<number>;
  readonly currentAmplitude: number;
  readonly distance: number;
  readonly sampleProgress: number;
}): number {
  if (input.distance === 0) return input.currentAmplitude;
  const progress = Math.max(0, Math.min(1, input.sampleProgress));
  const from = input.history[input.distance] ?? 0;
  const to = input.history[input.distance - 1] ?? 0;
  return from + (to - from) * progress;
}

export function advanceWaveformHistory(input: {
  readonly history: ReadonlyArray<number>;
  readonly currentAmplitude: number;
  readonly lastSampleAt: number;
  readonly timestamp: number;
}): { readonly history: ReadonlyArray<number>; readonly lastSampleAt: number } {
  const elapsedSteps = Math.max(
    0,
    Math.floor((input.timestamp - input.lastSampleAt) / HISTORY_SAMPLE_INTERVAL_MS),
  );
  if (elapsedSteps === 0) return input;
  const retainedSampleCount = Math.min(HALF_BAR_COUNT, elapsedSteps);
  return {
    history: [
      ...Array.from({ length: retainedSampleCount }, () => input.currentAmplitude),
      ...input.history,
    ].slice(0, HALF_BAR_COUNT),
    lastSampleAt: input.lastSampleAt + elapsedSteps * HISTORY_SAMPLE_INTERVAL_MS,
  };
}

export function shouldDrawWaveformFrame(timestamp: number, lastDrawAt: number): boolean {
  return timestamp - lastDrawAt + FRAME_EPSILON_MS >= FRAME_INTERVAL_MS;
}

export function shouldDrawStaticAudioUpdate(input: {
  readonly active: boolean;
  readonly phase: SymmetriaDictationPhase;
  readonly reducedMotion: boolean;
}): boolean {
  return input.active && input.phase === "recording" && input.reducedMotion;
}

export function mirroredBarXPositions(centerX: number, distance: number) {
  const offset = distance * (BAR_WIDTH + BAR_GAP);
  return {
    left: centerX - CENTER_GAP / 2 - BAR_WIDTH - offset,
    right: centerX + CENTER_GAP / 2 + offset,
  };
}

export const CenterOutWaveform = memo(function CenterOutWaveform(props: {
  sessionId: string;
  phase: SymmetriaDictationPhase;
  audioLevel: number | null;
  active: boolean;
  reducedMotion: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<Array<number>>([]);
  const currentAmplitudeRef = useRef(0);
  const targetAmplitudeRef = useRef(0);
  const staticRedrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    historyRef.current = [];
    currentAmplitudeRef.current = 0;
    targetAmplitudeRef.current = 0;
  }, [props.sessionId]);

  useEffect(() => {
    targetAmplitudeRef.current = normalizedAmplitude(props.audioLevel ?? 0);
  }, [props.audioLevel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let animationFrame = 0;
    let lastFrameAt = performance.now();
    let lastDrawAt = lastFrameAt;
    let lastSampleAt = lastFrameAt - HISTORY_SAMPLE_INTERVAL_MS;
    let width = 0;
    let height = 0;
    let waveformColor = "rgb(255 255 255)";

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const nextWidth = Math.max(1, Math.round(width * pixelRatio));
      const nextHeight = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      waveformColor = getComputedStyle(canvas).color;
    };

    const draw = (timestamp: number) => {
      if (width <= 0 || height <= 0) return;

      const deltaMs = Math.min(50, Math.max(0, timestamp - lastFrameAt));
      lastFrameAt = timestamp;
      const target = props.phase === "recording" ? targetAmplitudeRef.current : 0;
      const timeConstant = target > currentAmplitudeRef.current ? ATTACK_TIME_MS : RELEASE_TIME_MS;
      currentAmplitudeRef.current +=
        (target - currentAmplitudeRef.current) * waveformSmoothingAlpha(deltaMs, timeConstant);

      if (props.phase === "recording" && timestamp - lastSampleAt >= HISTORY_SAMPLE_INTERVAL_MS) {
        const advanced = advanceWaveformHistory({
          history: historyRef.current,
          currentAmplitude: currentAmplitudeRef.current,
          lastSampleAt,
          timestamp,
        });
        historyRef.current = [...advanced.history];
        lastSampleAt = advanced.lastSampleAt;
      }

      context.clearRect(0, 0, width, height);
      const centerX = width / 2;
      const edgeDenominator = Math.max(1, HALF_BAR_COUNT - 1);
      const sampleProgress = Math.max(
        0,
        Math.min(1, (timestamp - lastSampleAt) / HISTORY_SAMPLE_INTERVAL_MS),
      );

      for (let distance = 0; distance < HALF_BAR_COUNT; distance += 1) {
        const edgeProgress = distance / edgeDenominator;
        const positionFactor = 1 - edgeProgress * 0.42;
        const amplitude =
          props.phase === "processing" || props.phase === "grace"
            ? processingAmplitude(distance, timestamp)
            : recordingAmplitudeAtDistance({
                history: historyRef.current,
                currentAmplitude: currentAmplitudeRef.current,
                distance,
                sampleProgress,
              });
        const barHeight = Math.max(
          MIN_BAR_HEIGHT,
          Math.min(
            MAX_BAR_HEIGHT,
            MIN_BAR_HEIGHT + amplitude * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) * positionFactor,
          ),
        );
        const opacity = props.phase === "paused" ? 0.42 : Math.max(0.34, 0.92 - edgeProgress * 0.5);
        const x = mirroredBarXPositions(centerX, distance);
        const y = (height - barHeight) / 2;

        context.fillStyle = waveformColor;
        context.globalAlpha = opacity;
        context.beginPath();
        context.roundRect(x.left, y, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
        context.roundRect(x.right, y, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const animate = (timestamp: number) => {
      if (shouldDrawWaveformFrame(timestamp, lastDrawAt)) {
        lastDrawAt = timestamp;
        draw(timestamp);
      }
      animationFrame = window.requestAnimationFrame(animate);
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    const themeObserver = new MutationObserver(() => {
      waveformColor = getComputedStyle(canvas).color;
      draw(performance.now());
    });
    resizeObserver.observe(canvas);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme-id", "data-theme"],
    });
    resize();
    draw(lastFrameAt);
    lastDrawAt = lastFrameAt;
    staticRedrawRef.current = () => draw(performance.now());

    if (shouldAnimateDictationWaveform(props)) {
      animationFrame = window.requestAnimationFrame(animate);
    }

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      staticRedrawRef.current = null;
    };
  }, [props.active, props.phase, props.reducedMotion, props.sessionId]);

  useEffect(() => {
    if (shouldDrawStaticAudioUpdate(props)) staticRedrawRef.current?.();
  }, [props.active, props.audioLevel, props.phase, props.reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("h-6 min-w-0 flex-1 text-foreground", props.className)}
      data-dictation-waveform="center-out"
    />
  );
});
