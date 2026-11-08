/**
 * Path prefixes this fork removed with upstream's native mobile apps (ADR-008). Every upstream
 * merge brings some back. `scripts/remove-native-mobile.ts` deletes them again, and
 * `tests/unit/native-mobile-removed.test.ts` fails while a tracked file still matches. Both read
 * this list, so the two cannot drift apart.
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

/** Preserve workflow formatting while removing dependencies on deleted native jobs. */
export function pruneNativeMobileJobNeeds(workflowYaml: string): string {
  const removedJobs = new Set(["mobile_native_changes", "mobile_native_static_analysis"]);
  return workflowYaml.replace(
    /^( +)needs:\s*(\[[\s\S]*?\]|(?:\n\1 +-[^\n]*)+)/gm,
    (needs: string, indentation: string, list: string) => {
      if (list.startsWith("[")) {
        const kept = list
          .slice(1, -1)
          .split(",")
          .filter((entry) => !removedJobs.has(entry.trim()));
        if (kept.length === list.slice(1, -1).split(",").length) return needs;
        return `${indentation}needs: [${kept.join(",")}]`;
      }
      const pruned = needs.replace(/^ +-[ \t]*(\w+)[ \t]*$/gm, (entry: string, job: string) =>
        removedJobs.has(job) ? "" : entry,
      );
      return /^ +-/m.test(pruned) ? pruned : `${indentation}needs: []`;
    },
  );
}

/**
 * Packages upstream patches only for the native apps, listed by name so a version bump is still
 * caught. pnpm installs none of them, so their `patchedDependencies` entries break the install:
 * `ERR_PNPM_UNUSED_PATCH` with the patch file, a bare `ENOENT` with only the entry (what a merge
 * of upstream's `pnpm-workspace.yaml` brings). For a new unused patch pnpm names, add its package.
 */
export const REMOVED_NATIVE_MOBILE_PATCHED_PACKAGES = [
  "@clerk/expo",
  "@clerk/expo-native-components",
  "@expo/fingerprint",
  "@expo/metro-config",
  "@expo/ui",
  "@react-native-ai/apple",
  "@react-native-menu/menu",
  "@react-navigation/native-stack",
  "expo-audio",
  "expo-blur",
  "expo-glass-effect",
  "expo-modules-core",
  "expo-network",
  "expo-sharing",
  "expo-video",
  "expo-widgets",
  "react-native-gesture-handler",
  "react-native-image-viewing",
  "react-native-keyboard-controller",
  "react-native-nitro-markdown",
  "react-native-nitro-modules",
  "react-native-pdf-jsi",
  "react-native-reanimated",
  "react-native-screens",
  "react-native-shiki-engine",
  "react-native-webview",
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

/** Native tarballs disappear with their app, so their build permissions must disappear too. */
export function pruneNativeMobileBuilds(workspaceYaml: string): string {
  let inBuilds = false;
  return workspaceYaml
    .split("\n")
    .filter((line) => {
      if (/^\S/.test(line)) inBuilds = line.startsWith("allowBuilds:");
      if (!inBuilds) return true;
      const tarball = /@file:([^"'\s]+)["']?:/.exec(line)?.[1];
      return tarball === undefined || !isRemovedNativeMobilePath(tarball);
    })
    .join("\n");
}
