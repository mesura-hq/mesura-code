---
name: feedback_autonomous_restart_consent
description: "For the keybinding-registry work, the user granted full autonomy incl. restarting symmetria-fm"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 28b99fad-3d22-499b-89f4-839b9494e3c6
---

During the keybinding-registry refactor (the `?` help popup + KeyRegistry migration, see [[project_keybinding_registry]]), the user explicitly said: "Go ahead completely autonomously. I don't want you to stop and I give you full permission to do the restart. Go in one pass and try not to stop."

**Why:** The default project rule is "Do NOT kill the symmetria-fm service without the user's consent" (CLAUDE.md) and "NEVER restart autonomously" applies to the QuickShell *shell*. The user lifted that for symmetria-fm for this multi-phase task specifically.

**How to apply:** For this task, restart `symmetria-fm` and run the full multi-phase plan without pausing for checkpoints. This consent is task-scoped — it does NOT extend to restarting the Symmetria Shell (quickshell) or to future unrelated tasks; re-confirm for those.
