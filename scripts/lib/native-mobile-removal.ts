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
] as const;

export function isRemovedNativeMobilePath(repositoryPath: string): boolean {
  return REMOVED_NATIVE_MOBILE_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix));
}
