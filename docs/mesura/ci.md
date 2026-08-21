# CI on this fork

This fork's CI runs on hardware the operator owns, and two of the three things
that make it work are **not visible in `.github/workflows/`**. Both are GitHub
repository settings, which is why they are written down here: the code cannot
tell you about them, and a reader who does not know them will draw the wrong
conclusion from what the code does say.

## The runners

Two self-hosted runners on `vigilia-home`, the operator's home server. They run
as the user `ci`, which has no sudo, and they carry these labels:

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
