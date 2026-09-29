import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { withPlugins } from "expo/config-plugins";
import { describe, expect, it } from "vitest";

import withAndroidNdkVersion from "./withAndroidNdkVersion.cjs";

const projectRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const { NDK_VERSION, OBSOLETE_AT_REACT_NATIVE_NDK } = withAndroidNdkVersion;

// android/build.gradle as `expo prebuild --clean` writes it for this app.
const templateBuildGradle = `// Top-level build file where you can add configuration options common to all sub-projects/modules.

buildscript {
  repositories {
    google()
    mavenCentral()
  }
  dependencies {
    classpath('com.android.tools.build:gradle')
    classpath('com.facebook.react:react-native-gradle-plugin')
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}

allprojects {
  repositories {
    google()
    mavenCentral()
    maven { url 'https://www.jitpack.io' }
  }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
`;

async function runProjectBuildGradleMod(config, contents) {
  const result = await config.mods.android.projectBuildGradle({
    ...config,
    modRequest: {
      platform: "android",
      modName: "projectBuildGradle",
      projectRoot,
      platformProjectRoot: NodePath.join(projectRoot, "android"),
      introspect: false,
    },
    modResults: { language: "groovy", contents },
  });
  return result.modResults.contents;
}

function pinnedBeforeRootPlugin(contents) {
  const pin = contents.indexOf(`ext.ndkVersion = "${NDK_VERSION}"`);
  return pin >= 0 && pin < contents.indexOf('apply plugin: "expo-root-project"');
}

function majorMinor(version) {
  const [major, minor] = version.split(".").map(Number);
  return major * 1000 + minor;
}

function reactNativeDefaultNdk() {
  const require = NodeModule.createRequire(import.meta.url);
  const catalog = NodeFS.readFileSync(
    NodePath.join(
      NodePath.dirname(require.resolve("react-native/package.json")),
      "gradle/libs.versions.toml",
    ),
    "utf8",
  );
  const version = catalog.match(/^ndkVersion = "([^"]+)"/m)?.[1];
  expect(version, "React Native's gradle catalog names no ndkVersion").toBeDefined();
  return version;
}

/** True while React Native's default NDK still packages a libc++ that cannot load libfbjni.so. */
function ndkPinStillNeeded(reactNativeNdk) {
  return majorMinor(reactNativeNdk) < majorMinor(OBSOLETE_AT_REACT_NATIVE_NDK);
}

describe("Android NDK pin", () => {
  it("the app config's plugins pin the NDK before the Expo root plugin reads it", async () => {
    const previousVariant = process.env.APP_VARIANT;
    process.env.APP_VARIANT = "development";
    try {
      const appConfig = (await import("../app.config.ts?ndk-pin-test")).default;
      const config = withPlugins(
        { ...appConfig, _internal: { projectRoot } },
        appConfig.plugins.filter(
          (plugin) => typeof plugin === "string" && plugin.startsWith("./plugins/withAndroid"),
        ),
      );
      expect(
        pinnedBeforeRootPlugin(await runProjectBuildGradleMod(config, templateBuildGradle)),
      ).toBe(true);
    } finally {
      if (previousVariant === undefined) delete process.env.APP_VARIANT;
      else process.env.APP_VARIANT = previousVariant;
    }
  });

  it("the NDK pin never selects an older NDK than React Native's own default", () => {
    expect(majorMinor(NDK_VERSION)).toBeGreaterThanOrEqual(majorMinor(reactNativeDefaultNdk()));
  });

  it("the NDK pin is still needed by React Native's default NDK", () => {
    const reactNativeNdk = reactNativeDefaultNdk();
    expect(
      ndkPinStillNeeded(reactNativeNdk),
      `React Native now defaults to NDK ${reactNativeNdk}: remove withAndroidNdkVersion, its app.config.ts entry, and this test.`,
    ).toBe(true);
  });

  it("the NDK pin removal check trips from the documented React Native NDK onward", () => {
    // The versions React Native has shipped as its default, then the threshold and later.
    expect(ndkPinStillNeeded("27.0.12077973")).toBe(true);
    expect(ndkPinStillNeeded("27.1.12297006")).toBe(true);
    expect(ndkPinStillNeeded("28.0.13004108")).toBe(true);
    expect(ndkPinStillNeeded(`${OBSOLETE_AT_REACT_NATIVE_NDK}.13356709`)).toBe(false);
    expect(ndkPinStillNeeded("29.0.14033849")).toBe(false);
  });

  it("the NDK pin is written once across repeated prebuilds and replaces an older pin", async () => {
    const config = withAndroidNdkVersion({ name: "Test", slug: "test" });
    const pinned = await runProjectBuildGradleMod(config, templateBuildGradle);
    expect(await runProjectBuildGradleMod(config, pinned)).toBe(pinned);

    const olderPin = pinned.replace(`"${NDK_VERSION}"`, '"27.0.12077973"');
    expect(await runProjectBuildGradleMod(config, olderPin)).toBe(pinned);
  });

  it("the NDK pin fails visibly when the Expo root build template changes", async () => {
    const config = withAndroidNdkVersion({ name: "Test", slug: "test" });
    await expect(
      runProjectBuildGradleMod(
        config,
        templateBuildGradle.replace('apply plugin: "expo-root-project"\n', ""),
      ),
    ).rejects.toThrow('could not find `apply plugin: "expo-root-project"`');
  });
});
