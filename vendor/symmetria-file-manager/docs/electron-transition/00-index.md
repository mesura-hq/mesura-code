# Electron transition — research dossier

Status: **research phase**. Nothing here is a decision yet. These documents map what
exists so the architecture discussion can start from facts.

## The three repositories

| Repository | Path | Stack | Role in this transition |
|---|---|---|---|
| Symmetria File Manager | `/home/jc/projects/symmetria-file-manager` | Qt6 / QML / C++ / Rust (`fff`) | The source of truth for features. Ports to Electron. |
| Symmetria IDE | `/home/jc/projects/symmetria-ide` | PySide6 / QML / Python | Prior art: it embeds the file-manager panel and owns a git-status UI. Also holds the recorded Qt→Electron migration plan. |
| Mesura Code | `/home/jc/projects/mesura-code` | Electron / TypeScript / Effect-TS / React, pnpm monorepo, fork of `pingdotgg/t3code` | The destination host. |

## The two goals, in order

1. **Goal one — a standalone Electron file manager** that matches the current Qt one:
   a resident process, windows that appear instantly, Miller columns and a file tree,
   the full preview set, and the `fff` fuzzy finder.
2. **Goal two — fold it into Mesura Code**, replacing that product's file tree and
   file explorer, and adding our own git status.

## Documents

| # | Document | Scope |
|---|---|---|
| 01 | `01-navigation-and-keyboard.md` | View modes, navigation, the complete keybinding and chord tables, dispatch precedence, selection, search, sorting, tabs |
| 02 | `02-previews.md` | The preview routing tree and every preview type, with its library, limits, cache and web equivalent |
| 03 | `03-file-operations-and-daemon.md` | File operations, clipboard, the daemon and its IPC protocol, the CLI, picker mode, the XDG portal |
| 04 | `04-fuzzy-finder-module.md` | The `fff` Rust engine, its C ABI, and the options for extracting it as a reusable module |
| 05 | `05-design-system.md` | Every theme token, the transparency and claymorphism model, components, the shared `color-scheme.json` contract |
| 06 | `06-ide-embedding-and-git-status.md` | How Symmetria IDE embeds the panel, its git-status implementation, and the recorded Qt→Electron migration plan |
| 07 | `07-mesura-electron-architecture.md` | Mesura Code's process model, IPC layer, window management, renderer stack, Effect-TS conventions, native-code pipeline |
| 08 | `08-mesura-file-and-git-surfaces.md` | Mesura Code's existing file, preview, diff and git UI, and the replace / extend / coexist analysis |
| 09 | `09-node-backend-capability-map.md` | Every C++ capability mapped to a Node or Rust option, with risk ratings and a native-module budget |
| 10 | `10-electron-daemon-and-windows.md` | The resident-daemon and instant-window architecture, Wayland and Hyprland specifics, memory honesty |
| 11 | `11-fm-git-status.md` | The file manager's git pieces: the ignore filter, the unwired badge, and the absence of a status pipeline |
| 12 | `12-synthesis.md` | **Start here.** The consolidated picture, the defects found, the architecture the evidence points to, the open decisions, and the order of attack |
| 13 | `13-syntax-highlighting.md` | Benchmarks run on this machine. **Overrides report 09's `shiki` choice** for the preview pane |
| 14 | `14-image-decoding-and-thumbnails.md` | Chromium's real format list, the `sharp` Electron blocker, HEIC, RAW, ICNS, and the XDG thumbnail cache. **Overrides report 09's image section** |
| 15 | `15-decisions.md` | **The decision log. This file is the authority** — where it contradicts a report, it wins |
| 16 | `16-icons.md` | Mesura Code's icon system and how a separate repository adopts it |
| 17 | `17-search-grep-palette.md` | The two file-search interfaces compared, content search, and the command palette |
| 18 | `18-spike-results.md` | **Measured on this machine.** Settles the `fff` frecency question, downgrades the `sharp` blocker, and proves content search |

Also at the repository root: **`docs/vision.md`** — what the file manager is for
and what it refuses to be.

## Reading order

Read **12** first — it is the summary and it cites the rest. Then 07 to learn the
destination, 01 and 02 for the size of the feature debt, and 09 and 10 for the
two hardest engineering questions.
