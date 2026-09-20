---
name: Always clear QML cache after edits
description: After modifying any QML file, always run rm -rf ~/.cache/quickshell/qmlcache before informing the user
type: feedback
---

Always clear the QML cache yourself after editing QML files — don't just tell the user to do it.

**Why:** The user expects this as part of the standard workflow. Leaving it to them is an unnecessary extra step.

**How to apply:** After any Edit/Write to a `.qml` file, run `rm -rf ~/.cache/quickshell/qmlcache` via Bash before wrapping up. Still remind the user they need to restart the shell manually (never restart it autonomously).
