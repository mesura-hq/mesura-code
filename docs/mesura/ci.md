# CI on this fork

This fork's CI runs on hardware the operator owns, and two of the three things
that make it work are **not visible in `.github/workflows/`**. Both are GitHub
repository settings, which is why they are written down here: the code cannot
tell you about them, and a reader who does not know them will draw the wrong
conclusion from what the code does say.

## The runners

Two self-hosted runners on `vigilia-home`, the operator's home server. **The box
runs Arch Linux**, which the labels below deny and which matters more than it
looks — see "The labels stop at the operating system". They run as the user
`ci`, which has no sudo, and they carry these labels:

```
blacksmith-8vcpu-ubuntu-2404
blacksmith-4vcpu-ubuntu-2404
blacksmith-2vcpu-ubuntu-2404
```

**Those labels are deliberate and they are a lie about the hardware.** Upstream
contracts [Blacksmith](https://blacksmith.sh) for the `pingdotgg` organization,
so every `runs-on:` in the workflows names a Blacksmith runner. Blacksmith is
unavailable here for a reason no amount of money fixes: it is limited to GitHub
organizations, and this repository belongs to a user account.

GitHub treats any non-reserved `runs-on:` label as a self-hosted runner label.
Naming our own runners after Blacksmith's therefore makes every job run **with
zero changes to any workflow file** — which is the fork's first principle
(`AGENTS.md`, "Upstream keeps moving, and we keep pulling") applied to CI. The
alternative, rewriting seven `runs-on:` lines, would conflict on every sync that
touches `ci.yml`; upstream touched it twice in the 29 commits of the first sync
alone.

Consequence to expect: if the repository is ever moved into an organization,
installing Blacksmith's GitHub App migrates every job with no edit at all,
because the labels already match.

### Resource isolation

The runners are members of `ci.slice`, a systemd slice that carries ONE budget
for all CI on the box — present and future, this project and any other. The
reasoning, and why `AllowedCPUs` rather than `CPUQuota`, is in the slice unit
itself at `/etc/systemd/system/ci.slice` on `vigilia-home`.

Each runner also has its own `HOME`. That is not tidiness: both execute as the
same user, so they shared `~/.vite-plus` and the pnpm store, and `Setup Vite+`
failed four attempts in ten seconds the first time two jobs installed
concurrently. The same installer succeeds when run alone. **Isolating CPU and
memory is not enough; the filesystem needs isolating too.**

## Ten workflows are disabled, and only GitHub knows

`gh workflow disable` was run against every workflow that publishes, deploys, or
belongs to upstream's own organization:

```
Deploy T3 Connect relay      Mobile EAS Preview       Mobile EAS Production
Mobile Showcase Screenshots  Mobile Fingerprint Check Publish AUR package
Release                      Web Preview              PR Vouch
Thread Transfer Report
```

Only `CI`, `PR Size` and `Issue Labels` remain active.

**Read this before re-enabling any of them.** While no runner existed these
workflows were harmless, because nothing executed them. Turning on a runner made
every one of them real at once, and the queue that had accumulated since the fork
detached contained three `Release` runs, a `Deploy T3 Connect relay`, and a
`Mobile EAS Production`. `Release` carries `schedule: cron "0 */3 * * *"` and
creates nightly tags: re-enabling it starts tagging this fork every three hours,
silently, forever.

Disabling through repository settings rather than by editing or deleting the
workflow files is the same trade the runner labels make — it costs nothing at
merge time. The price is exactly this invisibility, which is what this section
buys back.

## The labels stop at the operating system

The label trick above works because a `runs-on:` label is just a string. It
keeps working only while the workflow steps stay indifferent to the operating
system underneath, and v0.0.42 is where upstream stopped being indifferent.

Upstream `#7261` made the desktop resolve Chromium cookie keys on Linux, which
needs `libsecret`. So `ci.yml` gained a step that runs `sudo apt-get install -y
libsecret-1-dev pkg-config`, preceded by `./.github/actions/setup-apt-mirrors`,
which writes an Ubuntu mirror list into `/etc/apt`. On `vigilia-home` there is no
`apt-get` and no `/etc/apt`, so both fail.

**The first reading of the failure is wrong and costs real time.** The log says:

```
sudo: a terminal is required to read the password
sudo: a password is required
```

which reads as a missing sudoers entry for `ci`. Granting it fixes nothing. The
very next command writes to a directory Arch does not have, and `apt-get` is not
installed either. The sudo message is simply the first of three obstacles, and
it is the only one that looks like a configuration mistake.

Nothing is actually missing. `libsecret` 0.21.7 and `pkgconf` are installed on
the host, and `pkg-config --exists libsecret-1` succeeds, so the step is pure
overhead here rather than a dependency this fork lacks.

### This is the first exception to "never edit a workflow file"

Every other CI problem on this fork was solved outside `.github/` — labels for
the runners, repository settings for the ten disabled workflows. This one cannot
be. The only fix that needs no workflow edit is to put no-op `sudo` and
`apt-get` shims on the runner's PATH, which would disarm every future privileged
step in every workflow and turn a genuinely missing dependency into a pass.

So the guard lives in the workflow, in the cheapest shape available:

- `.github/actions/setup-apt-mirrors/action.yml` exits early when `apt-get` is
  absent and writes `APT_MIRRORS_CONFIGURED=0` to `$GITHUB_ENV`. That file has
  taken **one** upstream commit ever, the one that created it.
- The two `Install browser secret helper build libraries` steps in `ci.yml` carry
  `if: env.APT_MIRRORS_CONFIGURED != '0'`. One line each, in the file upstream
  moves most — 15 commits in three months.

The condition is written `!= '0'` rather than `== '1'` on purpose: if the action
never runs, the variable is unset and the install still goes ahead. The guard
fails toward doing the work, which is the behaviour upstream expects everywhere
else.

Three other workflows use the same action — `release.yml`, `release-desktop.yml`
and `desktop-macos-preview.yml`. They are left alone because they are disabled,
so nothing executes them. **Re-enabling any of them means applying the same
`if:` to their install steps**, or they will fail exactly the way `Check` and
`Test` did.

## The macOS job will hang if it ever fires

`Mobile Native Static Analysis` requests `blacksmith-6vcpu-macos-26`. There is no
macOS runner here and there will not be one, so the job cannot be served.

It normally skips, because its gate resolves to `'false'` when no native mobile
sources changed. Note the gate's actual shape:

```yaml
if: ${{ !cancelled() && needs.mobile_native_changes.outputs.changed != 'false' }}
```

It skips only on an explicit `'false'`. Upstream wrote it that way on purpose —
their comment says a gate job that failed or errored leaves the output empty, and
that must run the lint rather than silently skip it. **On this fork that
fail-safe inverts into a hang**: the job fires, finds no runner, and queues until
GitHub eventually cancels it.

It is left alone deliberately. Mac is not a surface this fork is used on (see
`AGENTS.md`, "Surfaces, and which two matter here"), so the fix — a line inside
`ci.yml` — would buy a rare, self-limiting annoyance in exchange for a recurring
merge conflict in the file upstream moves most.

## Verifying the runners

From a machine on the same LAN or tailnet:

```sh
gh api repos/CaceresCallieri/mesura-code/actions/runners \
  -q '.runners[] | "\(.name) \(.status) busy=\(.busy)"'

ssh dev@vigilia-home 'systemctl status ci.slice'
```

A job stuck in `queued` with no runner `busy` means no runner is online. A job
stuck in `queued` while runners are idle means its `runs-on:` label matches
nothing here — the macOS job is the only one in that state by design.

## Each runner has its own TMPDIR, and that is load-bearing

`vigilia-home` is a shared box. The operator's own work and other agents run
there as `dev`, and several of those leave a `node_modules` directory under
`/tmp` — a Vitest cache writes `node_modules/.vite/vitest/` relative to whatever
root it is given, so a run with a `/tmp` cwd creates `/tmp/node_modules`.

That breaks the desktop artifact test. `scripts/build-desktop-artifact.ts`
probes the packaged bundle for self-containment and refuses to report success
when a `node_modules` is visible from the probe directory, because a bare import
could then resolve outside the packaged tree. The probe is right to refuse. The
failure reads as a bundling defect and is not one:

```
Refusing to report success: /tmp/node_modules is visible from the probe
directory, so bare imports could resolve outside the packaged tree.
```

So each runner gets a private temporary directory, set in the runner's own
`.env` rather than in a workflow:

```
/home/ci/actions-runner/.env     TMPDIR=/home/ci/tmp-r1
/home/ci/actions-runner-2/.env   TMPDIR=/home/ci/tmp-r2
```

Both directories are `0700` and owned by `ci`. The runner applies `.env` to job
processes, not to its own listener, so `TMPDIR` is absent from the listener's
`/proc/<pid>/environ` and that is not a fault — a job is what proves it.

**Set it here rather than in a workflow on purpose.** A workflow change is a line
inside a file upstream owns, which is a merge conflict every week forever. The
runner's `.env` is ours alone and costs the repository nothing. Deleting
`/tmp/node_modules` by hand is not a fix either: the box keeps making new ones.

Changing `.env` needs a runner restart, and a restart during a job kills that
job. Check `busy=false` on both runners first, with the `gh api` command above.

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
