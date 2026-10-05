/**
 * The paths this fork removed with upstream's native mobile apps
 * (`docs/mesura/adr-008-remove-native-mobile.md`). Each entry is a path prefix.
 *
 * Upstream keeps changing these paths, so every upstream merge brings some of them back:
 * modify/delete conflicts on files upstream edited, and new files that merge without any
 * conflict. `scripts/remove-native-mobile.ts` deletes them again, and
 * `tests/unit/native-mobile-removed.test.ts` fails while any tracked file still matches.
 * Both read this list, so the two cannot drift apart.
 */
export const REMOVED_NATIVE_MOBILE_PREFIXES = [
  "apps/mobile/",
  ".agents/skills/test-t3-mobile/",
  ".agents/skills/ios-debugger-agent/",
  ".agents/skills/ios-simulator-browser/",
  ".github/workflows/mobile-",
  "scripts/mobile-",
  "scripts/export-android-icons.ts",
  "scripts/legend-list-initial-reveal.test.ts",
  "docs/internals/mobile-development.md",
  "docs/internals/mobile-navigation.md",
  "docs/operations/android-notifications.md",
  "docs/operations/mobile-app-store-screenshots.md",
  "docs/user/mobile-notifications.md",
] as const;

export function isRemovedNativeMobilePath(repositoryPath: string): boolean {
  return REMOVED_NATIVE_MOBILE_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix));
}

/**
 * Packages upstream patches only for the native apps, by name so that a version bump is still
 * caught. With the apps gone pnpm installs none of them, and their `patchedDependencies`
 * entries break the install: `ERR_PNPM_UNUSED_PATCH` when the patch file exists, and a bare
 * `ENOENT` when only the entry came back, which is what a merge of upstream's
 * `pnpm-workspace.yaml` does. When pnpm names a new unused patch, add its package here.
 */
export const REMOVED_NATIVE_MOBILE_PATCHED_PACKAGES = [
  "@clerk/expo",
  "@react-native-ai/apple",
  "@react-native-menu/menu",
  "@react-navigation/native-stack",
  "expo-audio",
  "expo-blur",
  "expo-glass-effect",
  "expo-sharing",
  "react-native-gesture-handler",
  "react-native-keyboard-controller",
  "react-native-nitro-markdown",
  "react-native-nitro-modules",
  "react-native-reanimated",
  "react-native-screens",
  "react-native-shiki-engine",
  "uniwind",
] as const;

/** A `patchedDependencies` line of `pnpm-workspace.yaml`: `  "name@version": patches/file`. */
const PATCH_ENTRY = /^\s+"?((?:@[^/@"\s]+\/)?[^@"\s]+)@[^"\s:]+"?:\s*(\S+)\s*$/;

/**
 * Removes the native-only entries from the `patchedDependencies` block of a
 * `pnpm-workspace.yaml` text, with the comment lines directly above each one, and returns the
 * new text and the patch files those entries named. Text in, text out, so the rest of the file
 * keeps upstream's exact formatting.
 */
export function pruneNativeMobilePatches(workspaceYaml: string): {
  readonly text: string;
  readonly removedPatchFiles: ReadonlyArray<string>;
} {
  const kept: string[] = [];
  const removedPatchFiles: string[] = [];
  let inPatches = false;
  for (const line of workspaceYaml.split("\n")) {
    if (/^\S/.test(line)) inPatches = line.startsWith("patchedDependencies:");
    const entry = inPatches ? PATCH_ENTRY.exec(line) : null;
    const packageName = entry?.[1];
    if (
      packageName !== undefined &&
      (REMOVED_NATIVE_MOBILE_PATCHED_PACKAGES as ReadonlyArray<string>).includes(packageName)
    ) {
      while (kept.length > 0 && /^\s+#/.test(kept[kept.length - 1]!)) kept.pop();
      removedPatchFiles.push(entry![2]!);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), removedPatchFiles };
}
