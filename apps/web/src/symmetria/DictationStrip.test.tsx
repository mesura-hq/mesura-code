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

const renderBanner = (session: typeof recordingSession) =>
  renderToStaticMarkup(
    <DictationStripBanner
      session={session}
      reducedMotion
      onControl={() => undefined}
      onChangeMode={() => undefined}
      onDismiss={() => undefined}
    />,
  );

// The strip must render on upstream's attached-banner primitives. A hand-styled
// surface regressed twice: the W35 sync silently orphaned its selectors, and the
// shell hides its shared glass whenever an attached banner is present, which put
// a see-through band in the strip's overlap. This pins the coupling that
// prevents both. Asserting markup attributes deliberately breaks the repo's
// no-markup-assertion default: the coupling is a CSS-level contract with
// upstream, invisible to TypeScript, and CSS reports its loss as silence.
it("renders an active session as an attached composer banner", () => {
  const markup = renderBanner(recordingSession);

  assert.include(markup, 'data-composer-banner-surface="attached"');

  // The pulse selector and the fork-styling-hooks guard both require the class
  // and data-phase on the same element, so pin them to one opening tag.
  const attachmentTag = /<div[^>]*mesura-dictation-strip[^>]*>/.exec(markup)?.[0] ?? "";
  assert.include(attachmentTag, 'data-slot="composer-banner-attachment"');
  assert.include(attachmentTag, 'data-phase="recording"');
});

// The phase booleans (canRecordControl, canChangeMode, canDismiss) are the kind
// of matrix that drifts. Aria-labels are the stable, observable anchor.
const PHASE_CONTROLS = [
  {
    phase: "recording",
    present: ['aria-label="Pause recording"', 'aria-label="Stop and transcribe"'],
    absent: ['aria-label="Send now"', 'aria-label="Hide dictation status"'],
  },
  {
    phase: "paused",
    present: ['aria-label="Resume recording"', 'aria-label="Cancel dictation"'],
    absent: ['aria-label="Pause recording"', 'aria-label="Send now"'],
  },
  {
    phase: "grace",
    present: ['aria-label="Send now"'],
    absent: ['aria-label="Pause recording"', 'aria-label="Hide dictation status"'],
  },
  {
    phase: "completed",
    present: [">Delivered<", 'aria-label="Hide dictation status"'],
    absent: ['aria-label="Pause recording"', 'aria-label="Send now"'],
  },
] as const;

for (const expected of PHASE_CONTROLS) {
  it(`shows the ${expected.phase} phase's controls and no others`, () => {
    const markup = renderBanner({ ...recordingSession, phase: expected.phase });

    for (const marker of expected.present) assert.include(markup, marker);
    for (const marker of expected.absent) assert.notInclude(markup, marker);
  });
}

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
