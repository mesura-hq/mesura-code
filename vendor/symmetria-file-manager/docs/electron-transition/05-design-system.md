# 05 — Design System

Scope: every visual token and every reusable component of Symmetria File Manager
(Qt6/QML), mapped to CSS for a React/Electron renderer.

Source of truth for tokens: `qml/Symmetria/FileManager/UI/services/FmTheme.qml`.
Read that file before you change any number here.

All paths in this document are absolute or repo-relative to
`/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b`.

---

## 1. The full token table

### 1.1 Palette

`FmTheme.palette` is a plain JavaScript object, not a `QtObject`
(`FmTheme.qml:47-66`). The reason is a QML restriction: QML reserves identifiers
that start with `on` plus an uppercase letter for signal handlers, so `onSurface`
/ `onPrimary` / `onSecondaryContainer` cannot be `QtObject` properties. A
consequence for the port: QML must reassign the whole object to trigger
bindings, and CSS has no such limit.

Every neutral is achromatic on purpose — `r == g == b` on all sixteen neutrals
(commit `1e6bb30 style(theme): make the palette achromatic`). `error` is a real
accent and is deliberately exempt. Do not reintroduce a cool cast.

| Token | Default value | Role |
|---|---|---|
| `surface` | `#0f0f0f` | Base. Also the Miller pane fill and the two bars. |
| `surfaceContainerLowest` | `#0b0b0b` | Deepest well (spreadsheet grid). |
| `surfaceContainerLow` | `#121212` | Panel layer colour, currently multiplied by alpha 0.0. |
| `surfaceContainer` | `#161616` | Quiet control fill (Cancel button, disabled Open). |
| `surfaceContainerHigh` | `#1c1c1c` | Hue/saturation donor for `_mattePill`. |
| `onSurface` | `#d4d4d4` | Primary text. |
| `onSurfaceVariant` | `#a8a8a8` | Secondary text, scrollbar thumb, default icon. |
| `primary` | `#b4b4b4` | Accent text, enabled primary button fill, search tint. |
| `onPrimary` | `#0f0f0f` | Text on `primary` fill. |
| `primaryContainer` | `#3a3a3a` | Container accent. |
| `onPrimaryContainer` | `#e4e4e4` | Text on `primaryContainer`. |
| `outline` | `#6e6e6e` | Disabled/placeholder text, empty-state glyphs. |
| `outlineVariant` | `#2a2a2a` | Inactive tab border, dividers. |
| `secondaryContainer` | `#232323` | Search-match span background, tree current-row fill. |
| `onSecondaryContainer` | `#b4b4b4` | Text on `secondaryContainer`. |
| `surfaceVariant` | `#2a2a2a` | Legacy container step. |
| `error` | `#ffb4ab` | Destructive accent (delete dialog). Chromatic on purpose. |
| `shadow` | `#000000` | Modal scrim base, used at alpha 0.5. |

### 1.2 Derived matte-pill values

`FmTheme.qml:167-187`. See section 3 for the formula. Resolved with the default
palette:

| Token | Resolved value | Where |
|---|---|---|
| `pillMedium.background` | `#131313` (L 0.075) | Active tab fill (`TabBar.qml:70`). |
| `pillStrong.background` | `#171717` (L 0.089) | Current-row highlight (`FileListItem.qml:109`). |
| `pillMedium.border` / `pillStrong.border` | `rgba(255,255,255,0.08)` | Hairline edge on both. |

### 1.3 Overlay tokens

`FmTheme.qml:258-261`.

| Token | Value | Role |
|---|---|---|
| `overlay.subtle` | `rgba(255,255,255,0.06)` | Pane borders, dividers, keycap fill. |
| `overlay.emphasis` | `rgba(255,255,255,0.10)` | Keycap borders, stronger separators. |

There is deliberately **no** `overlay.zebra`. It existed briefly at a third of
`subtle`'s alpha and was retired with the striping. Section 8 explains.

### 1.4 Indicator tokens

`FmTheme.qml:193-197`. Hardcoded on purpose: palette tokens can change with a
scheme file, and these must stay distinguishable.

| Token | Value | Role |
|---|---|---|
| `indicator.cut` | `#e57373` | Left strip on a cut row. |
| `indicator.yank` | `#4caf7d` | Left strip on a yanked row. |
| `indicator.selection` | `#f0c674` | Left strip on a Space-selected row. |

### 1.5 Git status tokens

`FmTheme.qml:219-243`. Operation-based grammar, not index-state. The file
manager exposes the slots; a `statusProvider` decides which slot a status
character maps to.

| Token | Value | Status char |
|---|---|---|
| `gitStatus.addedGreen` | `#98c379` | `A` |
| `gitStatus.modifiedAmber` | `#e0a93a` | `M`, `T` |
| `gitStatus.deletedRed` | `#e06c75` | `D` |
| `gitStatus.untrackedBlue` | `#61afef` | `?` |
| `gitStatus.renamedOrange` | `#d19a66` | `R`, `C` |
| `gitStatus.conflictedMagenta` | `#c678dd` | `U` |
| `gitStatus.ignoredGray` | `#5c6370` | `!` |
| `gitStatus.badgeText` | `#1a1818` | Text on a saturated badge. Warm on purpose, not palette-derived. |
| `gitStatus.addsGreen` | `#7eb777` | Inline `+N` line-delta text. |
| `gitStatus.delsRed` | `#d76060` | Inline `-N` line-delta text. |

### 1.6 Typography

`FmTheme.qml:69-83`. Sizes are **Qt point sizes**, not pixels. At 96 dpi one
point is 4/3 px, so convert with `px = pt * 4 / 3`.

| Token | Value (pt) | Value (px @96dpi) | Usage count in `modules/filemanager` |
|---|---|---|---|
| `font.size.xs` | 8 | 10.67 | 67 |
| `font.size.sm` | 9 | 12 | 37 |
| `font.size.md` | 10 | 13.33 | 14 |
| `font.size.lg` | 11 | 14.67 | 7 |
| `font.size.xl` | 12 | 16 | 2 |
| `font.size.xxl` | 18 | 24 | 4 |

| Family token | Value |
|---|---|
| `font.family.sans` | `Rubik` |
| `font.family.mono` | `CaskaydiaCove NF` |
| `font.family.material` | `Material Symbols Rounded` |

### 1.7 Layout tokens

`FmTheme.qml:91-107`. Values are device-independent pixels.

| Token | Value | Note |
|---|---|---|
| `rounding.sm` | `6` | Tree rows, search tints. |
| `rounding.lg` | `8` | Panes and cards. Came down from 16 with the flat move; mirrors the IDE's `Theme.radius.lg`. |
| `rounding.full` | `1000` | Capsule sentinel — becomes `border-radius: 9999px` in CSS. |
| `spacing.sm` | `3` | |
| `spacing.md` | `6` | |
| `spacing.lg` | `10` | |
| `padding.sm` | `2` | Inter-column gap; exactly half of `padding.md`. |
| `padding.md` | `4` | Window margin and pane content inset. |
| `padding.lg` | `7` | Bar horizontal inset. |

### 1.8 Animation tokens

`FmTheme.qml:110-112`.

| Token | Value | CSS equivalent |
|---|---|---|
| `animDuration` | `400` (ms) | `400ms` |
| `animCurveStandard` | `[0.2, 0, 0, 1, 1, 1]` | `cubic-bezier(0.2, 0, 0, 1)` |
| `animCurveStandardDecel` | `[0, 0, 0, 1, 1, 1]` | `cubic-bezier(0, 0, 0, 1)` |

Qt's `easing.bezierCurve` is a flat list of control-point pairs ending at
`(1,1)`. So `[x1, y1, x2, y2, 1, 1]` is exactly CSS `cubic-bezier(x1, y1, x2,
y2)`.

### 1.9 Transparency tokens

`FmTheme.qml:135-143`.

| Token | Value | Note |
|---|---|---|
| `windowBackdrop` | `rgba(0, 0, 0, 0.6)` | The window's own `color`, both windows (`host/standalone/main.qml:54` and `:85`). |
| `_transparencyLayers` | `0.0` | Multiplier used by `layer()`. Keep it at 0.0. |
| `layer(c)` | `Qt.alpha(c, 0.0)` | Returns a fully transparent colour today. |

### 1.10 Size configuration

`qml/Symmetria/FileManager/UI/config/FileManagerConfig.qml:17-22`. These are
configuration, not theme, but a port needs them.

| Token | Value |
|---|---|
| `sizes.windowWidth` | `820` |
| `sizes.windowHeight` | `520` |
| `sizes.itemHeight` | `20` |
| `sizes.overlayViewportFraction` | `0.85` |

The standalone host overrides the window size: the file-manager window is
`1100 × 720` and the picker window is `900 × 600`
(`host/standalone/main.qml:50-51`, `:74-75`).

### 1.11 Fixed component geometry

Values hardcoded in components, not tokens. A port must copy them.

| Value | Where |
|---|---|
| Scrollbar width `6`, thumb radius `width / 2`, thumb opacity `0.4` | `components/SlimScrollBar.qml:10-16` |
| Indicator strip width `5`, active opacity `0.85` | `components/IndicatorStrip.qml:26,36` |
| Git badge `16 × 16`, radius `3` | `components/GitStatusBadge.qml:39-41` |
| Hover state layer alpha `0.08`, pressed `0.12`, ripple start alpha `0.08` | `components/StateLayer.qml:48,69` |
| File icon box `font.size.xl * 1.5` = `18` | `components/FileIcon.qml:25-26` |
| Search-match row tint `onSurface` at opacity `0.06` | `modules/filemanager/FileListItem.qml:87-93` |
| Tree search-match tint `primary` at opacity `0.08`; tree current row `secondaryContainer` at `0.35` | `modules/filemanager/FileTreeRow.qml:58-70` |
| Modal scrim `shadow` at alpha `0.5` | `modules/filemanager/HelpPopup.qml:136`, `FuzzyFinderPopup.qml:63` |
| Tree indent step `16 * compactScale` px | `modules/filemanager/FileTreeView.qml:133` |

### 1.12 Token count

- 18 palette colours
- 3 derived pill values (2 fills + 1 shared border)
- 2 overlay colours
- 3 indicator colours
- 10 git-status colours
- 3 font families + 6 font sizes
- 3 rounding + 3 spacing + 3 padding
- 3 animation tokens (1 duration + 2 curves)
- 2 transparency tokens (backdrop + layer alpha)
- 4 size-configuration values

**Total: 63 tokens** declared in `FmTheme.qml` and `FileManagerConfig.qml`.

The `:root` block in 1.13 emits **71** custom properties: those 63 minus the two
window-size values, which belong to the Electron `BrowserWindow` and not to CSS,
plus the 10 fixed component-geometry values extracted from section 1.11.

### 1.13 Ready-to-use `:root` block

```css
:root {
  /* ---- Palette (defaults; overridable by color-scheme.json) ---- */
  --fm-surface: #0f0f0f;
  --fm-surface-container-lowest: #0b0b0b;
  --fm-surface-container-low: #121212;
  --fm-surface-container: #161616;
  --fm-surface-container-high: #1c1c1c;
  --fm-on-surface: #d4d4d4;
  --fm-on-surface-variant: #a8a8a8;
  --fm-primary: #b4b4b4;
  --fm-on-primary: #0f0f0f;
  --fm-primary-container: #3a3a3a;
  --fm-on-primary-container: #e4e4e4;
  --fm-outline: #6e6e6e;
  --fm-outline-variant: #2a2a2a;
  --fm-secondary-container: #232323;
  --fm-on-secondary-container: #b4b4b4;
  --fm-surface-variant: #2a2a2a;
  --fm-error: #ffb4ab;
  --fm-shadow: #000000;

  /* ---- Derived matte pills (see _mattePill formula) ---- */
  --fm-pill-medium-bg: #131313;   /* hsl(0 0% 7.5%)  */
  --fm-pill-strong-bg: #171717;   /* hsl(0 0% 8.9%)  */
  --fm-pill-border: rgba(255, 255, 255, 0.08);

  /* ---- Overlays ---- */
  --fm-overlay-subtle: rgba(255, 255, 255, 0.06);
  --fm-overlay-emphasis: rgba(255, 255, 255, 0.10);

  /* ---- Indicators (never palette-derived) ---- */
  --fm-indicator-cut: #e57373;
  --fm-indicator-yank: #4caf7d;
  --fm-indicator-selection: #f0c674;

  /* ---- Git status (never palette-derived) ---- */
  --fm-git-added-green: #98c379;
  --fm-git-modified-amber: #e0a93a;
  --fm-git-deleted-red: #e06c75;
  --fm-git-untracked-blue: #61afef;
  --fm-git-renamed-orange: #d19a66;
  --fm-git-conflicted-magenta: #c678dd;
  --fm-git-ignored-gray: #5c6370;
  --fm-git-badge-text: #1a1818;
  --fm-git-adds-green: #7eb777;
  --fm-git-dels-red: #d76060;

  /* ---- Typography (pt -> px at 96dpi) ---- */
  --fm-font-sans: "Rubik", system-ui, sans-serif;
  --fm-font-mono: "CaskaydiaCove NF", ui-monospace, monospace;
  --fm-font-icons: "Material Symbols Rounded";
  --fm-text-xs: 10.67px;   /* 8pt  */
  --fm-text-sm: 12px;      /* 9pt  */
  --fm-text-md: 13.33px;   /* 10pt */
  --fm-text-lg: 14.67px;   /* 11pt */
  --fm-text-xl: 16px;      /* 12pt */
  --fm-text-xxl: 24px;     /* 18pt */

  /* ---- Layout ---- */
  --fm-radius-sm: 6px;
  --fm-radius-lg: 8px;
  --fm-radius-full: 9999px;
  --fm-space-sm: 3px;
  --fm-space-md: 6px;
  --fm-space-lg: 10px;
  --fm-pad-sm: 2px;
  --fm-pad-md: 4px;
  --fm-pad-lg: 7px;

  /* ---- Motion ---- */
  --fm-duration: 400ms;
  --fm-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --fm-ease-decel: cubic-bezier(0, 0, 0, 1);

  /* ---- Transparency ---- */
  --fm-window-backdrop: rgba(0, 0, 0, 0.6);
  --fm-layer-alpha: 0;

  /* ---- Fixed component geometry ---- */
  --fm-item-height: 20px;
  --fm-scrollbar-width: 6px;
  --fm-scrollbar-thumb-opacity: 0.4;
  --fm-indicator-width: 5px;
  --fm-indicator-opacity: 0.85;
  --fm-badge-size: 16px;
  --fm-badge-radius: 3px;
  --fm-hover-alpha: 0.08;
  --fm-pressed-alpha: 0.12;
  --fm-scrim: rgba(0, 0, 0, 0.5);
  --fm-tree-indent: 16px;
  --fm-overlay-viewport-fraction: 0.85;
}
```

---

## 2. The layering and transparency model

The model is called **solid-body** in the source (`FmTheme.qml:114-136`), after
macOS Tahoe and GNOME Files. State it as four layers, outside in.

### 2.1 Layer 1 — the window backdrop (transparent)

The `Window.color` is `FmTheme.windowBackdrop`, which is
`Qt.rgba(0, 0, 0, 0.6)`: pure black at 60 % alpha
(`host/standalone/main.qml:54` for the file-manager window,
`host/standalone/main.qml:85` for the picker window). The compositor blends it
over the wallpaper.

The 0.6 alpha is deliberate and coupled to an external file. `~/.config/ghostty/config`
sets `background = #000000` and `background-opacity = 0.6`. The file manager's
transparent regions therefore darken the wallpaper by exactly as much as the
terminal does, so the two match side by side. It was briefly 0.9 during the
redesign and read far darker than Ghostty. Keep it at 0.6.

### 2.2 Layer 2 — the pane surfaces (opaque)

Each Miller column is a `StyledRect` with `radius: rounding.lg`, solid
`palette.surface`, a 1 px `overlay.subtle` border, and content inset by
`padding.md` (`modules/filemanager/MillerColumns.qml:58-62`, `:93-97`,
`:122-126`). Columns are separated by a `padding.sm` gap, exactly half the
`padding.md` outer margin (`MillerColumns.qml:40-41`).

**The fill is `palette.surface`, the BASE colour, not a container rung.** It was
`surfaceContainerLow` (`#121212`) until commit
`e6a77cf style(fm): flatten the selection pill and blend the panes into the background`.
At one rung lighter the panes read as a grey box sitting **on** the chrome
instead of as part of it — most visibly inside Symmetria IDE, whose surrounding
chrome paints the same near-black. The hairline border alone now delineates the
pane.

One precision the commit message does not spell out. `palette.surface`
(`#0f0f0f`) equals the IDE's `Theme.color.bg.canvas`, **not** its
`Theme.color.bg.chrome` (`#131313`) — the two apps map the same M3 key names to
different rungs. Section 7.5 has the full table. Read "matches the host
background" as "matches the IDE's canvas rung".

The same surface idiom is repeated **four** times. Change all four together:
1. Parent column — `MillerColumns.qml:58`
2. Centre column — `MillerColumns.qml:93`
3. Preview column — `MillerColumns.qml:122`
4. Single-pane tree card — `modules/filemanager/FileManager.qml:104`

**Standalone-vs-embedded caveat, flagged as unverified in CLAUDE.md.** The
"panes match the host background" rationale was verified only in the
IDE-hosted file manager. In the standalone window the surrounding area is
`windowBackdrop` — black at 0.6 over the wallpaper — not a solid base fill, so
the rationale does not apply there. The panes stay opaque either way, so the
floating-card separation is unchanged and the shift is only 3 lightness units,
but nobody has looked at it over a bright wallpaper. Record this before you
match it in CSS.

### 2.3 Layer 3 — the panel layers (fully transparent today)

`ParentPanel`, `FileList`, `PreviewPanel` and `FileTreeView` each paint their own
background as `FmTheme.layer(FmTheme.palette.surfaceContainerLow)`
(`ParentPanel.qml:31`, `FileList.qml:243`, `PreviewPanel.qml:48`,
`FileTreeView.qml:418`). `layer()` multiplies alpha by `_transparencyLayers`,
which is `0.0`, so these rectangles paint nothing and **reveal the pane surface
behind them**.

Do not raise `_transparencyLayers` to tint the panels. The solid fill is owned by
the pane surfaces. A layer tint would compound with the backdrop in the chrome
gaps.

### 2.4 Layer 4 — the chrome (transparent around opaque controls)

Transparency survives only in the chrome: the empty areas of the top and bottom
bars around the bar pills, and the gaps between cards. Both bars are themselves
opaque:
- Breadcrumb bar — `PillSurface` with `color: palette.surface`
  (`modules/filemanager/PathBar.qml:106-109`)
- Status bar — `PillSurface` with `color: palette.surface`
  (`modules/filemanager/StatusBar.qml:30-33`)

Commit `54af46f style(chrome): drop the bars and picker buttons to the base colour`
moved both from the matte-pill fill (`#131313`) to `palette.surface`
(`#0f0f0f`). Reason: both bars span the full pane width, so a fill above the
ground reads as a lighter band across the app rather than as a control. The
hairline border is what still frames them.

The same commit dropped the picker buttons: Cancel, and Open while disabled, go
from `surfaceVariant` to `surfaceContainer` — one quiet step above the bar
instead of three (`StatusBar.qml:73`, `:275`). Open while **enabled** keeps
`palette.primary`, a light fill with dark text, because it is the one primary
affordance on that bar.

### 2.5 CSS translation

```css
/* Layer 1 — the Electron window. Requires transparent: true on BrowserWindow. */
body { background: var(--fm-window-backdrop); }

/* Layer 2 — a pane. Opaque. */
.fm-pane {
  border-radius: var(--fm-radius-lg);
  background: var(--fm-surface);
  border: 1px solid var(--fm-overlay-subtle);
  padding: var(--fm-pad-md);
}

/* Layer 3 — a panel inside a pane. Paint nothing. */
.fm-panel { background: transparent; }
```

Note for Electron: reproducing layer 1 needs
`new BrowserWindow({ transparent: true, frame: false, backgroundColor: '#00000000' })`
on a compositing Wayland/X11 session. Without `transparent: true` the 0.6 alpha
composites against white and the whole model breaks.

---

## 3. The claymorphism pill system

The claymorphism is **switched off**. Every shadow alpha is `0.0`. The recipe is
kept in the source as documentation, not as live rendering. Do not restore it —
the flatness is the intent (`components/PillSurface.qml:19-32`, `:79-107`).

### 3.1 `PillSurface` construction

`components/PillSurface.qml:60-192`. Node order, back to front:

1. **Dark shadow** — `RectangularShadow` filling `pillBody`, `blur: 12`,
   `spread: 0`, `offset (2, 3)`, colour `rgba(0, 0, 0, darkShadowAlpha)`.
   Historical alpha `0.40`, now `0.0`.
2. **Light shadow** — `RectangularShadow`, `blur: 8`, `offset (-2, -2)`, colour
   `rgba(1, 1, 1, lightShadowAlpha)`. Historical alpha `0.10`, now `0.0`.
3. **Pill body** — `StyledRect` with `color`, `radius` (default `rounding.full`),
   and a `borderWidth: 1` / `borderColor` hairline.
4. **Rim gradient** — a child `Rectangle` filling the body, four gradient stops:
   `0.00 → rgba(1,1,1,highlightAlpha)`, `0.45 → rgba(1,1,1,0)`,
   `0.55 → rgba(0,0,0,0)`, `1.00 → rgba(0,0,0,innerShadowAlpha)`. Historical
   `highlightAlpha` `0.08`, now `0.0`.
5. **Content holder** — an `Item` with `anchors.fill: parent`; the default
   property alias reparents children into it, so they paint above the rim.

The `elevated` boolean is a master switch for the depth only; the fill and the
border stay regardless.

Two performance details worth carrying over. Each `RectangularShadow` gates its
`visible` on the **token** (`darkShadowAlpha > 0`), not on `elevated`, because a
zero-alpha shadow still runs its blur shader every frame
(`PillSurface.qml:114-122`, commit `9be6ee9`). And the gate must stay static —
binding it to `elevated` would pop the item in and out mid-fade.

### 3.2 `PillCard` overrides

`components/PillCard.qml`. A thin `PillSurface` with:
- `radius: FmTheme.rounding.lg` instead of a full capsule
- wider, softer shadows: dark `offset (3, 4)` `blur 14`, light `offset (-3, -3)`
  `blur 11`
- a faint bottom inner shadow (`innerShadowAlpha`), historical `0.03`
- historical alphas: dark `0.28`, light `0.07`, inner `0.03`; all `0.0` now

`PillCard` frames content (popups, dialogs). `PillSurface` is the chip (bars,
tabs). Consumers of `PillCard`: `ContextMenuPopup.qml:258`, `HelpPopup.qml:140`,
`FuzzyFinderPopup.qml:67`, `RenamePopup.qml:64`, `CreateFilePopup.qml:46`,
`ZoxidePopup.qml:51`, `DeleteConfirmPopup.qml:44`, `WhichKeyPopup.qml:43`.

### 3.3 The `_mattePill` lightness formula

`FmTheme.qml:167-183`. Reproduced exactly:

```js
function _mattePill(baseColor, intensity) {
    const clampedIntensity = Math.max(0, Math.min(1, intensity));
    const lightness = 0.04 + clampedIntensity * 0.07;

    const background = Qt.hsla(
        baseColor.hslHue,
        baseColor.hslSaturation * 0.12,
        lightness,
        1.0
    );
    const border = Qt.alpha("#ffffff", 0.08);

    return { background: background, border: border };
}
```

**The lightness is not palette-driven.** `_mattePill` takes only the hue and the
saturation from `baseColor`, and the saturation is further multiplied by 0.12.
The lightness comes entirely from `intensity`. Darkening
`surfaceContainerHigh` in the scheme file therefore darkens no pill. This
formula is the only lever. The source records this because the opposite is the
natural assumption and it cost a pass to discover.

Intensity presets (`FmTheme.qml:162-165`): `matte.medium = 0.5`,
`matte.strong = 0.7`.

Resolved against the achromatic default palette, where
`surfaceContainerHigh = #1c1c1c` has saturation 0:

| Preset | Lightness | Resulting colour |
|---|---|---|
| `medium` (0.5) | `0.04 + 0.5 * 0.07 = 0.075` | `hsl(0 0% 7.5%)` = `#131313` |
| `strong` (0.7) | `0.04 + 0.7 * 0.07 = 0.089` | `hsl(0 0% 8.9%)` = `#171717` |

For reference, `palette.surface` (`#0f0f0f`) sits at L 0.0588. So `medium` is one
step above the base and `strong` is two — visible as a raised surface by fill
alone, with no depth.

The border dropped from `0.12` to `0.08` with the flat move: without a shadow the
border is the only separation cue, so it has to read as a hairline rather than as
a drawn outline (`FmTheme.qml:177-180`).

Since the palette is achromatic, the JS port collapses to a grey ramp. Keep the
hue/saturation arguments anyway so a chromatic scheme file still works:

```ts
export function mattePill(baseHsl: {h: number; s: number}, intensity: number) {
  const i = Math.max(0, Math.min(1, intensity));
  const l = 0.04 + i * 0.07;
  return {
    background: `hsl(${baseHsl.h}deg ${baseHsl.s * 0.12 * 100}% ${l * 100}%)`,
    border: "rgba(255, 255, 255, 0.08)",
  };
}
```

### 3.4 The clipping pitfall

`components/PillSurface.qml:44-54`. The two `RectangularShadow`s are offset and
blurred, so they paint **outside** the pill's own rect. Two consequences:

1. Any **ancestor** with `clip: true` cuts the soft shadow edges off and leaves a
   flat, sliced pill. If a shadow looks chopped, search the parent chain for a
   clip. Do not shrink the blur.
2. The host item must leave margin around the pill for the shadow to occupy. A
   pill anchored flush to a tight parent has nowhere to cast.

The CSS analogue is exact: `overflow: hidden` on an ancestor clips a `box-shadow`
the same way. Since the alphas are 0 today, nothing shows the symptom — but the
constraint returns the moment anyone reverses the direction.

### 3.5 CSS mapping, and where CSS falls short

| QML effect | CSS equivalent | Fidelity |
|---|---|---|
| Dark `RectangularShadow`, offset + blur | `box-shadow: 2px 3px 12px rgba(0,0,0,0.40)` | Good. Qt's blur radius and the CSS blur radius are both a Gaussian sigma proxy, but the falloff differs slightly. Expect to retune the blur number by eye. |
| Light `RectangularShadow` at negative offset | second entry in the same `box-shadow` list: `, -2px -2px 8px rgba(255,255,255,0.10)` | Good. CSS takes a comma-separated list, so both shadows are one declaration. |
| Rim highlight gradient | `linear-gradient(to bottom, rgba(255,255,255,.08) 0%, transparent 45%, transparent 55%, rgba(0,0,0,.03) 100%)` as a `::before` overlay | Good, and cheaper than QML: no extra render node. |
| `border.width: 1` + `border.color` | `border: 1px solid …` | Differs. Qt draws the border **inside** the rect and does not add to the size; CSS grows the box unless you set `box-sizing: border-box`. Set it globally. |
| `radius: 1000` capsule | `border-radius: 9999px` | Exact. |
| Shadow escaping ancestor `clip: true` | `overflow: hidden` clips `box-shadow` identically | Exact — the same pitfall, same fix. |
| Rounded-corner clipping of children | `overflow: hidden` + `border-radius` | **CSS is better here.** Qt's `clip: true` clips to the bounding box, not to rounded corners — `components/ClippingRect.qml:1-6` documents the workaround. CSS clips to the radius natively, so `ClippingRect` has no React counterpart; a plain `div` with `overflow: hidden` is strictly more correct. |
| `RectangularShadow` blur-shader cost gate | not needed | CSS `box-shadow` with a fully transparent colour costs effectively nothing; the whole `visible: alpha > 0` optimisation drops out of the port. |

Where CSS genuinely falls short: nothing in the pill system. The pill system is
the **easiest** part to port, because it is fill + border + `box-shadow` +
gradient, all first-class in CSS, and because the depth is currently off.

---

## 4. The animation vocabulary

### 4.1 The two primitives

`components/Anim.qml` and `components/CAnim.qml` are three lines each. They exist
so no call site restates the duration or the curve.

| Component | Wraps | Use on |
|---|---|---|
| `Anim` | `NumberAnimation` | numeric properties: `width`, `height`, `opacity`, `scale`, `x`, `y` |
| `CAnim` | `ColorAnimation` | colour properties: `color`, `border.color` |

Both set `duration: FmTheme.animDuration` (400 ms) and
`easing.type: Easing.BezierSpline` with `easing.bezierCurve:
FmTheme.animCurveStandard`.

**Never use `Anim` on a colour property.** A `NumberAnimation` on a colour
produces a permanent `#000000` (CLAUDE.md → Animation Rules, `QUIRKS.md` §7).
This whole hazard vanishes in CSS: `transition` interpolates colours correctly by
type, so the `Anim`/`CAnim` split has no React counterpart and collapses into one
`transition` shorthand.

### 4.2 Components that already animate internally

Do **not** add a second animation on top of these:

| Component | Internal animation | Source |
|---|---|---|
| `StyledRect` | `Behavior on color { CAnim {} }` | `components/StyledRect.qml:8-10` |
| `StyledText` | `Behavior on color { CAnim {} }` | `components/StyledText.qml:13-15` |
| `ClippingRect` | `Behavior on color { CAnim {} }` | `components/ClippingRect.qml:15-17` |
| `PillSurface` | `Behavior on border.color { CAnim {} }` plus one `CAnim` per shadow colour | `components/PillSurface.qml:133`, `:149`, `:165` |
| `GitStatusBadge` | `Behavior on color { CAnim {} }` | `components/GitStatusBadge.qml:44` |
| `IndicatorStrip` | `Behavior on opacity { Anim {} }` | `components/IndicatorStrip.qml:38` |
| `StateLayer` | a `SequentialAnimation` ripple: two `PropertyAction`s set the origin, one `Anim` grows `implicitWidth`/`implicitHeight` from 0 to `radius * 2` with the **decel** curve, one `Anim` fades opacity to 0 | `components/StateLayer.qml:28-62` |

### 4.3 The j/k-stutter rule

Documented at `modules/filemanager/FileListItem.qml:96-98` and repeated in
CLAUDE.md.

The current-item highlight in `FileListItem` is a plain `Rectangle`, **not** a
`StyledRect`, precisely to avoid `StyledRect`'s internal colour animation. A
per-delegate colour animation or gradient causes visible stutter during rapid
j/k navigation, because it adds animation and GPU nodes to every visible row.

The same reasoning made the selection pill's rim highlight an **inlined copy** of
the claymorphism recipe rather than a `PillSurface` — a per-row `PillSurface`
would add colour animation plus two GPU shadow nodes to every row. That inlining
is why the pill kept rendering clay after the rest of the app went flat; commit
`e6a77cf` records the lesson: *a performance exception that copies a visual
recipe also opts out of the recipe's single point of change.*

Carry the rule, not the mechanism. In a virtualised React list the equivalent
hazard is a `transition` on the row highlight, which forces per-row style
recalculation on every arrow-key press. Use a static class swap for the current
row.

### 4.4 CSS and Framer Motion equivalents

```css
/* Anim + CAnim, unified. */
.fm-animated {
  transition-duration: var(--fm-duration);
  transition-timing-function: var(--fm-ease-standard);
  transition-property: color, background-color, border-color, opacity, transform;
}

/* The decel curve, used by the StateLayer ripple growth. */
.fm-ripple { transition-timing-function: var(--fm-ease-decel); }

/* The j/k-stutter rule: no transition on a list row highlight. */
.fm-row-current { transition: none; }
```

Framer Motion (or `motion`) equivalents:

```ts
export const fmStandard = { duration: 0.4, ease: [0.2, 0, 0, 1] as const };
export const fmDecel    = { duration: 0.4, ease: [0, 0, 0, 1] as const };
```

The `StateLayer` ripple maps to a `motion.span` whose `width`/`height` animate
from 0 to `2 * radius` with `fmDecel`, followed by an opacity fade. Note that
Mesura Code ships **no** Framer Motion — only `@formkit/auto-animate` and CSS
keyframes (see section 6). Prefer plain CSS transitions to stay consistent with
that codebase.

---

## 5. Typography and icons

### 5.1 The three families

| Family | Value | Where it is used |
|---|---|---|
| sans | `Rubik` | The default. `StyledText` sets it, so every text node inherits it unless overridden (`components/StyledText.qml:10`). Breadcrumbs, dialog labels, file names. |
| mono | `CaskaydiaCove NF` | 65 explicit uses across `modules/filemanager`. Paths, sizes, keycaps, git badge characters, flash-jump labels, status-bar counters. It is a Nerd Font, so it carries the powerline and dev-icon private-use glyphs. |
| icons | `Material Symbols Rounded` | Every glyph rendered by `MaterialIcon`. |

Default text style: `renderType: Text.NativeRendering`,
`textFormat: Text.PlainText`, `color: palette.onSurface`, `font.pointSize:
font.size.sm` (9 pt / 12 px).

The dominant size is `xs` (8 pt / 10.67 px, 67 uses). This is a **dense** UI. A
web port that defaults to 14 px will look nothing like it.

### 5.2 `MaterialIcon` and variable axes

`components/MaterialIcon.qml` is a `StyledText` whose family is the icon font and
whose `text` is a **ligature name** such as `"hourglass_empty"`. It drives four
OpenType variable axes:

```qml
font.variableAxes: ({
    FILL: fill.toFixed(1),      // 0.0 .. 1.0, outline -> filled
    GRAD: grade,                // -25 in dark mode, 0 in light mode
    opsz: fontInfo.pixelSize,   // optical size follows the rendered size
    wght: fontInfo.weight
})
```

`grade: FmTheme.light ? 0 : -25` (`MaterialIcon.qml:5`) — a negative grade thins
the strokes so an icon on a dark background does not bloom.

### 5.3 `FileIcon` — two icon sources

`components/FileIcon.qml` picks between two renderings on
`Config.fileManager.iconMode`:
- `"system"` (the default) and a non-empty `iconPath` — renders an
  `Image { source: "file://" + iconPath }` at `sourceSize` 2× for crispness.
- otherwise — renders the `MaterialIcon` fallback by ligature name.

The `iconPath` comes from the C++ `IconThemeResolver`, which hand-rolls XDG icon
theme lookup and returns the **file path on disk**, not a `QIcon`. The rationale
(CLAUDE.md → Icon resolution): QML renders an SVG source crisply from a path,
whereas `QIcon::fromTheme(...).pixmap()` would rasterise and lose the vector.

### 5.4 What a web renderer needs

| Need | Recommendation |
|---|---|
| Rubik | Self-host the woff2 from Google Fonts. It is SIL OFL, so bundling is fine. Do not rely on the system copy in Electron. |
| CaskaydiaCove NF | This is the Nerd-Fonts patch of Cascadia Code, and it is **large** (several MB per weight) because of the private-use glyph blocks. If the port does not render Nerd Font glyphs, ship plain **Cascadia Code** instead and save the weight. Audit for private-use codepoints first. |
| Material Symbols Rounded | **A webfont, not an SVG set.** The four variable axes (`FILL`, `GRAD`, `opsz`, `wght`) are the whole point — `FILL` animates between outline and filled, and `GRAD: -25` is what stops dark-mode bloom. An SVG icon set cannot express those axes. Use the variable-font woff2 and drive the axes with `font-variation-settings`. |
| System file-type icons | The XDG theme lookup has **no** web equivalent. Electron's `app.getFileIcon()` returns a rasterised `NativeImage` and loses the vector, which is exactly the trade-off the C++ resolver was written to avoid. Two options: (a) expose the resolved SVG path over IPC and load it with a `file://` URL from the renderer, keeping the vector; (b) drop system icons and use only the Material glyph fallback. Option (a) preserves current behaviour. |

CSS for the icon font:

```css
.fm-icon {
  font-family: var(--fm-font-icons);
  font-variation-settings: "FILL" 0, "GRAD" -25, "opsz" 24, "wght" 400;
  transition: font-variation-settings var(--fm-duration) var(--fm-ease-standard);
}
.fm-icon[data-filled="true"] { font-variation-settings: "FILL" 1, "GRAD" -25, "opsz" 24, "wght" 400; }
```

---

## 6. Component inventory

The module manifest is `qml/Symmetria/FileManager/UI/qmldir`. It exports one
entry component, six singletons, four per-instance service types, 18 reusable
components, and 34 panel sub-components.

Mesura Code's React primitives live in
`/home/jc/projects/mesura-code/apps/web/src/components/ui/` (a shadcn-style layer
over `@base-ui/react`, styled with Tailwind CSS v4 + `class-variance-authority`,
tokens in `apps/web/src/index.css`). "Reuse" below means that layer.

### 6.1 Reusable components — `components/`

| Component | Public API | Role | React status |
|---|---|---|---|
| `Anim` | (none — a `NumberAnimation` preset) | Numeric animation with the shared duration and curve. | **Drop.** Becomes a CSS `transition` declaration. |
| `CAnim` | (none — a `ColorAnimation` preset) | Colour animation with the shared duration and curve. | **Drop.** Same `transition`; CSS types colours correctly. |
| `StyledRect` | (inherits `Rectangle`) | `Rectangle` with `color: transparent` and an internal colour `Behavior`. | **Drop.** A `div` with the `.fm-animated` class. |
| `StyledText` | (inherits `Text`) | Text with the sans family, `font.size.sm`, `onSurface`, native rendering, colour `Behavior`. | **Drop.** Base typography in `:root` / a body class. |
| `ClippingRect` | (inherits `Rectangle`) | Clip-enabled rect. Works around Qt clipping to the bounding box, not the radius. | **Drop.** `overflow: hidden` + `border-radius` is natively correct in CSS. |
| `PillSurface` | `color`, `radius`, `borderColor`, `borderWidth`, `elevated`, `darkShadow{OffsetX,OffsetY,Blur,Alpha}`, `lightShadow{OffsetX,OffsetY,Blur,Alpha}`, `highlightAlpha`, `innerShadowAlpha`, default slot `content` | The matte capsule primitive: fill + hairline border (+ neutralised depth). | **Build.** No direct match. Closest prior art is `ui/card.tsx` (`CardFrame`, `CardPanel`), but the capsule radius and the depth props are new. |
| `PillCard` | (inherits `PillSurface`) | The content-framing variant: `rounding.lg`, wider shadows. | **Build.** Or use `ui/card.tsx` with overridden radius. |
| `MaterialIcon` | `fill`, `grade` (+ inherited `Text`) | Renders one Material Symbols ligature with four variable axes. | **Build.** Mesura uses `lucide-react` and per-icon components (`components/Icons.tsx`); there is no generic `<Icon name=…>` and nothing driving variable axes. |
| `FileIcon` | `iconPath`, `materialIconName` (required), `materialColor`, `materialFill`, `materialPointSize`, `materialWeight`, `useSystemIcon` (readonly) | Picks a themed system icon file or the Material glyph fallback. | **Build.** Needs the IPC path described in 5.4. |
| `GitStatusBadge` | `status` (required; `{char, color, textColor?, tooltip?}`) | 16×16 radius-3 chip with one mono character plus a tooltip. | **Adapt.** `ui/badge.tsx` + `ui/tooltip.tsx` cover it. |
| `IndicatorStrip` | `stripColor` (required), `active` (required) | 5 px left-edge strip; the inner rect is wider than the clip so only the left corners round. | **Build.** Trivial: an absolutely positioned `div` with `border-radius: 6px 0 0 6px`. |
| `SlimScrollBar` | (inherits `ScrollBar`) | 6 px scrollbar, rounded thumb at `onSurfaceVariant` / opacity 0.4. | **Reuse.** `ui/scroll-area.tsx` plus Mesura's `--app-scrollbar-width: 6px`, which already matches. |
| `StateLayer` | `disabled`, `showHoverBackground`, `color`, `radius` | Material state layer: hover 0.08, pressed 0.12, plus a ripple. | **Build.** shadcn/base-ui has no ripple. Hover and pressed are `:hover` / `:active` classes; the ripple needs a component. |
| `PreviewLoadingIndicator` | (none) | Centred hourglass glyph plus "Loading…" at `outline`. | **Build.** Compose from `ui/spinner.tsx` or `ui/skeleton.tsx`. |
| `PreviewStateIndicator` | `iconName` (required), `message` (required) | Large centred glyph plus a message for empty/error preview states. | **Adapt.** `ui/empty.tsx` is the same idea. |
| `FileOpener` | (imperative `open(path, mime)`) | Launches a file via the desktop handler. | **Build.** Becomes `shell.openPath` over IPC. Non-visual. |
| `ClipboardCopyRunner` | (imperative) | Runs `wl-copy` for the `ci` image chord. | **Build.** Becomes `clipboard.writeImage`. Non-visual. |
| `PasteRunner` | signal `pasteFailed()` | Runs the paste shell command. | **Build.** Non-visual. |

### 6.2 Panel sub-components — `modules/filemanager/`

All are project-specific; none has a React equivalent. The table records the
public API so a port can preserve the seams.

| Component | Public API | Role |
|---|---|---|
| `FileManager` | `initialPath`; signal `closeRequested()` | The embeddable entry component. |
| `MillerColumns` | `windowState`, `tabManager`; readonly `currentEntry`, `fileCount`, `currentItemBottomY`, `currentColumnX`, `currentColumnWidth`; signal `closeRequested()` | Three-column layout. Owns three of the four pane surfaces. |
| `FileList` | `windowState`, `tabManager`, `statusProvider`, `parentEntries`, `previewDirectoryEntries`, `previewDirectoryPath`; readonly `currentEntry`, `fileCount`, `currentItemBottomY`; signal `closeRequested()` | The centre column list. |
| `FileListItem` | `index` (required), `modelData` (required), `searchQuery`, `isSearchMatch`, `isSelected`, `flashActive`, `flashQuery`, `flashLabel`, `flashMatchStart`, `statusProvider`, `statusVersion`; signal `activated()` | One row. Owns the current-item highlight and the deliberate absence of zebra striping. |
| `ParentPanel` | `windowState`; readonly `entries` | Left column. |
| `PreviewPanel` | `previewEntry` (required), `windowState`; readonly `directoryEntries`, `directoryPath` | Right column. |
| `PreviewContent` | `entry` (required), `windowState`; readonly `textLineCount`, `textLanguage`, `archiveFileCount`, `archiveDirCount`, `spreadsheet*`, `audioDuration` | **The single preview router.** A new preview type added here appears in both consumers. Do not re-implement routing in a consumer. |
| `PreviewMetadata` | `entry` (required), `imageDimensions`, `textLanguage`, `textLineCount`, `archive*`, `spreadsheet*`, `audioDuration` | The metadata strip under a preview. |
| `TextPreview` | `entry` (required); readonly `lineCount`, `language` | Syntax-highlighted source. |
| `ImagePreview` | `entry` (required); readonly `naturalSize` | |
| `VideoPreview` | `entry` (required); readonly `naturalSize` | |
| `AudioPreview` | `entry` (required), `windowState`; readonly `audioTitle`, `audioArtist`, `audioDuration`, `isPlaying` | |
| `ArchivePreview` | `entry` (required); readonly `fileCount`, `dirCount` | |
| `SpreadsheetPreview` | `entry` (required); readonly `sheetCount`, `activeSheet`, `totalRows`, `totalCols` | The only consumer of `surfaceContainerLowest`. |
| `HtmlPreview` | `entry` (required) | Sandboxed WebEngine render, toggled by `Ctrl+R`. |
| `FallbackPreview` | `entry` (required) | Unknown-type placeholder. |
| `ArchiveExtractionView` | `extractionDone`, `extractionError`, `extractedCount`, `extractTotalCount` (all required) | Extraction progress. |
| `PathBar` | `windowState` | Breadcrumb bar. Owns one of the two chrome bars. |
| `StatusBar` | `windowState`, `fileCount` (required), `currentEntry` (required) | The other chrome bar. Also owns the picker buttons. |
| `TabBar` | `tabManager`; signal `closeRequested()` | The only consumer of `pillMedium` as a fill. |
| `FileTreeView` | `rootPath` (required), `showHidden`, `respectGitignore`, `expandedPaths`, `windowState`, `initialExpandDepth`, `maxExpandDepth`, `lazyExpand`, `restoreExpandedPaths`, `statusProvider`, `ignoredPathSet`, `pathFilter`, `compactScale`; readonly `indentPixels`, `currentEntry`, `currentItemBottomY`, `currentColumnX`, `currentColumnWidth`; signals `fileActivated(path)`, `directoryChanged(path)` | The tree view. The IDE sidebar consumes this directly. |
| `FileTreeRow` | `index` (required), `modelData` (required), `windowState`, `compactScale`, `indentPixels`, `statusProvider`, `statusVersion`; readonly `rowDepth`, `rowIsDir`, `rowExpanded`; signal `activated()` | One tree row. Mirrors `FileListItem`'s zebra decision. |
| `FuzzyFinderPopup` | `windowState`, `externalActivation`; signal `activated(path, isDir)` | |
| `FuzzyFinderResultDelegate` | `index`, `path`, `name`, `isDir`, `fullPath`, `matchIndices`, `iconPath`, `selectedIndex` (all required); signal `activated()` | |
| `FuzzyFinderInfoPanel` | `entry` (required), `windowState` | The second consumer of `PreviewContent`. |
| `ContextMenuPopup` | `windowState` | |
| `ContextMenuActionsView` | `actionItems`, `actionIndex` (required); signal `actionTriggered(actionId)` | |
| `OpenWithView` | `filteredApps`, `appFilterQuery`, `appIndex`, `loading` (all required); signals `filterEdited(text)`, `appActivated(desktopId)` | |
| `HelpPopup` | `windowState` | The `?` cheat sheet, rendered from `KeyRegistry.js`. |
| `WhichKeyPopup` | `windowState` | Chord hint HUD. |
| `ZoxidePopup` | `windowState` | |
| `RenamePopup` | `windowState`, `targetItemY`, `targetColumnX`, `targetColumnWidth` | Positioned over the target row. |
| `CreateFilePopup` | `windowState` | |
| `DeleteConfirmPopup` | `windowState` | The only consumer of `palette.error`. |

### 6.3 Mesura Code coverage summary

Already available and directly reusable:
- Scroll area — `ui/scroll-area.tsx`, already 6 px
- Dialog / popover / sheet / menu — `ui/dialog.tsx`, `ui/alert-dialog.tsx`,
  `ui/popover.tsx`, `ui/sheet.tsx`, `ui/menu.tsx`
- Badge and keycap — `ui/badge.tsx`, `ui/kbd.tsx`
- Tooltip — `ui/tooltip.tsx`
- Card / panel — `ui/card.tsx`
- Button — `ui/button.tsx` (cva; sizes `compact`, `default`, `icon`, `icon-lg`,
  `icon-micro`)
- Empty state — `ui/empty.tsx`
- File-manager prior art — `components/files/FileBrowserPanel.tsx` (uses
  `@pierre/trees`), `components/files/FilePreviewPanel.tsx`,
  `components/chat/ChangedFilesTree.tsx`, `hooks/useResizableWidth.ts`

Gaps that must be built:
- The pill primitives (`PillSurface`, `PillCard`) with the depth props
- A Material Symbols icon component driving variable axes
- The Material ripple (`StateLayer`)
- A generic virtualised list wrapper — Mesura uses `@legendapp/list` at call
  sites but has no wrapper
- A context-menu primitive — Mesura handles context menus through
  `contextMenuFallback.ts` + `ui/menu.tsx`

Note the styling mismatch: Mesura's tokens are `oklch`/`color-mix` semantic roles
(`--background`, `--card`, `--muted`) in `apps/web/src/index.css`, while the file
manager's are M3 role names. Do not try to merge the two namespaces. Emit the
`--fm-*` block from section 1.13 alongside Mesura's and let the file-manager
components read only `--fm-*`.

---

## 7. The colour-scheme contract

### 7.1 The file

Path: `~/.config/symmetria/ui/color-scheme.json`. The file manager resolves it in
QML as `Paths.home + "/.config/symmetria/ui"` (`FmTheme.qml:23`) — a plain home
join, with **no XDG or environment override**.

The IDE resolves the same logical file through a three-step chain
(`/home/jc/projects/symmetria-ide/src/symmetria_ide/ui_scheme.py:84`):
1. `$SYMMETRIA_UI_SCHEME`, expanded — used **only if absolute**. A relative value
   is refused with a warning and falls through, because IDE windows have
   different working directories.
2. `$XDG_CONFIG_HOME/symmetria/ui/color-scheme.json` — again only if
   `$XDG_CONFIG_HOME` is absolute.
3. `~/.config/symmetria/ui/color-scheme.json`.

The two chains agree only when neither environment variable is set, which is the
normal case. A third consumer should replicate the IDE's chain, since it is the
superset.

**The file is OPTIONAL and does not exist on this machine today.** `ls
~/.config/symmetria/` shows only `chords.json` and a `shell.json` symlink. So the
built-in palette in `FmTheme.qml:47-66` is the live palette, and it is the real
default — not a fallback nobody sees.

The directory is **toolkit-owned, not Symmetria Shell's**. Until the
flat-aesthetic move the file manager read the shell's
`~/.config/quickshell/symmetria/config/color-scheme.json` and followed the
desktop palette. The shell then took its own metallic direction that the file
manager and the IDE deliberately do not follow, so the shell's file was dropped
from the chain entirely (`FmTheme.qml:10-22`, commit `0ca0ec8`). Editing the
shell's colours no longer affects this app, and that is the intent.

### 7.2 The format

The shell's file, still on disk, is the format reference:

```json
{
  "colours": {
    "surface": "18191a",
    "surfaceContainerLow": "1a1b1c",
    "onSurface": "e2e4e6",
    "outline": "80858a"
  },
  "mode": "dark"
}
```

Two rules a third consumer must obey:
1. Colour values carry **no `#` prefix**. `_applyColorScheme` prepends it
   (`FmTheme.qml:297`).
2. The colours live under a top-level `colours` key, spelled the British way. A
   missing `colours` key makes the function return early without changing
   anything (`FmTheme.qml:292`).

The optional top-level `mode` key sets `FmTheme.light` when it equals `"light"`
(`FmTheme.qml:290`).

### 7.3 How the file manager reads it

`FmTheme.qml:270-302`.

- A `FileWatcher` (C++, from `Symmetria.FileManager.Models`) watches the path
  with `watchChanges: true`.
- `onLoadedChanged` applies the scheme on first load.
- `onFileChanged` restarts a 100 ms debounce `Timer`, which re-applies. So the
  scheme **hot reloads**.
- `_applyColorScheme` parses the JSON, copies the current palette, and
  overwrites **only the keys that already exist** in the built-in palette:
  `if (key in updated) updated[key] = "#" + value`. Unknown keys are silently
  ignored — a scheme file cannot add a token.
- The whole object is then reassigned (`root.palette = updated`) because QML
  bindings do not fire on mutation of a `var` object.
- A parse failure is caught and logged as a warning through the `Logger`
  singleton; the previous palette survives.

The `FileWatcher` class mitigates a documented Qt hazard: `QFileSystemWatcher`
silently drops a watch when the watched path is unlinked and then renamed into
place, which is exactly how an atomic JSON save behaves. `FileWatcher` watches
both the file and its parent directory and re-arms on every change signal, with a
100 ms retry fallback (CLAUDE.md → Critical Pitfalls). An Electron consumer using
`fs.watch` will hit the same hazard and needs the same mitigation.

### 7.4 The key mapping

The file manager's palette keys are M3 role names and map 1:1 to the JSON keys —
there is no translation table on the QML side. The 18 recognised keys are exactly
the ones listed in section 1.1.

Note the asymmetry: the shell's file declares far more keys (`background`,
`surfaceDim`, `surfaceBright`, `surfaceContainerHighest`, `inverseSurface`,
`scrim`, `surfaceTint`, the `*_paletteKeyColor` set, and more). The file manager
ignores every key it does not already declare. A third consumer must decide
whether it does the same or defines its own superset.

### 7.5 The Symmetria IDE side

The IDE reads the same file in Python
(`/home/jc/projects/symmetria-ide/src/symmetria_ide/ui_scheme.py:109`,
`load_scheme()`), then sets the result as a context property in
`/home/jc/projects/symmetria-ide/src/symmetria_ide/app.py:8648`:

```python
ctx.setContextProperty("uiScheme", load_scheme())
```

`qml/design/Theme.qml` is the **only** QML file in the IDE that reads it. It
guards with `typeof` so the file still loads under static analysis
(`Theme.qml:184`) and pulls each token through a helper
(`Theme.qml:191-194`):

```qml
function _c(role: string, fallback: string): string {
    const value = theme._scheme[role];
    return (typeof value === "string" && value.length > 0) ? value : fallback;
}
```

`ui_scheme.py` contains **zero colour literals**. All IDE defaults are QML
literals in `Theme.qml`, exactly as all file-manager defaults are QML literals in
`FmTheme.qml`.

#### The IDE hardens the parse more than the file manager does

`load_scheme()` never raises and returns `{}` on every failure path
(`ui_scheme.py:138-167`):
- the path is not a regular file — `stat()` runs **first**, on purpose, because
  the path is user-controlled and the call happens on the GUI thread before
  `engine.load()`
- the file is larger than `_MAX_BYTES` (256 000)
- `FileNotFoundError` — silent, the normal case
- any other `OSError`, a `UnicodeDecodeError`, a JSON `ValueError`, or a payload
  whose `colours` key is missing or not an object

Per-key validation (`ui_scheme.py:169-179`): a non-string value is skipped with a
warning; a string is stripped and must fully match
`#?(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\Z`, otherwise it is
**dropped, not passed through**. The recorded reason is precise: QML converts a
string to a `color` at binding time, and an unconvertible string lands on Qt's
default (black or transparent), not on the property's own default. Passing
`"red"` through as `"#red"` would therefore blank the token rather than fall
back. The file manager's `_applyColorScheme` has no such validation — copy the
IDE's.

#### The IDE does NOT hot reload

`app.py:8637-8647` states the value is a load-once snapshot, not a live binding.
There is no `QFileSystemWatcher` on the scheme file anywhere in the IDE. The
documented reason is that a watcher alone is insufficient: `Theme.qml` reads the
map through a **function call** (`_c()`), which QML does not re-evaluate. Every
token binding would first have to depend on a notifying property. Restart is the
supported path.

The consequence is recorded at `ui_scheme.py:22-33` and matters to a third
consumer. The file manager watches the same file and re-applies live. So editing
the scheme while an IDE window is open repaints the file-manager-provided
surfaces — file tree, git badges, Active Changes rows — **inside** that window,
while the IDE chrome keeps the old palette. A visibly split palette until
restart.

#### The exact key mapping, both sides

The file manager recognises **18** keys, mapped 1:1 by name (section 1.1). The
IDE recognises **9**, and renames them
(`/home/jc/projects/symmetria-ide/qml/design/Theme.qml`):

| M3 role key | File-manager token | FM default | IDE token | IDE default |
|---|---|---|---|---|
| `surfaceContainerLowest` | `palette.surfaceContainerLowest` | `#0b0b0b` | `color.bg.canvas` (`:274`) | `#0f0f0f` |
| `surface` | `palette.surface` | `#0f0f0f` | `color.bg.chrome` (`:279`) | `#131313` |
| `surfaceContainerLow` | `palette.surfaceContainerLow` | `#121212` | `color.bg.bar` (`:284`) | `#171717` |
| `surfaceContainer` | `palette.surfaceContainer` | `#161616` | `color.bg.raised` (`:289`) | `#1e1e1e` |
| `surfaceContainerHigh` | `palette.surfaceContainerHigh` | `#1c1c1c` | `color.bg.selected` (`:290`) | `#262626` |
| `surfaceContainerHighest` | **not read** | — | `color.bg.raisedSelected` (`:303`) | `#303030` |
| `outline` | `palette.outline` | `#6e6e6e` | `color.text.dim` (`:338`) | `#6e6e6e` |
| `onSurfaceVariant` | `palette.onSurfaceVariant` | `#a8a8a8` | `color.text.normal` (`:339`) | `#a8a8a8` |
| `onSurface` | `palette.onSurface` | `#d4d4d4` | `color.text.strong` (`:340`) | `#d4d4d4` |

**The two ladders share the same key names but not the same default values.** The
three text roles agree exactly. The five shared surface rungs do not: the IDE
sits one to two steps lighter on every one. Two recorded reasons:
- `ui_scheme.py:51-57` — in the IDE, `surface` names the **panel** rung, not the
  content one. It meant "the one background colour" before a 2026-08-13
  surface-ladder split. A pre-split scheme file that sets `surface` to the old
  near-black now paints IDE panels the content colour.
- `Theme.qml:266-273` — the IDE's content rung maps to `surfaceContainerLowest`,
  **not** `surfaceDim`, because M3 gives `surfaceDim` and `surface` the same
  value in a dark scheme, which would collapse `canvas` and `chrome` into one
  colour.

Practical consequence for section 2.2's rationale: the FM pane fill
(`palette.surface` = `#0f0f0f`) equals the IDE's **`color.bg.canvas`**, not its
`color.bg.chrome` (`#131313`). Commit `e6a77cf` measured "the column interiors
match the IDE's top bar exactly", which is consistent — the IDE's top bar sits on
canvas. Do not read "matches the host chrome" as "equals `bg.chrome`".

`ui_scheme.py:39-44` states the two key mappings are **independent by design**.
Adding a key on one side alone changes nothing on the other.

#### What the IDE deliberately keeps out of the scheme

`Theme.qml:177-183`, `:318-322`, `:341-348` — all accents (`mode.*`, `usage.*`,
`diff.*`, `agent.*`, `accent.*`), `border.hairline`, and `text.emphasis` /
`text.selected` are literals. The recorded reasons: M3 has no role for a
translucent-white hairline (`outlineVariant` is opaque and would stop the border
adapting), and M3 has no neutral role above `onSurface`.

`Theme.color.border.hairline` is `#14ffffff` — white at 8 %, the same alpha as
`_mattePill`'s border. That is the strongest cross-app visual invariant after the
palette itself.

#### Where the two apps stay in step by hand

The file cannot carry these; they are duplicated decisions.

| Decision | File manager | IDE |
|---|---|---|
| Achromatic neutrals | `FmTheme.qml:35-46` (commit `1e6bb30`) | `Theme.qml:213-231`, same day |
| `lg` corner radius = 8 | `FmTheme.rounding.lg` (`FmTheme.qml:93`) | `Theme.radius.lg` (`Theme.qml:895-938`), with an explicit "change together" note |
| Animation duration = 400 ms | `FmTheme.animDuration` | `Theme.anim.duration` |
| Standard curve `[0.2, 0, 0, 1, 1, 1]` | `FmTheme.animCurveStandard` | `Theme.anim.standardCurve` — typed `var`, not `list<real>`, because that crashes the IDE's qmllint |
| Hairline alpha 8 % white | `_mattePill` border | `Theme.color.border.hairline` = `#14ffffff` |
| Neutralised claymorphism depth | `PillSurface` / `PillCard`, all alphas 0 | `Theme.depth.chip` / `Theme.depth.card`, all alphas 0 |
| Flat-aesthetic plan | referenced at `PillSurface.qml:81-83` | `docs/flat-aesthetic-plan.md` in the IDE repo |
| Wine syntax palette | `wine.theme` (appendix 9) | `Theme.color.mode.*` derives from `wine_theme.lua` directly |

#### There is no theme injection channel

The IDE embeds the panel with `import Symmetria.FileManager.UI as FmUi` in three
files (`qml/Main.qml:18`, `qml/GitStatusPanel.qml:77`,
`qml/githistory/WorkingFileTreeView.qml:34`) and passes **no theme or palette
property** to any instantiated component. The coupling runs the other way: the
IDE *reads* `FmUi.FmTheme` values to match the panel — `palette.outlineVariant`
at `Main.qml:878` and `:2080`, and the whole `FmTheme.gitStatus.*` set at
`Main.qml:3023-3042`.

So the two apps are coupled through exactly two things: the shared JSON file, and
the IDE's direct reads of `FmTheme`. An Electron consumer gets neither for free.

### 7.6 What an Electron consumer must implement

1. **Resolve the path through the IDE's three-step chain**, not the file
   manager's single home join: `$SYMMETRIA_UI_SCHEME` (absolute only) →
   `$XDG_CONFIG_HOME/symmetria/ui/color-scheme.json` (absolute only) →
   `~/.config/symmetria/ui/color-scheme.json`. Refuse a relative override with a
   warning and fall through.
2. **Treat the file as optional.** Ship the section 1.13 `:root` block as the
   real default. Absence is the normal case today.
3. **`stat()` before reading.** The path is user-controlled. Reject anything that
   is not a regular file, and reject anything over 256 000 bytes, before you open
   it.
4. **Never throw.** Return an empty map on every failure: missing file, other
   I/O error, non-UTF-8 content, bad JSON, payload that is not an object, or a
   missing / non-object `colours` key. Log a warning and keep the previous
   palette.
5. **Validate each value and drop the invalid ones.** Require a full match of
   `/^#?(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/` after trimming.
   Skip non-strings with a warning; other keys still load. Do not pass an
   unvalidated value through — CSS would resolve `#red` to nothing and inherit,
   which is the same failure mode the IDE's regex exists to prevent.
6. **Prepend `#`** only when the value does not already start with one.
7. **Whitelist the keys.** Apply only keys already present in the default
   palette. Ignore the rest silently. A scheme file cannot add a token.
8. **Read `mode`** and set a light/dark flag from `scheme.mode === "light"`.
9. **Decide the ladder explicitly.** The FM and the IDE map the same key names to
   different default values (section 7.5). Pick one ladder for the Electron
   renderer and record which, or the surfaces will disagree with whichever host
   the panel sits in.
10. **Hot reload with a debounce.** Watch the file, debounce 100 ms, re-apply —
    matching the file manager, not the IDE. Handle the atomic-replace hazard:
    watch the parent directory as well and re-arm the watch after every event,
    with a timed retry fallback. `fs.watch` has the same blind spot as
    `QFileSystemWatcher` here.
11. **Push to CSS, not to state.** Set the `--fm-*` custom properties on
    `document.documentElement`. Every component then re-styles without a React
    re-render, which is the closest analogue to QML's immutable-reassignment
    binding trigger.
12. **Do not expect the scheme to move a pill.** `_mattePill` derives lightness
    from a constant, so `--fm-pill-*-bg` must be recomputed from the formula, not
    read from the file. See section 3.3.
13. **Do the watching in the main process**, not the renderer, and push updates
    over IPC. A renderer `fs.watch` breaks under `contextIsolation`.

Behaviour reference: `/home/jc/projects/symmetria-ide/tests/test_ui_scheme.py`
holds 19 assertions covering `#`-less values, non-regular files, oversize files,
non-UTF-8 content, bad JSON, a missing `colours` key, and the dropping of
non-string and non-hex values. Port those cases.

---

## 8. The "flat aesthetic" direction

Eight commits on `main` moved the file manager from claymorphism to a flat
aesthetic, in step with Symmetria IDE. Record the intent so a re-implementation
does not restore what was deliberately removed.

### 8.1 The commits, in order

| Commit | Change |
|---|---|
| `78b3bcc style(pills): flatten the claymorphism depth to zero` | Phase 1. Zero every shadow alpha in `PillSurface` and `PillCard`. Keep the offsets and blurs, which paint nothing at alpha 0, so the look is recoverable by editing six numbers. No consumer overrides those properties, so all 12 consuming files flattened without an edit. |
| `0e9d263 docs(pills): mark the clay recipe in PillSurface as historical` | Annotate the zeros as intent, not regression. |
| `9be6ee9 fix(pills): skip the shadow blur pass while the depth is flat` | Gate `RectangularShadow.visible` on the token, because a zero-alpha shadow still runs its blur shader every frame. |
| `0ca0ec8 feat(theme): move the palette to a near-black base, off the shell's scheme` | Phase 2. Read the scheme from the toolkit dir. Near-black base. Lower the `_mattePill` range. Drop the pill border 12 % → 8 %. `rounding.lg` 16 → 8. Introduce `overlay.zebra`. |
| `88a5c2a style(lists): remove the zebra striping from the tree and the Miller list` | Remove the even-row `Rectangle` from `FileTreeRow` and `FileListItem`. Retire `overlay.zebra`. |
| `e6a77cf style(fm): flatten the selection pill and blend the panes into the background` | Remove the selection pill's inlined rim gradient. Move all four pane surfaces from `surfaceContainerLow` to `palette.surface`. |
| `54af46f style(chrome): drop the bars and picker buttons to the base colour` | Both bars to `palette.surface`. Cancel and disabled Open from `surfaceVariant` to `surfaceContainer`. |
| `1e6bb30 style(theme): make the palette achromatic` | Drop the blue channel to meet r/g on all sixteen neutrals. `error` and `badgeText` exempt. |

### 8.2 The design intent, stated positively

- **Separation comes from fill steps and a hairline border, never from shadow.**
  Surfaces are separated by small lightness steps plus a 1 px `overlay.subtle`
  edge. Because there is no shadow, the border is the *only* separation cue —
  which is why it must read as a hairline (8 %), not as a drawn outline (12 %).
- **The base is near-black and achromatic.** Every neutral has `r == g == b`.
  Over a whole Miller column even a +1 to +6 blue-minus-red cast reads as
  blue-grey rather than neutral. `error` is a real accent and is exempt.
- **A pane is not a raised object.** It fills with the same `palette.surface` as
  the host chrome. Anything lighter reads as a grey box sitting *on* the chrome.
- **A full-width bar is not a control.** A bar spanning the pane width must fill
  with the base colour; a fill above the ground reads as a lighter band across
  the app. The border still frames it.
- **Corners are modest.** `rounding.lg` is 8, not 16. A generous corner is what
  made an extruded clay card read as a soft physical object; with the depth gone
  the same 16 px reads as a dated rounded widget.
- **Rows separate by indent guides and row spacing, not by fill.** The
  current-item highlight is the only remaining row fill.
- **The one thing allowed to stand out is the primary action.** Enabled Open
  keeps `palette.primary` — a light fill with dark text.

### 8.3 What must NOT be restored

| Removed | Where the note lives | Why it is not a bug |
|---|---|---|
| Zebra striping on alternate rows | `FileListItem.qml:80-84`, `FileTreeRow.qml:44-50` | Over the near-black base the alternation read as banding across the whole panel, at any alpha low enough to be subtle and still perceptible. Measured: consecutive rows went from alternating `#171717` / `#0f0f10` to a uniform `#0f0f10`. **Change both files together or neither.** Restoring is a revert of one commit. |
| The `overlay.zebra` token | `FmTheme.qml:249-257` | It was tried at a third of `subtle`'s alpha and reduced the banding without removing it. It now has no consumer. Do not reintroduce it without reintroducing the striping. |
| The selection pill's rim highlight gradient | `FileListItem.qml:112-130` | A white 0.08 → transparent top gradient, the single strongest claymorphism cue. It outlived the rest of the clay only because it was an inlined copy of the recipe and was therefore invisible to the one edit that zeroed `PillSurface`'s alphas. |
| All six shadow alphas plus the two highlight alphas | `PillSurface.qml:79-107`, `PillCard.qml:26-40` | The flatness is the intent, not a regression. The offsets and blurs stay only so the direction is reversible by editing numbers. |
| The cool cast on the neutrals | `FmTheme.qml:35-46` | Neutralisation dropped the blue channel to meet r/g and left r/g untouched, so every step's ordering and spacing survive exactly and only the hue is gone. |
| `surfaceContainerLow` as the pane fill | `MillerColumns.qml:49-56`, `FileManager.qml:97-100` | It read as a grey box sitting on the chrome. Four copies; change all four. |

### 8.4 Consequence for the Electron port

The port starts flat. Do not write `box-shadow` on panes, cards, pills, bars, or
rows. Do not write `background-image: linear-gradient(...)` as a rim highlight. Do
not write an `:nth-child(even)` background rule. Every one of those is a
deliberate removal, and each has a note in the source saying so.

The one shadow that survives is the modal scrim, `rgba(0, 0, 0, 0.5)` behind
`HelpPopup` and `FuzzyFinderPopup` — and that is a scrim, not a depth cue.

---

## 9. Appendix — the syntax-preview theme is separate

Code and Markdown previews are **not** coloured by `FmTheme.palette`. They are
highlighted in C++ by `SyntaxHighlightHelper` using a custom KSyntaxHighlighting
theme named **Wine**, at
`plugin/src/Symmetria/FileManager/Models/themes/wine.theme`. It is embedded into
the plugin `.so` as a Qt resource
(`:/symmetria-fm-syntax/themes/wine.theme`) and falls back to KF6's built-in
`DarkTheme` if the embedded theme fails to load.

Wine deliberately mirrors the user's NeoVim Lush colorscheme at
`~/.config/nvim/lua/jc/plugins/theme/wine_theme/lua/lush_theme/wine_theme.lua`, so
editor and previews share one palette. **Derive every value from
`wine_theme.lua`; do not modify one file without updating the other.**

### 9.1 Wine editor colours

| Key | Value |
|---|---|
| `BackgroundColor` | `#131313` |
| `CurrentLine` | `#1e1d1e` |
| `TextSelection` | `#474646` |
| `LineNumbers` | `#8f8f8f` |
| `CurrentLineNumber` | `#dddddd` |
| `IndentationLine` | `#3a3a3a` |
| `Separator` / `TabMarker` | `#404040` |
| `BracketMatching` | `#373636` |
| `CodeFolding` | `#272727` |
| `SearchHighlight` / `MarkBookmark` | `#6d94e9` |
| `ModifiedLines` | `#c28b12` |
| `SavedLines` / `ReplaceHighlight` / `MarkExecution` | `#62ba46` |
| `MarkWarning` | `#b0a878` |
| `MarkError` / `SpellChecking` / `MarkBreakpointActive` | `#d2602d` |

Note `BackgroundColor` is `#131313`, one step above `palette.surface`. A preview
pane therefore reads slightly raised against the pane it sits in.

### 9.2 Wine text styles

| Style | Colour | Weight |
|---|---|---|
| `Normal`, `Variable`, `Operator` | `#dddddd` | |
| `Keyword`, `Preprocessor`, `Import` | `#c28b12` | bold (Keyword) |
| `ControlFlow` | `#c28b12` | bold + italic |
| `Function` | `#fdd888` | bold + italic |
| `Extension` | `#fdd888` | italic |
| `BuiltIn`, `DataType` | `#c75828` | |
| `Attribute`, `Annotation` | `#e7cb8f` | |
| `String`, `VerbatimString` | `#62ba46` | |
| `SpecialChar`, `SpecialString` | `#e19773` | |
| `Char`, `DecVal`, `BaseN`, `Float`, `Constant`, `Others` | `#e1d797` | |
| `Comment`, `Documentation`, `CommentVar` | `#9e9e9e` | italic |
| `RegionMarker`, `Information` | `#6d94e9` | |
| `Warning` | `#b0a878` | |
| `Alert` | `#d2602d` | bold |
| `Error` | `#d2602d` | |

### 9.3 The NeoVim source palette

`wine_theme.lua:54-105`. The named roles Wine maps from:

```
bg_primary   #131313    fg_primary  #DDDDDD    comment          #9E9E9E
bg_elevated  #1E1D1E    fg_muted    #9E9E9E    string           #62BA46
bg_panel     #272727    fg_inactive #8F8F8F    keyword          #c28b12
bg_element   #373636    border      #404040    func             #fdd888
bg_hover     #353436    border_variant #3A3A3A type_color       #c75828
bg_selected  #474646                           constant         #E1D797
                                               attribute        #e7cb8f
accent_blue    #6d94e9                         constructor      #b5af9a
warning_yellow #B0A878                         variable_special #E19773
error_red      #D2602D
```

For the Electron port, the equivalent layer is a web syntax highlighter
(Shiki, Prism, or CodeMirror). Build a Wine theme for whichever one you pick from
`wine_theme.lua`, not from `FmTheme.palette`, and keep the three-way sync
(NeoVim → `wine.theme` → the web theme) explicit.
