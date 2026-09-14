---
name: feedback_ui_module_deploy_for_qmllint
description: New components in Symmetria.FileManager.UI must be deployed to /usr/lib before qmllint/the quality gate can resolve them
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4e08950a-d890-400a-9fb5-3dcbd6574dce
---

When you ADD a new component (or singleton) to the `Symmetria.FileManager.UI`
module and reference it from another QML file, the quality gate (`qmllint` via
`tools/quality/check-qml.sh`) will FAIL with misleading errors on the *consumer*
like `unknown grouped property scope anchors` / `Type anchors is used but it is
not resolved` — even though your new component is fine.

**Why:** there are two independent QML load paths.
- The FM's **own runtime** loads the panel from the **source tree** — the host
  binary bakes `SYMMETRIA_FM_PANEL_PATH = <project>/qml` (see
  `host/standalone/CMakeLists.txt`). So a QML edit needs only a service restart,
  never a reinstall, for the FM itself to pick it up.
- The **deployed copy** at `/usr/lib/qt6/qml/Symmetria/FileManager/UI/` is a
  `cmake install(DIRECTORY)` snapshot (`plugin/CMakeLists.txt`, copies
  `qmldir`/`*.qml`/`*.js`). It exists so EXTERNAL importers (Symmetria Shell,
  the IDE) — and **`qmllint`** (`.qmllint.ini` sets
  `AdditionalQmlImportPaths=/usr/lib/qt6/qml`) — can resolve
  `import Symmetria.FileManager.UI`.

`qmllint` resolves the module from `/usr/lib`, so until you redeploy, it can't
see the new component → the consumer's `PillSurface {}` (etc.) is an unresolved
type and its `anchors` "don't resolve."

**How to apply:** after adding a new UI component + its `qmldir` line, redeploy
the snapshot before running the gate:

```bash
sudo cmake --install plugin/build   # configured build dir already exists; no C++ rebuild, no service restart
```

Then re-run `tools/quality/check-qml.sh <files>`. (`build-plugin.sh` also works
but recompiles the C++ plugin unnecessarily for a QML-only change.) Editing an
*existing* already-deployed component doesn't need this — only adding a new file
the deployed `qmldir` doesn't list yet. Note the install copies the whole source
UI dir, so any dirty WIP `.qml`/`.js` get snapshotted too (a file copy, not a
git commit). See [[feedback_qml_dev_tooling_verified]].
