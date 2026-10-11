---
name: test-t3-app
description: Launch, retain, and test the Mesura Code web app in isolated development environments, including a paired headless browser for desktop and phone checks, first-try browser authentication with one-time pairing URLs, pairing-token recovery, worktree-safe state directories, cross-turn dev server lifecycle, and direct SQLite inspection or fixture seeding. Use when an agent needs to run T3 locally, screenshot or drive its UI headless, iteratively test UI behavior with a human, recover from an expired or consumed pairing token, isolate dev state, or prepare test data in state.sqlite.
---

# Test T3 App

Use this skill for the web client, including the phone-sized checks this fork relies on in place of native mobile clients (removed, see `docs/mesura/adr-008-remove-native-mobile.md`).

## Start an isolated web environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - Use the repository's ignored `.t3` directory for reusable worktree-local state.
   - Use `mktemp -d /tmp/t3code-test.XXXXXX` for disposable state and retain the printed absolute path.
3. Start the full web stack with `vp run dev`. Add `--share` when the user needs to open it from another tailnet device. In a linked worktree it defaults to that worktree's gitignored `.t3`; pass `--home-dir <base-dir>` only when the test needs a different isolated directory.
4. Run it so it outlives your turn: under the host's workload runner (`mesura-agent-service <name> --memory 3G -- vp run dev` on vigilia hosts), never `&` or `nohup`. Read the selected server port, web port, base directory, and pairing URL from its output (`journalctl --user -u mesura-workload-<name>`).

Treat a base directory as disposable only when it was created or deliberately selected for the current test. Never delete or directly seed the shared `~/.t3` directory. Prefer starting with a new temporary base directory over clearing state of uncertain ownership.

The worktree-local default deliberately outranks an ambient `T3CODE_HOME`; do not pass the shared home through to a worktree dev server.

Ports are derived from the worktree path but can shift when occupied. Always read the actual values from the `[dev-runner]` line.

Shared browser dev is single-origin: Vite proxies the backend paths, so never set `VITE_HTTP_URL` or `VITE_WS_URL` for `dev`/`dev:web`.

The dev runner disables browser auto-open by default. Do not pass `--browser` during automated testing: an automatically opened page can consume the one-time bootstrap token before the controlled browser uses it.

### Verify a shared environment before human handoff

When another person will use the printed pairing URL, first open the shared origin without the pairing path or fragment in the controlled browser and confirm the Mesura Code app loads. This browser navigation is required even when curl succeeds because browsers block some otherwise reachable ports before making a network request.

Do not open the other person's complete pairing URL during this reachability check; doing so consumes its one-time token. If the agent also needs an authenticated browser, create and consume a separate pairing token, then leave a fresh token for the other person.

## Preserve the environment while iterating

Treat the overall testing or implementation loop—not an assistant turn or one verification pass—as the environment lifecycle boundary.

- Keep the dev process, base directory, selected ports, authenticated browser tab, registered projects, and seeded fixtures alive while the user may inspect the result or request follow-up changes.
- Do not stop the server merely because one verification pass completed or because you are yielding a response to the user.
- Before starting another environment, check whether the existing process and browser tab still serve the task. Reuse them when healthy instead of discarding useful state.
- On a later turn, verify that the existing process is alive and reuse its printed ports and base directory. If it exited, restart with the same base directory; create a new pairing token only when the browser session is no longer valid.
- Tell the user when a test environment remains available, including its non-secret web URL when useful. Include a pairing token only when the user still needs to pair (see below).

## Authenticate the browser on the first navigation

1. Wait for the server log that says authentication is required and includes a URL ending in `/pair#token=...`.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open that complete URL exactly once as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

Keep pairing URLs out of screenshots, committed files, and durable logs. When the user asked for a shared environment, the deliverable IS the full pairing URL — paste it in your reply, token and all; a bare origin is useless to them. A pairing token is short-lived and single-use; opening the URL in another browser or opening it twice can consume it, so never open a URL you handed to the user.

## Drive the app in a headless browser

Use the repository's harness instead of writing a Playwright script from scratch. It resolves a Chromium headless shell, mints its own pairing token, pairs once into the worktree's `.t3/browser-profile` (it survives reboots), and opens the app in the dark theme at desktop size or as a Pixel 7.

- Screenshot: `node scripts/mesura-browser.ts shot <route> <file.png> [--device phone] [--theme light] [--selector <css>]`. Prefer `--selector`: a crop costs a fraction of a full-page PNG in context.
- Interactions: write a script that imports `openMesuraPage` from `<repo>/scripts/lib/mesura-browser.ts` and returns `{ page, context, origin, close }`. One process may hold the profile at a time.
- Open a thread by its route (`/<environmentId>/<threadId>`), not by its position in the sidebar: list order drifts.

Traps that produced false verdicts before:

- **Keyboard criteria:** only the entry point may be focused with `locator.focus()`. Every later move must be a real key press, or the probe skips the route it claims to test.
- **Shifted symbols:** `page.keyboard.press("Shift+/")` sends key `/` with `shiftKey`, which no keyboard produces. Press the glyph: `press("?")`.
- **Pixels over styles:** assert visual changes on a screenshot, in the dark theme. A computed-style check once passed a focus ring that Chromium drew in system blue.
- **Shadow roots:** the file tree's rows are inside a shadow root, so `innerText` misses them. Use role locators (`getByRole("treeitem")`).

## Recover a consumed or expired pairing token

Run `node apps/server/src/bin.ts pair` from the repository root. It discovers the running dev server (worktree `.t3` first, same precedence as the dev runner) and prints a fresh `Pairing URL` against the server's current web origin, including a `--share` tailnet origin. Pass `--base-dir <base-dir>` only when the server was started with `--home-dir`, using the identical path.

Tokens from `pair` carry standard client scopes. The startup pairing URL carries admin scopes; if the user needs Settings → Connections management (`access:write`), restart the server and hand over the new startup URL instead.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before changing the database.

- Use `node apps/server/scripts/t3-sqlite-state.ts query` for schema discovery and read-only checks.
- Stop the dev server before using `node apps/server/scripts/t3-sqlite-state.ts exec`, then restart it with the same base directory.
- Seed projection tables only for disposable UI fixtures. Use application commands and APIs when testing business behavior or projection correctness.
- Use the auth CLI, not direct `auth_*` table edits, for pairing and sessions.

The helper refuses to write to the shared `~/.t3` directory by default and creates a database backup before each mutation.

## Tear down only when the testing loop is finished

Tear down when the user explicitly asks, confirms the iteration is finished, or the overall task is genuinely complete with no pending human review. Do not infer completion from the end of an assistant turn.

When teardown is appropriate:

1. Stop the dev process with its terminal interrupt.
2. Preserve the isolated base directory when it contains useful reproduction evidence or state for a likely follow-up.
3. Otherwise remove only a path created for this test after resolving and verifying the exact target.

If completion is uncertain, keep the environment alive and mention that it is retained for further iteration. A fresh isolated base directory remains the safest reset when authentication, migrations, or fixture state becomes ambiguous.

## Troubleshoot predictably

- If the browser shows an unauthenticated pairing screen, issue a new token instead of retrying the consumed URL.
- If the pairing URL is no longer visible, create a replacement token with both `--dev-url` and `--base-url`.
- If the replacement token is rejected, verify that the CLI and server use the identical absolute base directory and web URL.
- If the UI shows unexpected data, verify that every command uses the identical explicit base directory before editing anything.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.
