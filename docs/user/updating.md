# Updating T3 Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Stop the command-line server on its host and relaunch with the copied command, keeping your usual startup options.                                                                              |

The update does not remove saved threads, settings, or project files.

## Choose the Action You See

| Action                       | What to do                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**            | Available for the Mesura Code Linux background service. Select the button and leave Mesura Code open while it prepares, tests, restarts, and reconnects. |
| **Update the desktop app**   | Open the Mesura Code desktop app on the machine that runs the server and install the app update there. Reopen it if needed.                              |
| **Install a matching build** | Install a matching Mesura Code build on that machine, then restart the server there with any startup options you normally use.                           |

The available action depends on how that server was started. Mesura Code does not update connected
servers silently in the background.

An older background-service launcher may ask you to update the service on the server machine first.
That one local update installs the rollback support needed for later remote updates, including
versions that change the database.

After selecting **Update**, the notice becomes a live status line: **Downloading…** while the new
version is fetched and verified, then **Restarting…** while the server restarts into it. The same
status appears in the conversation and in Connections, so navigating between them does not lose the
update. A failure remains visible with its error and an option to retry.

Mesura Code publishes no npm package, so there is no update command to copy and no **Copy update
command** button. Where upstream offered one, the app now says: install a matching Mesura Code build
on that machine. Build and install the fork by hand on the server machine, then relaunch the server
there with whatever startup options you normally use.

The same applies when the server runs as the Mesura Code background service: install the matching build
on the host, then restart the service.

For a background service, run the matching version's CLI on the host:

```sh
npx t3@<client-version> service update
```

Replace `<client-version>` with the version shown in the notice. Using
`@latest` only resolves the mismatch if your client is on that release. An older
service launcher may require this local update before it supports remote updates
and rollback.

For a foreground server, the copied command is `npx t3@<client-version>`. Add
`serve` if you normally run without a browser, and preserve options such as
`--host` or `--tailscale-serve`. See
[background services](./background-service.md) for service management.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. For a command-line server, install a matching Mesura Code build on that machine — matching the
   client version shown in the warning — and relaunch the server there.

4. Check that you updated the server's machine, not only the device you are using.
5. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Mobile updates

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
