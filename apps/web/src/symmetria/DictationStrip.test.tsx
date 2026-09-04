import { SymmetriaDictationSession } from "@symmetria/broker-contract";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, assert, it } from "vite-plus/test";

import { DictationMicrophoneButton, DictationStripBanner } from "./DictationStrip";
import { useDictationSessionStore } from "./dictationSessionStore";
import { MaterialDictationModeIcon } from "./MaterialDictationModeIcon";

afterEach(() => {
  useDictationSessionStore.setState({
    session: null,
    bridgeAvailable: false,
    error: null,
  });
});

const recordingSession = Schema.decodeUnknownSync(SymmetriaDictationSession)({
  protocolVersion: { major: 1, minor: 4 },
  sessionId: "stt_strip_test",
  target: { kind: "thread", environmentId: "env_local", threadId: "thr_strip_test" },
  source: "mesura",
  phase: "recording",
  mode: "inject",
  projectName: "mesura-code",
  startedAt: "2026-09-04T12:00:00.000Z",
  elapsedMs: 4_000,
  audioLevel: 0.4,
  graceRemainingMs: null,
  presentation: { mesuraOwnsPresentation: true, leaseExpiresAt: null },
});

// The strip must render on upstream's attached-banner primitives. A hand-styled
// surface regressed twice: the W35 sync silently orphaned its selectors, and the
// shell hides its shared glass whenever an attached banner is present, which put
// a see-through band in the strip's overlap. This pins the coupling that
// prevents both.
it("renders an active session as an attached composer banner", () => {
  const markup = renderToStaticMarkup(
    <DictationStripBanner
      session={recordingSession}
      reducedMotion
      onControl={() => undefined}
      onChangeMode={() => undefined}
      onDismiss={() => undefined}
    />,
  );

  assert.include(markup, 'data-slot="composer-banner-attachment"');
  assert.include(markup, 'data-composer-banner-surface="attached"');
  assert.include(markup, 'data-phase="recording"');
});

it("disables the composer microphone with an explicit Shell-unavailable label", () => {
  const markup = renderToStaticMarkup(<DictationMicrophoneButton />);

  assert.include(markup, 'aria-disabled="true"');
  assert.include(markup, 'aria-label="Symmetria Shell dictation is unavailable"');
});

it("uses the same named Material Symbols as the Shell mode control", () => {
  const markup = renderToStaticMarkup(
    <>
      <MaterialDictationModeIcon mode="clipboard" />
      <MaterialDictationModeIcon mode="inject" />
      <MaterialDictationModeIcon mode="submit" />
    </>,
  );

  assert.include(markup, 'data-material-symbol="content_copy"');
  assert.include(markup, 'data-material-symbol="input"');
  assert.include(markup, 'data-material-symbol="send"');
});
