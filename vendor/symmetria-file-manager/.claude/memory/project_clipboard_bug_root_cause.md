---
name: project-clipboard-bug-root-cause
description: "Root cause of the intermittent \"cc copies but paste fails\" clipboard bug — wl-copy fork dies with the symmetria-fm cgroup"
metadata: 
  node_type: memory
  type: project
  originSessionId: ed63e23c-2eda-447e-8869-12f6a1a73a55
---

**Diagnosed 2026-06-09.** The c-chord copy (`cc`/`cd`/`cf`/`cn`) always succeeds — diagnostic logs (`[FileList.cc]`, commit 8cadaa2) show zero DROPs and clean wl-copy exits. The failure is downstream: on Wayland the clipboard has no central store; `wl-copy` forks a child that must stay alive to *serve* paste requests. That child lives inside the `symmetria-fm.service` cgroup. The host deliberately quits when the last FM window closes (`host/standalone/main.cpp`, quitOnLastWindowClosed=true + Restart=always — a documented design decision, do not change it), and systemd's default `KillMode=control-group` then kills everything in the cgroup, including the wl-copy holder.

So the repro is: copy a path in the FM → close the FM window → paste fails. Symmetria Shell's clipboard manager still shows the entry because it captured the content immediately via the data-control watch; selecting it there re-serves it from the shell's process, which is why that workaround works.

Confirmed instance: 20:27:15 `cd` copied `/home/jc/projects/orchestrator.nvim`; 20:27:16 service exited (window closed); systemd restart killed the wl-copy.

**Fix direction (pending user decision):** detach wl-copy from the service cgroup, e.g. spawn via `systemd-run --user --collect` (preferred, surgical) or set `KillMode=process` on the unit (one-line, less surgical). Once fixed, remove the DIAGNOSTIC logging in ChordHandler.js / FileList.qml.
