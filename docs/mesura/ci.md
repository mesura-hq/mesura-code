# CI on this fork

This fork's CI runs on [Blacksmith](https://blacksmith.sh), like upstream's, and
the workflow files are upstream's with almost no edits. Two facts that decide
what CI does are **not visible in `.github/workflows/`**: which runners exist,
and which workflows are disabled. Both live in GitHub and Blacksmith settings,
which is why they are written down here.

## Where jobs run

The repository is `mesura-hq/mesura-code`, an organization repository, and the
Blacksmith GitHub App is installed on `mesura-hq` with access to `mesura-code`
only. Every `runs-on: blacksmith-*` label in upstream's workflows therefore
resolves to a real Blacksmith runner, with no edit to any workflow file — the
fork's first principle (`AGENTS.md`, "Upstream keeps moving, and we keep
pulling") applied to CI.

Blacksmith bills by the minute, and the operating system of the runner sets the
rate. Linux jobs are the normal cost. A `blacksmith-*-macos-*` or
`blacksmith-*-windows-*` label is also served, and costs more: a workflow that
requests one runs and is billed, it does not queue.

`CI` runs on every pull request and on pushes to `main` and to `dev`. This
fork's edits to `ci.yml` each carry a `# Mesura:` comment: the `dev` trigger
(`dev` is where pull requests land and are tested together, so a merge result
needs its own run) and the Neovim setup for the editor conformance tests. The
native mobile jobs were deleted with the app, in `69c16ab7cb`.

The repository is public. Workflows from a fork's pull request need approval
for every outside contributor (repository setting, `all_external_contributors`),
so a stranger's pull request cannot spend Blacksmith minutes.

### Why not self-hosted runners

Until 2026-10, CI ran on two self-hosted runners on `vigilia-home`, the
operator's home server, labelled as Blacksmith runners. That box also hosts the
Mesura Code server and every agent session, and CI competed with them for its
30G of memory; the jobs were also about 6x slower than on Blacksmith. Do not
bring CI back onto that box.

## Eight workflows are disabled, and only GitHub knows

`gh workflow disable` was run against every workflow that publishes, deploys,
belongs to upstream's own organization, or would bill macOS minutes:

```
Deploy T3 Connect relay   PR Vouch                Publish AUR package
Release                   Thread Transfer Report  Web Preview
Desktop macOS Preview     Desktop macOS Preview Publish
```

**Read this before re-enabling any of them.** `Release` carries
`schedule: cron "0 */3 * * *"` and creates nightly tags: re-enabling it starts
tagging this fork every three hours, silently, forever. The two `Desktop macOS
Preview` workflows trigger on pull requests and run on macOS runners, so
re-enabling them bills macOS minutes on every pull request.

The active workflows are `CI`, `PR Size`, `Issue Labels`, `Forward to Cursor
hygiene` (upstream's, on GitHub-hosted runners), `Windows Tests` (manual
dispatch only, on a Blacksmith Windows runner) and `Release desktop build`
(`workflow_call` only: it runs only when a caller does, and both of its callers
are disabled).

Disabling through repository settings rather than by editing or deleting the
workflow files costs nothing at merge time. The price is exactly this
invisibility, which is what this section buys back. List the current state with
`gh workflow list --all --repo mesura-hq/mesura-code`.

## Building the server package without the web client

`node apps/server/scripts/cli.ts build` builds the server package directly,
bypassing the task runner and its web dependency. It fails when
`apps/web/dist/index.html` is absent, because a server package with no bundled
client still installs, starts, and answers its whole API while serving 503 to
every browser and mobile client — and the desktop app hides that, since it ships
its own renderer. Prefer `vp run --filter t3 build`, which builds the web client
first. Pass `--allow-missing-client` for a deliberate server-only bundle.

This paragraph lived in `docs/internals/scripts.md` until upstream deleted that
file in `docs: keep internal guides focused on architecture (#9755)`. It is kept
here because the guard is the fork's, from
`fix(cli): fail the server build when there is no web client to bundle (#47)`,
and because a fork-owned file never conflicts.
