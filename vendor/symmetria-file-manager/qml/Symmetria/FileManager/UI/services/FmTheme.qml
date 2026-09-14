pragma Singleton

import Symmetria.FileManager.Models
import QtQuick

QtObject {
    id: root

    // === Symmetria toolkit config directory ===
    // ⚠ THIS IS NO LONGER SYMMETRIA SHELL'S CONFIG DIR. Until the flat-aesthetic
    // move, the palette was read from
    // `~/.config/quickshell/symmetria/config/color-scheme.json` — the SHELL's
    // file — so the file manager followed the desktop's palette. The shell has
    // since taken its own darker, metallic direction that the file manager and
    // the Symmetria IDE deliberately do not follow, so the two apps now read a
    // TOOLKIT-owned scheme file instead. Editing the shell's colours no longer
    // affects this app, and that is the intent.
    //
    // The file is OPTIONAL: with no file present the built-in dark palette
    // below applies unchanged. It exists so one file can re-skin both apps at
    // once. Same path is read by the IDE (src/symmetria_ide/ui_scheme.py); keep
    // the two in sync when adding keys.
    readonly property string _configDir: Paths.home + "/.config/symmetria/ui"

    // === Palette (defaults: near-black neutral; overwritten from color-scheme.json) ===
    // Stored as a plain JS object (not QtObject) because QML reserves
    // identifiers starting with "on" + uppercase for signal handlers,
    // which would clash with M3 names like onSurface, onPrimary, etc.
    // Use immutable reassignment (root.palette = {...}) to trigger bindings.
    //
    // Flat-aesthetic values: a near-black base (#0F0F0F) with surfaces
    // separated by small lightness steps and a hairline border, rather than by
    // shadow. The previous warm-neutral charcoal set is in git history.
    //
    // ⚠ ACHROMATIC ON PURPOSE (2026-08-19). Every neutral here is r == g == b.
    // They were not: each carried a cool cast (blue-minus-red of +1 to +6) that
    // read as blue-grey rather than neutral once it covered a whole Miller
    // column or file tree. The neutralisation dropped the blue channel to meet
    // r/g and left r/g untouched, so every step's ORDERING and spacing survive
    // exactly and only the hue is gone.
    //
    // Keep it that way, and keep it in step with the IDE: Symmetria IDE's
    // `Theme.qml` made the same move on the same day, and this module renders
    // INSIDE that IDE's side panel — a tint on either side alone shows up as
    // the file tree disagreeing with the chrome around it. `error` is a real
    // accent and is deliberately exempt.
    property var palette: ({
        surface: "#0f0f0f",
        surfaceContainerLowest: "#0b0b0b",
        surfaceContainerLow: "#121212",
        surfaceContainer: "#161616",
        surfaceContainerHigh: "#1c1c1c",
        onSurface: "#d4d4d4",
        onSurfaceVariant: "#a8a8a8",
        primary: "#b4b4b4",
        onPrimary: "#0f0f0f",
        primaryContainer: "#3a3a3a",
        onPrimaryContainer: "#e4e4e4",
        outline: "#6e6e6e",
        outlineVariant: "#2a2a2a",
        secondaryContainer: "#232323",
        onSecondaryContainer: "#b4b4b4",
        surfaceVariant: "#2a2a2a",
        error: "#ffb4ab",
        shadow: "#000000"
    })

    // === Typography ===
    property QtObject font: QtObject {
        property QtObject family: QtObject {
            property string sans: "Rubik"
            property string mono: "CaskaydiaCove NF"
            property string material: "Material Symbols Rounded"
        }
        property QtObject size: QtObject {
            property real xs: 8
            property real sm: 9
            property real md: 10
            property real lg: 11
            property real xl: 12
            property real xxl: 18
        }
    }

    // === Layout tokens ===
    // Corner radii. `lg` came down from 16 with the flat move: a generous
    // corner is what made an extruded clay card read as a soft physical
    // object, and with the depth gone the same 16px reads as a dated rounded
    // widget on a large panel. 8 keeps panels legibly rounded at the scale Zed
    // and similar flat chrome use. Mirrored by the IDE's `Theme.radius.lg`.
    property QtObject rounding: QtObject {
        property int sm: 6
        property int lg: 8
        property int full: 1000
    }

    property QtObject spacing: QtObject {
        property real sm: 3
        property real md: 6
        property real lg: 10
    }

    property QtObject padding: QtObject {
        property real sm: 2
        property real md: 4
        property real lg: 7
    }

    // === Animation tokens ===
    property int animDuration: 400
    property list<real> animCurveStandard: [0.2, 0, 0, 1, 1, 1]
    property list<real> animCurveStandardDecel: [0, 0, 0, 1, 1, 1]

    // === Transparency ===
    // Solid-body model (macOS-Tahoe / GNOME-Files style): the Miller columns are
    // SOLID rounded surfaces (built in MillerColumns.qml), so transparency
    // survives only in the CHROME — the empty areas of the top/bottom bars around
    // the clay pills and the gaps between cards, where the window backdrop shows
    // through. The backdrop is pure black at 0.6 alpha — identical to Ghostty's
    // `background = #000000` + `background-opacity = 0.6`
    // (~/.config/ghostty/config) — so the FM's transparent regions and the
    // terminal look the same wallpaper-darkness side by side. The solid column
    // surfaces sit opaque on top; only the chrome and gaps reveal this backdrop.
    //
    // _transparencyLayers stays 0.0: the panels' internal backgrounds
    // (ParentPanel / FileList / PreviewPanel each call
    // FmTheme.layer(surfaceContainerLow)) remain fully transparent and let the
    // MillerColumns surface behind them show. Do NOT raise it to tint panels —
    // the solid fill is owned by the column surfaces, and a layer tint would
    // compound with the backdrop in the chrome gaps. See CLAUDE.md
    // "Transparency model" for the full rationale.
    //
    // Decoupled from shell.json — Symmetria Shell's transparency is governed
    // by its own logic and should not propagate here.
    readonly property color windowBackdrop: Qt.rgba(0, 0, 0, 0.6)
    readonly property real _transparencyLayers: 0.0

    // Returns `c` tinted with the panel-layer alpha (currently 0.0 = fully
    // transparent passthrough). The window backdrop is served by
    // `windowBackdrop` directly, so this function is only for panel surfaces.
    function layer(c: color): color {
        return Qt.alpha(c, root._transparencyLayers);
    }

    // === Matte pill effect ===
    // Opaque near-black background with a subtle white edge.
    //
    // ⚠ THE LIGHTNESS HERE IS NOT PALETTE-DRIVEN. `_mattePill` takes only the
    // HUE and SATURATION from `baseColor`; the lightness comes entirely from
    // `intensity` via the formula below. Darkening `surfaceContainerHigh` in
    // the scheme file therefore does NOT darken a single pill — this formula is
    // the only lever. Recorded because the opposite is the natural assumption,
    // and it cost a pass to discover during the flat-aesthetic work.
    //
    // Flat-aesthetic values: the base was `0.10 + intensity * 0.08` (medium
    // landed at L 0.14 ≈ #242424), which read as a light grey chip once the
    // clay depth came off and the base went near-black. The range below puts
    // medium at L 0.075 and strong at L 0.089, a step above `surface` (#0f0f10,
    // ≈ L 0.06) — visible as a raised surface, but by fill alone.

    // Intensity presets (0 = deep black, 1 = slightly lighter charcoal)
    readonly property QtObject matte: QtObject {
        readonly property real medium: 0.5
        readonly property real strong: 0.7
    }

    function _mattePill(baseColor: color, intensity: real): var {
        const clampedIntensity = Math.max(0, Math.min(1, intensity));
        const lightness = 0.04 + clampedIntensity * 0.07;

        const background = Qt.hsla(
            baseColor.hslHue,
            baseColor.hslSaturation * 0.12,
            lightness,
            1.0
        );
        // Hairline edge. Dropped from 0.12 to 0.08 with the flat move: without
        // a shadow the border is the ONLY separation cue, so it has to read as
        // a hairline rather than as a drawn outline.
        const border = Qt.alpha("#ffffff", 0.08);

        return { background: background, border: border };
    }

    // Precomputed matte styles for current consumers
    readonly property var pillMedium: _mattePill(palette.surfaceContainerHigh, matte.medium)
    readonly property var pillStrong: _mattePill(palette.surfaceContainerHigh, matte.strong)

    // === Fixed indicator colors ===
    // Hardcoded deliberately: palette tokens change with wallpaper-derived
    // color schemes, so indicators must stay fixed to remain visually
    // distinguishable.
    property QtObject indicator: QtObject {
        property color cut: "#e57373"
        property color yank: "#4caf7d"
        property color selection: "#f0c674"
    }

    // === Git status badge colors ===
    // Named palette consumed by GitStatusBadge. Intentionally NOT palette-derived
    // for the same reason as `indicator`: badge semantics must be stable across
    // wallpaper changes — a learned colour convention shouldn't shift because the
    // desktop tint changed.
    //
    // OPERATION-based grammar (NOT index-state): colour encodes the KIND of change
    // (added / modified / deleted / renamed / …), keyed on the porcelain status
    // CHAR by the statusProvider, NOT whether the change is staged. This matches
    // VS Code / GitHub and — the reason for the 2026-06-27 switch from the old
    // staged-green/unstaged-red scheme — keeps modified (amber) visually distinct
    // from deleted (red), which the index-state scheme collapsed into one red. The
    // staged/unstaged axis, when it matters, is carried by a separate surface (the
    // IDE's Active Changes summary groups by side via dot icons, not badge colour).
    //
    // The FM does NOT decide which badge corresponds to which color — that's the
    // statusProvider's job (IDE: Main.qml `_colorForOperation`; FM standalone:
    // FuzzyFinderInfoPanel `_gitStatusObj` — both key on the char and resolve to
    // these slots, so the two surfaces render git status identically). The FM just
    // exposes named slots so providers avoid inventing hex literals.
    property QtObject gitStatus: QtObject {
        property color addedGreen: "#98c379"        // added (A) — new tracked content
        property color modifiedAmber: "#e0a93a"     // modified (M/T) — golden amber; deeper/warmer
                                                    // than One-Dark's pale yellow (#e5c07b) so it
                                                    // reads clearly as "amber" and stays distinct
                                                    // from renamedOrange and the neutral fallback.
        property color deletedRed: "#e06c75"        // deleted (D) — removed content
        property color untrackedBlue: "#61afef"     // untracked (?) — not tracked yet
        property color renamedOrange: "#d19a66"     // renamed/copied (R/C) — moved content
        property color conflictedMagenta: "#c678dd" // conflicted (U) — merge conflicts
        property color ignoredGray: "#5c6370"       // ignored (!) — rarely rendered
        // Text ON a saturated badge fill (the green/amber/red git chips), so it
        // is NOT palette-derived and did not move with the flat-aesthetic
        // palette. The value happens to equal the pre-flat `palette.surface`,
        // which is a coincidence of both being a warm near-black — it must stay
        // legible against the badge colours, not against the app background.
        property color badgeText: "#1a1818"
        // Inline line-delta text colors. Distinct from staged/unstaged
        // badge fills (which are saturated for use as backgrounds) —
        // these are slightly muted so they read cleanly as TEXT on the
        // surface background. Used by FileTreeView's row delegate when
        // statusProvider returns {adds, dels} on the status object.
        property color addsGreen: "#7eb777"        // line-additions ('+N')
        property color delsRed:   "#d76060"        // line-deletions ('-N')
    }

    // === Overlay tokens ===
    // Panel borders and dividers (MillerColumns, ContextMenu, HelpPopup), plus
    // the fill of small swatches like the keycap badges in
    // ContextMenuActionsView and HelpPopup.
    //
    // ⚠ There is deliberately NO alternating-row token. A `zebra` one existed
    // briefly during the flat-aesthetic move, at a third of `subtle`'s alpha,
    // because a 6% white FILL across a full row read as a banded stripe over
    // the near-black base where the same 6% is correct as an EDGE. The striping
    // was then dropped from the file tree and the Miller list altogether (user
    // decision), which left the token with no consumer. Do not reintroduce one
    // without reintroducing the striping — see the notes in FileTreeRow.qml and
    // FileListItem.qml.
    property QtObject overlay: QtObject {
        property color subtle: Qt.alpha("#ffffff", 0.06)
        property color emphasis: Qt.alpha("#ffffff", 0.10)
    }

    // === Misc ===
    property bool light: false

    // === Read theme directly from Symmetria config files ===
    // No IPC needed — works even when Symmetria Shell is not running.

    // QtObject has no default property — children declared as named properties.
    property FileWatcher _colorSchemeView: FileWatcher {
        id: colorSchemeView
        path: root._configDir + "/color-scheme.json"
        watchChanges: true
        onLoadedChanged: if (loaded) root._applyColorScheme(text)
        onFileChanged: colorSchemeDebounce.restart()
    }

    property Timer _colorSchemeDebounce: Timer {
        id: colorSchemeDebounce
        interval: 100
        onTriggered: root._applyColorScheme(colorSchemeView.text)
    }

    // === Apply palette from color-scheme.json ===
    // The JSON stores colors without "#" prefix (e.g., "surface": "1a1818").
    // Uses immutable reassignment to trigger QML bindings on the var palette.
    function _applyColorScheme(json: string): void {
        try {
            const scheme = JSON.parse(json);
            root.light = scheme.mode === "light";

            if (!scheme.colours) return;
            const colours = scheme.colours;
            const updated = Object.assign({}, root.palette);
            for (const [key, value] of Object.entries(colours))
                if (key in updated)
                    updated[key] = "#" + value;
            root.palette = updated;
        } catch (e) {
            Logger.warn("FmTheme", "failed to parse color-scheme.json: " + e);
        }
    }

}
