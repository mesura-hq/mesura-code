---
name: Smart service restart after QML changes
description: Check for open file manager windows before restarting symmetria-fm service; only auto-restart if no windows are open
type: feedback
---

After making QML changes to the file manager, check if any file manager windows are currently open before restarting the service.

- If **no windows are open**: restart the service automatically (`systemctl --user restart symmetria-fm`)
- If **windows are open**: tell the user they need to restart and provide the command, don't restart automatically

**Why:** Restarting the service kills all open FloatingWindow instances, losing navigation state and in-progress work. The user wants convenience but not at the cost of losing open windows.

**How to apply:** After finishing QML edits, run `qs ipc -c symmetria-fm call filemanager listWindows` or check the process list for open windows. Then decide whether to auto-restart or just inform the user.
