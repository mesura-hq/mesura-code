# ADR-008 — Remove the native mobile apps

**Status:** Accepted on 2026-10-05 by the developer.

## Decision

Delete upstream's native mobile apps (`apps/mobile`, the React Native app for Android and
iOS) and the tooling that exists only for them: their scripts, CI workflows, agent skills,
docs and package patches. On a phone, this fork is used through the web app in the
browser, over the tailnet. That is the mobile surface.

This overrides the fork's general rule that disabling beats deleting (`AGENTS.md`,
principle 1). The rule assumes code nobody uses costs nothing while it sits there. For the
native apps that assumption was false, and the cost landed on every task:

- `AGENTS.md` named Android as a surface a change had to be correct on, so plans added
  native phases. The speech-to-text run spent a whole phase on it, plus two emulator
  boots and two native builds, for an app the developer never ran.
- Agents searched, read, type-checked and ran the tests of about 950 files that ship to
  no one, about 1,850 tests in that package alone.
- The developer wants one codebase to maintain. A second client with its own navigation,
  state and native modules doubles every feature decision.

A note in `AGENTS.md` alone was rejected. Text can be missed, and a deleted path cannot be
touched by accident.

## What was kept

- `packages/client-runtime`, `packages/contracts` and `packages/shared`. Web uses them.
  Upstream also shares them with its mobile app, so some modules there (for example
  `voice-input/`) now have no caller in this fork. They stay as upstream wrote them,
  because deleting them would add conflict surface for no saving.
- The server's push-notification code for iOS and Android. It is server code that agents
  meet only when a task touches it, and deleting it would add conflicts on busy files.
- Incidental mentions of `apps/mobile` inside upstream files: ignore globs, test fixture
  strings, comments, the oxlint rule for mobile theme escapes. They are harmless, and
  editing them would turn every upstream change to those lines into a conflict.
- An orphaned Expo dependency cycle in `pnpm-lock.yaml`. No workspace package imports it,
  but pnpm keeps it reachable through upstream's `overrides` block. Removing it means
  editing that block, which upstream changes often.

## Accepted upstream merge cost

`git log --oneline --since="3 months ago" upstream/main -- apps/mobile` counted 608 of
upstream's 2,824 commits on 2026-10-05: about one in five touches the native app. Every
sync therefore brings some of the removed paths back:

- **modify/delete conflicts** on files upstream edited;
- **new files** under the removed directories, which merge with no conflict at all;
- **patch entries** in `pnpm-workspace.yaml` for native packages, which come back with
  upstream's version of that file and break `pnpm install` (`ENOENT` when the patch file
  stays deleted, `ERR_PNPM_UNUSED_PATCH` when upstream adds a new one).

## Rule for upstream sync

After `git merge upstream/main`, before resolving anything else:

1. Run `node scripts/remove-native-mobile.ts`. It deletes every tracked file under the
   removed paths, which resolves the modify/delete conflicts and drops the new files. It
   also removes the `patchedDependencies` entries in `pnpm-workspace.yaml` for packages only
   the native apps used, with their patch files. While `pnpm-workspace.yaml` still has
   conflict markers it skips that part and exits 1: resolve the file, then run it again.
2. Resolve `pnpm-lock.yaml` by regenerating it. A merged lockfile can fail to parse (the
   2026-10-05 rehearsal produced a duplicate key), so take either side and let
   `pnpm install` rewrite it. Without a terminal, add `--config.confirmModulesPurge=false`.
3. If `pnpm install` fails with `ERR_PNPM_UNUSED_PATCH`, upstream patched a new
   native-only package. Add its name to `REMOVED_NATIVE_MOBILE_PATCHED_PACKAGES` and run
   step 1 again.
4. `tests/unit/native-mobile-removed.test.ts` fails while any removed path or native patch
   entry is still there.

Both lists live in `scripts/lib/native-mobile-removal.ts`. Add a prefix there when upstream
adds a new native-only path.

This sequence was rehearsed on 2026-10-05 against `upstream/main` in a throwaway clone. The
merge brought back 586 native paths, 343 of them conflicted. The script removed all of them
and 11 patch entries. `pnpm install` then named three new native patches (`expo-blur`,
`expo-glass-effect`, `react-native-nitro-markdown`), which are now on the list, and the
install passed. CI's release smoke check then named two more (`@expo/metro-config`,
`expo-widgets`): the orphaned Expo cycle still installs them in the full workspace, but the
trimmed release workspace does not, so their patches failed there as unused.

Do not restore a native path to resolve a conflict. Where an upstream commit changes both
shared code and the native app, keep the shared half.

## Recovering the native apps

Restore them from history with `git checkout <commit before this ADR> -- apps/mobile`, or
take them fresh from upstream. Either way, revert this ADR first, so the sync rule stops
deleting them.
