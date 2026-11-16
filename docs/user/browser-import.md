# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Browser → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox, Zen, and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Import into the server browser

When the connected environment runs a server browser, the import wizard also lists that
environment's profiles under **Into**, marked **Server browser on** the environment's name. Pick
one to give agents' browser tabs your logins. The desktop app reads the cookies from the source
browser and sends them to the server, so the source browser still has to be closed. The result
shows how many cookies were imported and which sites were skipped.

Some sites, Supabase-based apps among them, keep their login in local storage instead of
cookies. An import cannot carry that over: sign in to those sites once in the server browser.

## Payment sites

**Settings → Integrations → Payment sites** lists domains, one per line, that are never imported
and that agents cannot open. A domain also covers its subdomains. The list starts with common
payment wallets; add a site to protect it, or remove one to allow it. An agent's navigation to one
of these sites is blocked, and the agent has to ask you to continue.
