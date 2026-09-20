---
name: project_framework_evaluation
description: "RESOLVED 2026-06-07: stay on native Qt6/QML. Tauri pivot abandoned; Slint evaluated via measured POC and declined; Zed/GPUI ruled out."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4e08950a-d890-400a-9fb5-3dcbd6574dce
---

## ✅ DECISION (2026-06-07): STAY ON QML
After research + a *measured* Slint POC on the real Arch+Hyprland machine, the user
decided to **keep the existing mature native Qt6/QML file manager**. In a live side-by-side
**QML felt slightly smoother than Slint**, AND the QML FM is already **feature-complete** —
migrating would re-implement months of working code for, at best, parity. The Tauri 2
(React/WebKitGTK) pivot is **abandoned** (`app-tauri/` archived). Slint was a strong
candidate (light ~51 MiB PSS, embeddable, no GPUI Hyprland defect) but not enough better to
justify a rewrite; Zed/GPUI ruled out earlier. **Forward path: continue QML; address the
original LLM-dev-speed gripe with Qt's QML AI tooling, not a framework change. The IDE embed
story stays intact (already designed to embed Symmetria.FileManager.UI QML).** The evaluation
record that led here follows.

---

As of 2026-06-07 the user is **reconsidering the Tauri 2 (web/WebKitGTK) pivot** —
judges the web-abstraction cost too high (WebKitGTK scroll/animation noticeably
worse than the native QML FM). Wants to return to **tight native code**, ranked:
**performance + RAM first**, aesthetics second, LLM-codegen reliability a "nice to
have." HARD constraint: the FM UI must **embed as a panel inside the Symmetria IDE**.
Acceptable languages: Rust (preferred), C++ (could reuse the existing C++
FileSystemModel), or GC langs (C#/Dart/Kotlin) if the win is large. See [[project_tauri_pivot]].

**Deep-research pass #1 (Zed/GPUI), verified findings — current as of June 2026, area moves fast:**
- **GPUI** = Rust, GPU **shader-per-primitive, no scene graph**, 120 FPS *target*.
  Architecturally faster model than Qt's scene graph. Official standalone crate on
  crates.io (v0.2.2), **Apache-2.0** (license-clean standalone). ~47 standalone apps
  + `longbridge/gpui-component` (60+ widgets).
- **Pre-1.0 churn**: README warns of frequent breaking changes; examples break across
  versions → degrades LLM-assisted velocity.
- **Embedding via Zed extension API: NOT possible** — extensions are headless only
  (languages/themes/MCP); custom UI panels are only a Draft RFC the team "won't get to
  soon." ⇒ embedding into Zed **requires forking**.
- **Forking Zed = GPL-3.0 copyleft** on the entire derivative work; cannot relicense
  proprietary. GPUI-alone stays Apache-2.0.
- **DECISION-CRITICAL — Hyprland/Wayland gap on the user's exact platform:** GPUI lacks
  damage tracking + spams display-sync → spikes Hyprland CPU (hello_world ~6.8%, Zed up
  to ~50% Hyprland CPU when visible). Hyprland maintainer confirmed it's a *toolkit*
  issue. Zed 0.202.8 fails to map a window under Hyprland+AMD RADV (works in nested
  Weston). Mitigations partial/in-flux.
- **Refuted:** Blade as Linux backend NOT confirmed (Zed reportedly moved Blade→wgpu);
  specific gpui-component license/release claims did not pass.

**Deep-research pass #2 (Slint + competitors + C++ reuse), verified findings:**
- **Slint embeddability = YES (hard requirement met):** public Rust+C++ platform API
  (WindowAdapter/EventLoopProxy) explicitly designed to embed a Slint UI as a plugin in
  foreign host apps; production proof = WesAudio DAW plugins. Lowest-migration option
  (`.slint` markup ≈ QML).
- **Slint rendering:** GPU-accelerated (Skia OpenGL/Metal/Vulkan/D3D, or FemtoVG/OpenGL,
  or wgpu, or software). Runs on **Wayland out of the box via Winit** — and because it
  uses Winit (not a custom display-sync loop like GPUI), it *may* avoid GPUI's Hyprland
  CPU bug, but there is **NO Hyprland-specific data — must be measured empirically.**
- **Slint licensing = the catch (12 unanimous primary-sourced claims):** tri-license —
  Royalty-free (free, proprietary *desktop* ok, embedded-systems excluded, mandatory
  AboutSlint attribution), GPLv3 (free, copyleft), paid Commercial. The Royalty-free
  text forbids distributing an app that "exposes the APIs… of the Software" and forbids
  standalone Slint distribution → a *reusable/embeddable* panel plausibly trips it,
  pushing to **GPLv3 or paid Commercial**. ⚠️ KEY REFRAME: GPLv3 is only a problem if the
  project must stay PROPRIETARY. If Symmetria is open-source personal tooling, GPLv3 is
  fine — which also defuses the Zed-fork GPL concern.
- **C++ FileSystemModel reuse:** feasible via **KDAB CXX-Qt** (Rust⇄C++ QObject bindings)
  but drags full Qt into the Rust build. Scan/watch logic is modest → **pure-Rust rewrite
  (notify + jwalk) recommended over FFI.**
- **Stay-on-QML counter:** Qt now ships a QML-tuned AI Assistant + gen-AI linter
  ("+11% QML coding with Sonnet 4") — the LLM-dev-speed complaint is partly addressable
  WITHOUT migrating from the mature, working QML FM.
- **Both passes failed to surface measured RAM/startup/Hyprland-CPU numbers for ANY
  framework** → the perf/RAM question the user cares most about is NOT answerable from
  public research; only a measured POC settles it.

**STRATEGIC INSIGHT:** the "embed FM in IDE" requirement means **FM and IDE should share
one toolkit**. So this isn't "pick an FM framework" — it's "pick the toolkit for the whole
Symmetria native stack (IDE + FM)." A Slint FM cannot embed cleanly in a GPUI/Zed-fork IDE.

**LEADING OPTIONS (low-confidence ranking — no measured perf data):**
1. **Slint** (whole stack) — embeddable, QML-like, GPU, likely-OK Hyprland; license = GPLv3
   if open-source else paid.
2. **Stay on Qt/QML** — mature/fast/working; migrate only if a POC proves a real win.
3. Zed-fork/GPUI — encumbered (GPL, Hyprland CPU bug, fork-to-embed). De-prioritized.

**User intent CONFIRMED (2026-06-07): open-source / personal tooling** → GPLv3 is fine;
the Slint "exposes the APIs" free-tier clause and the Zed-fork GPL both stop being blockers.

**Slint POC built + MEASURED on the real Arch+Hyprland machine (2026-06-07)** —
`poc-slint/` (Rust + Slint, `default-features=false` + backend-winit + renderer-femtovg to
force Slint's own GPU path, NOT the Qt backend). Minimal virtualized fixed-20px-row file
list + vim nav, lists a real dir. Results:
- ✅ **Maps a window on Hyprland** — the exact test GPUI/Zed FAILED (#37918). Slint passes.
- ✅ **Hyprland CPU attributable to Slint ≈ 0.40%** (controlled A/B: 11.40% with window →
  kill → 11.00% without; the ~11% baseline was the running QML FM + desktop, NOT Slint).
  GPUI hello_world was ~6.8%. **Slint does NOT have GPUI's damage-tracking defect** (uses
  Winit, commits frames only on change). This was the GPUI dealbreaker — Slint clears it.
- ✅ **Idle app CPU 0.00%.**
- ✅ **RAM: ~51 MiB PSS** (proportional; RSS was 261 MiB but that double-counts shared
  mesa/GL/font libs). Light. (QML full FM for context: 452 MiB RSS — but it's the full app.)
- ⏳ **Scroll FEEL: pending user's real-keyboard test** (synthetic input can't drive the
  surface — Super+7, hold j/k). The window is live on ws7.

POC build gotchas (for reuse): need `use slint::Model;` for `row_count()`; `run.sh` must
`pkill -x poc-slint` (NOT `pkill -f target/release/poc-slint` — that self-kills the caller,
exit 144, same trap as the Tauri workflow). Slint's winit backend leaves the Wayland app_id/
class EMPTY (no Hyprland class-based rule possible without setting it in code).

**RECOMMENDATION (current): Slint is the empirically-validated front-runner** — passes the
two tests that killed GPUI (maps on Hyprland, no compositor CPU spam), light (~51 MiB),
embeddable (research-verified + WesAudio production proof), QML-like markup (lowest migration
from the current QML FM), GPL fine for open-source. Remaining judgment calls: (1) subjective
scroll smoothness (user testing now), (2) whether migrating off the mature working QML FM is
worth it at all vs. just adopting Qt's QML AI tooling. Decision still open pending the feel test.
