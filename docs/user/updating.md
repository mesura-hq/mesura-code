# Updating Mesura Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

Mesura Code publishes no npm package or release archive. Install a matching
Mesura Code build on the host. The `t3` package on npm and T3 Code release
downloads belong to upstream T3 Code; they do not update this fork.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
Mesura Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3 Code versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  the server on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

For a Mesura Code host that asks you to install a matching build:

1. Identify the host and client version shown in the notice.
2. Stop the server on that host when you are ready to interrupt its active work.
   For a desktop-hosted server, close the desktop app there.
3. Build and install the matching Mesura Code version on that host. A
   desktop-hosted server needs the matching desktop build. A background service
   needs the matching server build at the location its launcher uses.
4. Restart the desktop app or background service. For a server you start by
   hand, relaunch it with your usual subcommand and options.
5. Reconnect the client. Reload the browser page to load the updated web app.

An **Update the desktop app** instruction also refers to the host's desktop app,
not the device from which you connected. Install the matching desktop build
there, then reopen it.

Some installations have a configured update source and offer **Update server**.
Use that action only when the installation provides a Mesura Code update source.
Keep the client open while it updates and reconnects. For a desktop-hosted
server, this can close and relaunch the desktop app on the host.

After selecting **Update**, the notice becomes a live status line: **Downloading…** while the new
version is fetched and verified, then **Restarting…** while the server restarts into it. The same
status appears in the conversation and in Connections, so navigating between them does not lose the
update. A failure remains visible with its error and an option to retry.

Mesura Code does not update connected servers silently in the background.

## Upstream T3 Code command-line updates

These commands apply to upstream T3 Code installations. They install upstream
T3 Code, not Mesura Code. Use the procedure above for this fork.

For an upstream release installed through its CLI installer, run the matching
version's update command on the host:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

For an upstream global npm installation, **Copy update command** gives the
command for that installation's prefix. Run it on the named host, then restart
the server with your usual options. For a default global npm installation:

```sh
npm install --global t3@<client-version>
```

For an upstream server launched with `npx`, there is no global installation to
update. Stop the server and relaunch it with the same subcommand and options:

```sh
npx t3@<client-version>
```

**Copy relaunch command** does not update an installed `t3` command.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. Install a matching Mesura Code build on that machine, then restart the server
   and reconnect.

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, Mesura Code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest Mesura Code model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Updates from a phone

Open Mesura Code in the browser on your phone. Use the same
**Settings → Connections** and **Settings → Providers** pages as on a desktop
browser. These controls require a connection and permission to operate the
environment. If the host cannot update remotely, install the matching build on
that host with the procedure above.

After the host restarts, reconnect and reload the browser page. This fork has no
native mobile app to update through the App Store or Google Play.
