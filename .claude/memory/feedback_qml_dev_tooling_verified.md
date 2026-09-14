---
name: feedback_qml_dev_tooling_verified
description: "QML dev tooling is already fully set up & verified — don't re-investigate; Qt's AI Assistant is Qt-Creator-only"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4e08950a-d890-400a-9fb5-3dcbd6574dce
---

Verified 2026-06-07: the QML dev tooling for this project is already complete and
working — no setup needed.

- **LSP**: `qmlls6` (Qt 6.11) is on PATH and configured in the user's Neovim
  (`~/.dotfiles/.config/nvim/lua/jc/plugins/lsp/lspconfig.lua`, native
  `vim.lsp.config`); it attaches to `.qml` buffers (verified headless →
  `LSP_CLIENTS=[qmlls]`).
- **C++ type completion works**: the installed Models module ships
  `symmetria-filemanager-models.qmltypes`, so qmlls resolves `FileSystemModel` etc.
- **Lint**: qmllint + the curated project `.qmllint.ini`, also wrapped by
  `tools/quality/check-qml.sh` (the quality gate).

**Don't chase these dead ends if "QML AI tooling / dev speed" comes up again:**
- **Qt's "AI Assistant" is a Qt Creator plugin** — useless in this Neovim workflow.
- A local QML-tuned model (Qt's CodeLlama-13B-QML) is **redundant with Claude Code**
  and heavy; not worth installing.
- A project `.qmlls.ini` adds nothing here — its schema can't pin import paths
  (defaults already resolve `/usr/lib/qt6/qml`), and cmake-calls aren't triggered
  for the `qml/` tree.

The real dev-speed layer is qmlls + qmllint + Claude Code + the detailed CLAUDE.md.
