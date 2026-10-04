/**
 * Phase 7 (mobile dictation), criterion 1: the Android build asks for the microphone.
 * Entry points: the composed Android manifest from `expo config --type introspect`, which runs
 * `app.config.ts` through every config plugin in order, as prebuild does; and the `expo-audio`
 * plugin entry on its own. Only the composed manifest can see one plugin undo another's
 * permission: `expo-image-picker` with `microphonePermission: false` blocks `RECORD_AUDIO`
 * with `tools:node="remove"`, whatever `expo-audio` asks for.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import appConfig from "../app.config";

const require = NodeModule.createRequire(import.meta.url);

type AudioPluginOptions = {
  readonly recordAudioAndroid?: boolean;
  readonly enableBackgroundRecording?: boolean;
};

function audioPluginOptions(): AudioPluginOptions {
  const entry = appConfig.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-audio",
  );
  if (!Array.isArray(entry)) throw new Error("app.config.ts has no expo-audio plugin entry");
  return entry[1] as AudioPluginOptions;
}

type ManifestPermission = { readonly $: Record<string, string> };

/** The Android manifest after every plugin in `app.config.ts`, as `expo config` composes it. */
function composedAndroidPermissions(): ReadonlyArray<Record<string, string>> {
  const result = NodeChildProcess.spawnSync(
    "./node_modules/.bin/expo",
    ["config", "--type", "introspect", "--json"],
    {
      cwd: NodePath.join(import.meta.dirname, ".."),
      env: { ...process.env, APP_VARIANT: "development" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) throw new Error(`expo config failed: ${result.stderr}`);
  const introspected = JSON.parse(result.stdout) as {
    _internal: {
      modResults: {
        android: { manifest: { manifest: { "uses-permission"?: ManifestPermission[] } } };
      };
    };
  };
  const permissions =
    introspected._internal.modResults.android.manifest.manifest["uses-permission"];
  return (permissions ?? []).map((permission) => permission.$);
}

const RECORD_AUDIO = "android.permission.RECORD_AUDIO";

describe("mobile dictation composed Android manifest", () => {
  it("keeps RECORD_AUDIO in the Android manifest after every plugin in app.config.ts runs", () => {
    const recordAudio = composedAndroidPermissions().filter(
      (permission) => permission["android:name"] === RECORD_AUDIO,
    );
    expect(recordAudio.length).toBeGreaterThan(0);
    expect(recordAudio.filter((permission) => permission["tools:node"] === "remove")).toEqual([]);
  }, 60_000);
});

describe("mobile dictation Android microphone permission", () => {
  it("enables the Android record-audio option on the expo-audio plugin", () => {
    expect(audioPluginOptions().recordAudioAndroid).toBe(true);
  });

  it("puts RECORD_AUDIO in the Android permissions after the expo-audio plugin runs", () => {
    type WithAudio = (
      config: { name: string; slug: string; android?: { permissions?: string[] } },
      options: AudioPluginOptions,
    ) => { android?: { permissions?: string[] } };
    const plugin = require("expo-audio/app.plugin.js") as WithAudio | { default: WithAudio };
    const withAudio = typeof plugin === "function" ? plugin : plugin.default;
    const result = withAudio({ name: "probe", slug: "probe", android: {} }, audioPluginOptions());
    expect(result.android?.permissions).toContain("android.permission.RECORD_AUDIO");
  });

  // Guard: background recording stays out of scope (it needs a foreground service).
  it("keeps background recording off on the expo-audio plugin", () => {
    expect(audioPluginOptions().enableBackgroundRecording).toBe(false);
  });
});
