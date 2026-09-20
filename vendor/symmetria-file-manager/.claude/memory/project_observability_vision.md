---
name: Observability system vision
description: Long-term plan for project-wide structured logging and automated monitoring across all Symmetria components
type: project
---

User envisions a comprehensive observability system for the Symmetria umbrella project (shell + file manager + future components).

**Why:** Currently no way to see what happens inside QML at runtime. Debugging requires blind guessing. The user wants structured logs that agents can analyze autonomously (e.g., daily review for unreported bugs, performance issues, non-optimal behavior).

**How to apply:** Any new feature should integrate with the logging service. Log warnings/errors at system boundaries. Design the logging singleton to be reusable across Symmetria components, not just the file manager. Future work: automated agent review of logs on a schedule.
