# Account limits

Mesura Code can show the current subscription limits reported by Claude, Codex, the OpenCode Go
plan and the Z.ai GLM Coding Plan.

Hover over the **Usage** button in the sidebar footer to open the limits panel. You can also hold
`Alt+U`. Release the shortcut to close the panel, or press `Escape`. Selecting the Usage button
still opens the Usage analytics page.

The panel opens inside the sidebar itself, above the footer buttons, and pushes the thread list up
while it is open. It is available on the thread list only. The Settings, Usage and Pull requests
pages show a **Back** button in that footer instead, and the panel does not open there.

The panel shows one row for each subscription, not one for each machine. When two environments drive
the same account, their readings become one row, and every window shows the newest of the two. Two
different accounts stay on separate rows, and a row then names the account it belongs to.

Each row shows the reported rolling windows, percentage used, reset countdown, reading age, and
refresh state. Mesura Code updates the readings in the background. A failed refresh keeps the last
valid reading visible, and it does not hide a good reading another machine took of the same account.

Environments read a subscription on their own clock, so the same account can be a few minutes newer
on one machine than on another. The reading age above each row tells you how old its newest number
is.

A provider that is not installed on an environment does not get a row there.

The panel does not show the Codex Spark meter in this first version. Mesura Code still retains that
meter in its account-limit data.

You can change the `usage.peek` shortcut in **Settings** → **Keybindings**. The panel is available in
the desktop and web sidebar. It is not available in the mobile client.
