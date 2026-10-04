// @vitest-environment happy-dom
// Phase 7 (mobile dictation), criterion 5: the composer chip for a `dictation` marker.
// Entry points: `ComposerEditor` from `T3ComposerEditor.native.tsx` (Android, through
// `T3ComposerEditor.android.tsx`) and from `T3ComposerEditor.ios.tsx`, mounted with
// the native view stubbed so the controlled document they hand to native code can be
// read. The chip itself is drawn natively and is not exercised here.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  lastProps: null as Record<string, unknown> | null,
}));

vi.mock("expo", () => ({
  requireNativeView: () =>
    function NativeComposerEditor(props: Record<string, unknown>) {
      fixture.lastProps = props;
      return null;
    },
}));
vi.mock("expo-paste-input", () => ({
  TextInputWrapper: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("react-native", () => ({
  Image: { resolveAssetSource: () => ({ uri: "asset://icon" }) },
  StyleSheet: { flatten: (style: unknown) => style ?? {} },
  Platform: { OS: "android" },
}));
vi.mock("@t3tools/mobile-markdown-text/file-icons", () => ({
  markdownFileIconSource: () => 1,
}));
vi.mock("../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#808080" }),
}));
vi.mock("../lib/useFontFamily", () => ({ useFontFamily: () => "sans-serif" }));
vi.mock("../lib/useNativePaste", () => ({ useNativePaste: () => vi.fn() }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ systemColorsActive: false }),
}));
vi.mock("../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));

import { contextChipPresentation } from "@t3tools/mobile-markdown-text/markdown";
import { ComposerEditor as AndroidComposerEditor } from "./T3ComposerEditor.native";
import { ComposerEditor as IosComposerEditor } from "./T3ComposerEditor.ios";

const dictationMarker = "[Transcribing](t3-context://v1/dictation/job-chip-1)";
const terminalMarker = "[Build output](t3-context://v1/terminal/terminal-gone)";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  fixture.lastProps = null;
});

interface EditorToken {
  readonly source: string;
  readonly label: string;
  readonly symbol?: string;
}

function renderTokens(
  Editor: typeof AndroidComposerEditor,
  value: string,
): ReadonlyArray<EditorToken> {
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => root!.render(<Editor value={value} onChangeText={() => undefined} />));
  const document_ = JSON.parse(String(fixture.lastProps?.controlledDocumentJson)) as {
    tokensJson: string;
  };
  return JSON.parse(document_.tokensJson) as EditorToken[];
}

describe.each([
  { platform: "Android", Editor: AndroidComposerEditor },
  { platform: "iOS", Editor: IosComposerEditor },
])("$platform composer dictation chip", ({ Editor }) => {
  it("labels a pending dictation marker without the unavailable suffix", () => {
    const token = renderTokens(Editor, `say ${dictationMarker} now`).find(
      (entry) => entry.source === dictationMarker,
    );
    expect(token?.label).toBe("Transcribing");
  });

  it("draws a pending dictation marker with the waveform symbol", () => {
    const token = renderTokens(Editor, dictationMarker).find(
      (entry) => entry.source === dictationMarker,
    );
    expect(token?.symbol).toBe("waveform");
  });

  // Guard: other context kinds still say when their record is gone.
  it("still marks a context chip without its record as unavailable", () => {
    const token = renderTokens(Editor, `see ${terminalMarker}`).find(
      (entry) => entry.source === terminalMarker,
    );
    expect(token?.label).toBe("Build output · unavailable");
  });
});

describe("dictation chip presentation", () => {
  it("gives the dictation context kind its own waveform presentation", () => {
    expect(contextChipPresentation("dictation").symbol).toBe("waveform");
    expect(contextChipPresentation("dictation")).not.toEqual(contextChipPresentation("file"));
  });
});
