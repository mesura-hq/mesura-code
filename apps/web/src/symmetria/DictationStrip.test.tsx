import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, assert, it } from "vite-plus/test";

import { DictationMicrophoneButton } from "./DictationStrip";
import { useDictationSessionStore } from "./dictationSessionStore";
import { MaterialDictationModeIcon } from "./MaterialDictationModeIcon";

afterEach(() => {
  useDictationSessionStore.setState({
    session: null,
    bridgeAvailable: false,
    error: null,
  });
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
