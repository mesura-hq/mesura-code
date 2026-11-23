# Mesura Code Dev and Lab channels

The laptop runs three packaged apps side by side: **Mesura Code** (stable, from `main`),
**Mesura Code Dev** (from `dev`) and **Mesura Code Lab** (one feature branch at a time). Each has
its own profile, home (`~/.mesura-code-channel-dev`, `~/.mesura-code-channel-lab`), window, icon
and backend port (Dev 3783, Lab 3793; Tailscale ports 8783 and 8793). The channel is fixed at
build time; nothing isolates it through `XDG_*` variables (finding F12).

All commands run on vigilia-home from a checkout, with `node scripts/mesura-channel/channel.ts`.

## Machines and overrides

- The laptop is the SSH target `jc@arch-laptop` unless `MESURA_CHANNEL_LAPTOP_TARGET` names
  another. Its home is read over SSH unless `MESURA_CHANNEL_LAPTOP_HOME` sets it, and its MagicDNS
  name comes from its `tailscale status` unless `MESURA_CHANNEL_LAPTOP_TAILNET_NAME` sets it.
  A witness on vigilia points these at a local SSH target and a scratch home.
- Builds use their own worktree, `/opt/dev/deploy/mesura-code-channels`, never the stable deploy
  worktree. Build state is in `~/.local/state/mesura-channel/` (`<channel>-latest.json`, the build
  log, the last failure); AppImages are in `~/builds/mesura-channel-<channel>/`.
- No command writes to a stable home: `~/.mesura-code` on vigilia, or
  `~/.local/state/mesura-sync-v046-test` on the laptop.

## Build

```bash
node scripts/mesura-channel/channel.ts build --channel dev --rev dev
node scripts/mesura-channel/channel.ts build --channel lab --rev <branch-or-sha>
```

The build runs as the workload `mesura-workload-mesura-channel-build` (6G), under
`flock /tmp/mesura-channel-build.lock`, so two builds never overlap. It fetches `origin`, checks out
`origin/<rev>` (or `<rev>`), uses the revision's `.nvmrc` Node, runs `pnpm install
--frozen-lockfile`, checks the extracted and the packed Electron versions, and prints the AppImage
path and sha256. The command follows the build log until the workload ends. Each run packages into
its own directory, so a failed build keeps the last good artifact and its record.

## Stage

```bash
node scripts/mesura-channel/channel.ts stage --channel dev
```

Copies the newest build of that channel to `~/Applications/Mesura-Code-<Channel>.next.AppImage`
on the laptop, checks its sha256 there, and writes the launcher `~/.local/bin/mesura-code-<channel>`.
The copy lands under a temporary name and becomes `.next` only after its hash matches.

The launcher activates a staged build at the next cold start: it renames the current AppImage to
`.prev` and `.next` to current. While the app runs, the launcher hands its arguments to the running
instance and swaps nothing. It logs to `~/.local/state/mesura-code-<channel>/launch.log`.

The launcher, `stage` and the Lab reset share the lock `~/.local/state/mesura-code-<channel>/channel.lock`,
so no start can take `.next` or open Lab while a build is published or Lab's database is rebuilt.
A starting app keeps the lock until the AppImage runtime has started it, when the reset can see it
and quit it, for 60 seconds at most.
The launcher also drops an inherited `T3CODE_HOME` and `T3CODE_PORT`, so a channel never opens
another channel's home, and sets `T3CODE_DESKTOP_LAUNCHER_PATH` to itself, so the menu entry the
app writes starts the launcher and a menu start activates a staged build.

## Put a branch in Lab

```bash
node scripts/mesura-channel/channel.ts lab --rev <branch>
```

Builds and stages Lab, then on the laptop, under the channel lock: quits a running Lab (the main
process started from exactly `~/Applications/Mesura-Code-Lab.AppImage`; any other Lab stops the
reset), backs up Lab's `statev2.sqlite` to
`~/.local/state/mesura-code-lab/statev2-before-reset-<time>.sqlite`, removes Lab's worktrees, deletes
`state.sqlite*` and `statev2.sqlite*`, creates the fresh database with the new build's CLI, copies
back the rows of `auth_sessions`, `auth_pairing_links`, `mesura_mcp_refresh_tokens` and
`peer_environment_links` over the columns both schemas share. It then releases the lock and
relaunches Lab through Hyprland. Until the relaunch succeeds, `reset-pending.json` names the
backup, and a retried `lab` restores the sign-ins from that backup instead of taking a new one.
Lab's threads are gone; `environment-id`, `secrets/`, `settings.json` and `keybindings.json` stay,
so every client that had Lab still signs in.

## Connect every client to every server

```bash
node scripts/mesura-channel/channel.ts connect --pairing-urls ~/pairing-links   # mode 0600
node scripts/mesura-channel/channel.ts connect --pairing-urls - < ~/pairing-links
```

Each app that lacks an environment gets a one-time `t3code://pair` link through its own launcher
and asks `Add the backend at <origin>?` once. Dev and Lab links are minted with their own bundled
CLI. The stable laptop server and vigilia are not opened by the script, because both `t3 pair` and
`t3 auth pairing create` write the server's database directly. Make their links with **Create
link** in that server's Settings and put one per app that needs it in the links file, one line each:
`stable=<url>` or `vigilia=<url>`. The links stay out of the command line and shell history; the file
must be yours with mode 0600, or come through stdin.

The stable app is never started by `connect`: each hand-off to it checks, in the same step, that
it is running, and when it is not, its pairings are listed as pending. A missing launcher or AppImage for Dev or Lab is reported before any link is minted. The
command lists everything still missing.

For the phone it prints `https://<laptop tailnet name>:8783/pair#token=…` (Dev) and `:8793` (Lab),
but only when that Tailscale route reaches the channel. A fresh channel has the route off: turn on
**Settings > Connections > Tailscale HTTPS** in Mesura Code Dev or Lab and run `connect` again.

Links minted by the script last one hour. Links from **Create link** last five minutes. A desktop
link is passed as an argument to the app's launcher, so the token is visible to that user's
processes for the length of the launch.

## Rollback

On the laptop, quit the channel's app, then:

```bash
mv ~/Applications/Mesura-Code-Dev.AppImage.prev ~/Applications/Mesura-Code-Dev.AppImage
```

Start it again with `~/.local/bin/mesura-code-dev`. Remove a staged build that should not activate
with `rm ~/Applications/Mesura-Code-Dev.next.AppImage`. For Lab, the database before the last reset
is the newest `~/.local/state/mesura-code-lab/statev2-before-reset-<time>.sqlite`; restore it only
together with the `.prev` image it belongs to.
