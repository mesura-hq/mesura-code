const { withProjectBuildGradle } = require("expo/config-plugins");

// WORKAROUND: pins the Android NDK for every Gradle module. The prebuilt
// libfbjni.so this app ships references `__cxa_init_primary_exception`, which
// the libc++_shared.so of React Native's catalog default NDK (27.1.12297006)
// does not export. An APK built with that NDK installs, then aborts before JS
// with `SoLoaderDSONotFoundError: libfbjni.so`. NDK 28's libc++ exports the
// symbol. Remove this plugin, its app.config.ts entry, and its test once React
// Native's `ndkVersion` catalog entry in
// node_modules/react-native/gradle/libs.versions.toml reaches
// `OBSOLETE_AT_REACT_NATIVE_NDK`; withAndroidNdkVersion.test.mjs fails then.
//
// The pin is set as `rootProject.ext.ndkVersion` ahead of `expo-root-project`,
// which keeps an existing value (ExpoRootProjectPlugin `setIfNotExist`), so the
// app and every library read the same NDK through `rootProject.ext.ndkVersion`.
const NDK_VERSION = "28.1.13356709";
/** React Native's default NDK major.minor from which this pin is unneeded. */
const OBSOLETE_AT_REACT_NATIVE_NDK = "28.1";
const ROOT_PLUGIN_LINE = 'apply plugin: "expo-root-project"';
const MARKER = "// @generated withAndroidNdkVersion";
const PIN_BLOCK = `${MARKER}\next.ndkVersion = "${NDK_VERSION}"\n`;
const PREVIOUS_PIN = new RegExp(`${MARKER}\\next\\.ndkVersion = "[^"]*"\\n`);

function pinNdkVersion(contents) {
  const unpinned = contents.replace(PREVIOUS_PIN, "");
  if (!unpinned.includes(ROOT_PLUGIN_LINE)) {
    throw new Error(
      `withAndroidNdkVersion: could not find \`${ROOT_PLUGIN_LINE}\` in android/build.gradle; the Expo template changed, so the NDK pin would no longer apply before the Expo root plugin.`,
    );
  }
  return unpinned.replace(ROOT_PLUGIN_LINE, `${PIN_BLOCK}${ROOT_PLUGIN_LINE}`);
}

module.exports = function withAndroidNdkVersion(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("withAndroidNdkVersion: android/build.gradle is expected to be Groovy.");
    }
    nextConfig.modResults.contents = pinNdkVersion(nextConfig.modResults.contents);
    return nextConfig;
  });
};

module.exports.NDK_VERSION = NDK_VERSION;
module.exports.OBSOLETE_AT_REACT_NATIVE_NDK = OBSOLETE_AT_REACT_NATIVE_NDK;
