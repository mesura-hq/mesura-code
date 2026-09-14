# Icons — what Mesura Code has, and how the file manager adopts it

This report answers decision **D8** in `15-decisions.md:160`. That decision settled
that the file manager adopts Mesura Code's icons. It left one question open: whether
the XDG resolver is needed at all, or only for the "Open With" application icons.

This report answers that question, and it records the mechanism the file manager has
to copy.

Scope: read-only inspection of `/home/jc/projects/mesura-code` at commit `69f13f9c8`
and of this repository. Nothing was installed, built or launched.

**Short answer.** Mesura Code's file icons come from a public, Apache-2.0 npm package
called `@pierre/trees`. A separate repository installs it and calls two exported
functions. `IconThemeResolver` survives only in a reduced form, for "Open With"
application icons, and that is the only remaining XDG need.

---

## 1. The icon inventory

Mesura Code has exactly **three** icon sources. There is no icon font, no build-time
SVG pipeline and no sprite generated inside the monorepo.

| # | Source | Version | Licence | Size | Used for |
|---|---|---|---|---|---|
| 1 | `lucide-react` | 0.564.0 | ISC | 1917 icon modules in `dist/esm/icons/` | All chrome: toolbars, buttons, status, empty states |
| 2 | `@pierre/trees` built-in sprite | 1.0.0-beta.4 | Apache-2.0 | 58 `<symbol>`s, 37 919 bytes | File-type icons in every file surface |
| 3 | Hand-written brand SVG components | fork/upstream source | inherits the repo licence | 34 components | Product logos (git hosts, editors, AI providers) |

### 1.1 `lucide-react`

Declared at `/home/jc/projects/mesura-code/apps/web/package.json:41`.

- **Reach**: 130 files import it. 201 distinct icon names appear across
  `apps/web/src`, `apps/desktop/src` and `packages`.
- **Licence**: ISC, with a Feather (MIT) attribution for part of the set
  (`/home/jc/projects/mesura-code/apps/web/node_modules/lucide-react/LICENSE`).
- **Not used for file types.** The only file-type role it plays is the two-icon
  fallback when the Pierre resolver returns nothing —
  `/home/jc/projects/mesura-code/apps/web/src/components/chat/PierreEntryIcon.tsx:74-78`
  renders `FolderIcon` for a directory and `FileIcon` for a file.

### 1.2 `@pierre/trees`

Declared at `/home/jc/projects/mesura-code/apps/web/package.json:28`, pinned to the
exact version `1.0.0-beta.4` (not a range, not the workspace catalog).

- **Licence**: `apache-2.0`, stated in the package manifest and shipped as
  `LICENSE.md` + `NOTICE.md`. The `NOTICE.md` credits `@headless-tree/core` (MIT) for
  part of the tree core, not for the icons.
- **Icon provenance**: the art is generated from `@pierre/vscode-icons` 0.0.9 (MIT,
  `https://github.com/pierrecomputer/vscode-icons`), which is a devDependency of
  `@pierre/trees` and is consumed by its own `generate-icons` script. The published
  `@pierre/trees` tarball already contains the generated sprite, so a consumer never
  needs `@pierre/vscode-icons`.
- **Three tiers**, selected by `set`:

  | Set | Symbols | Bytes | Contents |
  |---|---|---|---|
  | `minimal` | 5 | 1 881 | Chrome only: chevron, file, dot, lock, ellipsis |
  | `standard` | 28 | 17 279 | Chrome + 23 language tokens |
  | `complete` | 58 | 37 919 | Chrome + 53 language/tool tokens |

  Measured with `getBuiltInSpriteSheet` from
  `/home/jc/projects/mesura-code/apps/web/node_modules/@pierre/trees/dist/builtInIcons.js:548`.

- Mesura Code selects `complete`, at
  `/home/jc/projects/mesura-code/apps/web/src/pierre-icons.ts:69`.

### 1.3 The T3 sprite overlay

`/home/jc/projects/mesura-code/apps/web/src/pierre-icons.ts:15-63` embeds a second,
hand-written sprite with **6** symbols, and maps **7** exact basenames to them at
`:71-79`:

| Basename | Symbol id |
|---|---|
| `package.json` | `t3-file-icon-package-json` |
| `tsconfig.json` | `t3-file-icon-tsconfig` |
| `agents.md` | `t3-file-icon-agents` |
| `claude.md` | `t3-file-icon-claude` |
| `readme.md` | `t3-file-icon-readme` |
| `pnpm-lock.yaml` | `t3-file-icon-pnpm` |
| `pnpm-workspace.yaml` | `t3-file-icon-pnpm` |

Both sprites are injected into `document.body` together by `ensurePierreIconSprite()`
(`:109-121`), inside a hidden `aria-hidden` container.

### 1.4 Brand SVG components

- `/home/jc/projects/mesura-code/apps/web/src/components/Icons.tsx` — 22 components
  (GitHub, Git, Jujutsu, GitLab, Azure DevOps, Bitbucket, Cursor, Grok, Trae, Kiro,
  VS Code, VS Code Insiders, VSCodium, Zed, OpenAI, Claude, Gemini, Antigravity,
  OpenCode, GitHub Copilot, ACP Registry, Pi Agent).
- `/home/jc/projects/mesura-code/apps/web/src/components/JetBrainsIcons.tsx` — 12
  JetBrains IDE logos.
- These are a **curated, hardcoded** application-icon set. The provider map at
  `/home/jc/projects/mesura-code/apps/web/src/components/chat/providerIconUtils.ts:5-11`
  is the only lookup. Mesura Code never resolves an installed application's icon from
  the system. Read section 7 for why that matters.

### 1.5 What Mesura Code does NOT have

- No icon font. `grep` for `Material Symbols`, `material-icons` and `@font-face` in
  `/home/jc/projects/mesura-code/apps/web/src/index.css` returns nothing.
- No static SVG or PNG icon assets in `apps/web/public` beyond the four favicons.
- No XDG icon-theme lookup, no `.desktop` `Icon=` parsing, no `app.getFileIcon` call
  anywhere in `apps/web/src`, `apps/desktop/src` or `packages`. The Linux XDG code in
  `/home/jc/projects/mesura-code/apps/desktop/src/app/DesktopLinuxUrlHandler.ts`
  registers a URL scheme with `xdg-mime`; it resolves no icon.
- The desktop app icons (`icon.ico`, `icon.icns`, `icon.png`, resolved by
  `/home/jc/projects/mesura-code/apps/desktop/src/app/DesktopAssets.ts:96-133`) are
  product branding, not UI icons.

---

## 2. File-type icons — the mapping, in full

This is the piece the file manager needs most, so it is recorded completely.

### 2.1 The resolver

`createFileTreeIconResolver(icons)` at
`/home/jc/projects/mesura-code/apps/web/node_modules/@pierre/trees/dist/render/iconResolver.js:25`.
It is a **pure function factory**. It imports only `builtInIcons.js` and
`iconConfig.js`. It touches no DOM, no React and no preact. It returns one method:

```ts
resolveIcon(name: SVGSpriteNames, filePath?: string): FileTreeResolvedIcon
```

`FileTreeResolvedIcon` is `{ name, remappedFrom?, token?, width?, height?, viewBox? }`
(`render/iconResolver.d.ts:5-12`). `name` is a sprite symbol id. `token` is the
semantic class used for colour.

### 2.2 The resolution order

From `render/iconResolver.js:34-58`. The resolver only does file-type work when
`name === "file-tree-icon-file"` and a `filePath` is supplied.

1. Take the basename (`getBaseFileName`, `:6-8`), lowercase it.
2. **Custom `byFileName`** — exact basename match. First hit wins.
3. **Custom `byFileNameContains`** — substring match, in declaration order.
4. **Custom `byFileExtension`** — against the extension candidates.
5. **Built-in tokens** — `resolveBuiltInFileIconToken` (`builtInIcons.js:557`).
6. Otherwise, fall through to the `remap` table for the slot, else return the slot
   name unchanged.

**Extension candidates** (`getExtensionCandidates`, `render/iconResolver.js:9-14`):
split the lowercased basename on `.`, then emit every suffix from index 1 onward.
So `Button.spec.tsx` yields `["spec.tsx", "tsx"]` — longest first. This is how
compound keys such as `env.local` and `mdx.tsx` work. A basename with no dot, such as
`Dockerfile`, yields an **empty** candidate list and can only match by exact basename.

**Built-in token order** (`builtInIcons.js:557-575`):

1. `BUILT_IN_FILE_NAME_TOKENS[basename]` — **104** entries.
2. For each extension candidate, in order:
   - `COMPLETE_EXTENSION_OVERRIDES[candidate]` — **4** entries, applied only when
     `set === "complete"`: `jsx → react`, `tsx → react`, `sass → sass`, `scss → sass`.
   - `BUILT_IN_FILE_EXTENSION_TOKENS[candidate]` — **120** entries.
3. Return `"default"`.

The `standard` tier gates every hit through `STANDARD_TIER_TOKENS`
(`builtInIcons.js:522-546`, 23 tokens). The `minimal` and `none` tiers return
`undefined` immediately and do no file-type work at all.

### 2.3 The fallback behaviour

There are **three** distinct fallbacks, and they are easy to confuse.

1. **Inside the resolver** — `resolveBuiltInFileIconToken` never fails. An unknown
   extension returns the token `"default"`, which maps to the symbol
   `file-tree-builtin-default`. So the resolver always yields a drawable icon.
2. **`resolveIcon` returning the bare slot** — only when the icon set is `none` or
   `minimal`, or when the slot is not the file slot.
3. **In the application** —
   `/home/jc/projects/mesura-code/apps/web/src/pierre-icons.ts:96-102` returns `null`
   for `kind === "directory"` **before** calling the resolver.
   `PierreEntryIcon.tsx:73-79` turns that `null` into a lucide `FolderIcon`.

`hasSpecificPierreIconForFileName` (`pierre-icons.ts:104-106`) tests
`token !== "default"`. That is how `ChatMarkdown.tsx:597-599` decides whether a code
fence deserves a language icon.

### 2.4 The 53 built-in tokens

`astro babel bash biome bootstrap browserslist bun c claude cpp css database default
docker eslint font git go graphql html image javascript json markdown mcp nextjs npm
oxc postcss prettier python react ruby rust sass stylelint svelte svg svgo swift table
tailwind terraform text typescript vite vscode vue wasm webpack yml zig zip`

Declared as the type `BuiltInFileIconToken` at `dist/builtInIcons.d.ts:4`.

**Category coverage, read against a file manager's needs:**

| Category | Covered? | Tokens or gap |
|---|---|---|
| Source code | Yes, broadly | `typescript javascript react python rust go c cpp ruby swift zig vue svelte astro bash` |
| Config and tooling | Yes, deeply | `eslint prettier biome oxc stylelint babel webpack vite postcss tailwind bootstrap browserslist svgo docker terraform bun npm git nextjs vscode mcp claude` |
| Markup and data | Yes | `html css sass json yml markdown graphql svg wasm` |
| Images | One generic token | `image` (avif bmp gif ico icns jpeg jpg png tif tiff webp) |
| Archives | One generic token | `zip` (7z bz2 gz jar rar tar tgz war xz zip) |
| Spreadsheets and tables | One generic token | `table` (csv ods tsv xls xlsx) |
| Databases | Yes | `database` (db sql sqlite sqlite3) |
| Fonts | Yes | `font` (eot otf ttf woff woff2) |
| Plain text | Yes | `text` (AUTHORS CHANGELOG LICENSE cfg conf editorconfig env ini log rst rtf txt) |
| **Video** | **No token** | Falls to `default` |
| **Audio** | **No token** | Falls to `default` |
| **PDF** | **No token** | Falls to `default` |
| **Executable / binary** | **No token** | Falls to `default` |
| **Symlink** | **No token** | Not a file-type concept in this model |
| **Folder** | **No symbol at all** | See section 3 |

### 2.5 Colour

Each token carries a semantic colour. There are two independent implementations, and
a consumer picks one.

- **Inside the tree** — the shadow-DOM stylesheet
  (`@pierre/trees/dist/style.js`) declares 51 rules of the form
  `[data-icon-token='astro'] { color: var(--trees-file-icon-color-astro); }`.
- **Outside the tree** — `PierreEntryIcon.tsx:5-60` carries its own
  `ICON_COLORS` table: 57 tokens, each a `[light, dark]` pair of hex values. It sets
  `style={{ color: colors[theme === "light" ? 0 : 1] }}` at `:88`.

Both work because every symbol paints with `fill="currentColor"` and uses `opacity`
(and the `.bg` / `.fg` / `.fg-stroke` classes) to build two-tone art from one colour.
Verify with `builtInIcons.js:92-95` (`image`) or `:186-189` (`typescript`).

The T3 overlay sprite is the exception: 4 of its 6 symbols hardcode brand hex values
(`#c12127` for npm, `#007acc` for tsconfig, `#d97757` for Claude, `#b48a5a` for
readme). Those ignore `currentColor` and stay the same in both themes.

---

## 3. Folder, state and chrome icons

### 3.1 There is no folder icon

This is the single most surprising finding, and the file manager must plan for it.

`@pierre/trees` renders a directory row with the **chevron only**. See
`dist/render/FileTreeView.js:371`:

```js
children: row.kind === "directory"
  ? jsx(Icon, { ...resolveIcon("file-tree-icon-chevron") })
  : jsx(Icon, { ...resolveIcon("file-tree-icon-file", targetPath) })
```

The chevron rotates by CSS to show open versus closed. There is no open-folder and no
closed-folder glyph, and `set: "complete"` adds none.

Outside the tree, `PierreEntryIcon` substitutes lucide `FolderIcon`
(`PierreEntryIcon.tsx:74`). A Miller-column file manager, which shows folders as rows
next to files, therefore has to supply its own folder icon. Lucide has `folder`,
`folder-open`, `folder-symlink` and `folder-lock`; all four exist in 0.564.0.

### 3.2 The 5 chrome symbols

`builtInIcons.js:2-19`, the `minimal` sheet, present in every tier:

| Symbol id | Purpose | Viewbox |
|---|---|---|
| `file-tree-icon-chevron` | Expand / collapse, and the directory marker | 16 |
| `file-tree-icon-file` | Generic file, two-tone with a folded corner | 16 |
| `file-tree-icon-dot` | "A descendant has a git change" | 6 |
| `file-tree-icon-lock` | Locked / read-only row | 16 |
| `file-tree-icon-ellipsis` | Context-menu trigger | 16 |

Any of the four addressable slots can be replaced through the `remap` key of
`FileTreeIconConfig` (`dist/iconConfig.d.ts:15`). `file-tree-icon-ellipsis` is not in
the remappable list at `render/FileTreeView.js:327`.

### 3.3 Git status decorations are letters, not icons

`dist/utils/gitStatusPresentation.js`:

```js
const GIT_STATUS_LABEL = {
  added: "A", deleted: "D", ignored: null,
  modified: "M", renamed: "R", untracked: "U"
};
```

`getBuiltInGitStatusDecoration` (`render/FileTreeView.js:166-184`) renders that letter
plus a `title` attribute. When a **directory** contains a change but has no status of
its own, it renders `file-tree-icon-dot` at 6×6 instead. The row also carries
`data-item-git-status` (`render/rowAttributes.js:12`) so a host can style it.

**This matches the file manager exactly.** `GitStatusBadge.qml` renders
`status.char.charAt(0)` in a 16×16 rounded chip and is deliberately git-agnostic. The
two designs are the same design. The file manager's provider already emits
`M T A D R C ? U !`; Pierre's set is a subset of that.

### 3.4 Toolbar and chrome icons come from lucide

The closest analogue to the file manager's chrome is
`/home/jc/projects/mesura-code/apps/web/src/components/files/` and `.../preview/`,
which import 24 lucide icons: `ArrowLeft ArrowRight Camera ChevronRight Code2
ExternalLink Eye FolderTree Globe Globe2 History LoaderCircle Minus MoreVertical
MousePointer2 MousePointerClick PanelRightIcon PictureInPicture2 Plus RadioTower
RotateCcw RotateCw X XIcon`.

---

## 4. How icons are rendered

### 4.1 Two mechanisms

**Mechanism A — SVG sprite plus `<use>`, for file-type icons.**

`ensurePierreIconSprite()` (`pierre-icons.ts:109-121`) prepends one hidden container to
`document.body` holding both sprite strings. Every icon is then one small element:

```jsx
<svg aria-hidden="true" data-pierre-icon={icon.name} data-icon-token={icon.token}
     className="size-4 shrink-0" viewBox="0 0 16 16"
     style={{ color: ... }}>
  <use href={`#${icon.name}`} />
</svg>
```

(`PierreEntryIcon.tsx:82-94`.) The injection runs in `useInsertionEffect`, so the
symbols exist before the first paint. Inside the `<file-tree>` custom element the same
sprite is injected into the shadow root instead, because `<use href="#id">` does not
cross a shadow boundary.

**Mechanism B — React components, for chrome.** Lucide compiles each icon to a React
component that renders an inline `<svg>`.

### 4.2 Sizing

- Lucide's default is `24×24` with `viewBox="0 0 24 24"`
  (`lucide-react/dist/esm/defaultAttributes.js`). Mesura Code almost never uses that
  default; it overrides with a Tailwind `size-*` class.
- Measured frequency in `apps/web/src/components/chat`: `size-3` (12 px) 23 times,
  `size-3.5` (14 px) 21 times, `size-4` (16 px) 14 times.
- `PierreEntryIcon` defaults to `size-4` = **16 px**, matching the sprite's
  `viewBox="0 0 16 16"`. Treat 16 px as the file-row convention.
- The Pierre sprite art is drawn on a 16-unit grid; lucide is drawn on a 24-unit grid
  with `strokeWidth: 2`. Mixed at the same rendered size, lucide reads slightly
  lighter. That is the visual seam to watch.

### 4.3 Colour

- Lucide: `stroke="currentColor"`, `fill="none"`. It inherits.
- Pierre sprite: `fill="currentColor"` with `opacity` layers. It inherits.
- So **both sources inherit `currentColor`**, and a single CSS `color` drives an icon.
  Mesura Code exploits this with the `--color-icon-muted` token
  (`apps/web/src/index.css:168`), used as the class `text-icon-muted`.
- The exception is the 4 brand-coloured symbols of the T3 overlay sprite.

### 4.4 Accessibility

- Lucide adds `aria-hidden="true"` automatically unless the caller passes an a11y prop
  (`lucide-react/dist/esm/Icon.js`, the `hasA11yProp` guard). Icons are decorative by
  default, which is right when the row already carries its name as text.
- `PierreEntryIcon` hardcodes `aria-hidden="true"` on the `<svg>` (`:84`), and the
  sprite container also carries `aria-hidden` (`pierre-icons.ts:115`).
- Git status decorations carry a `title` string
  (`utils/gitStatusPresentation.js`, `GIT_STATUS_TITLE`), so the meaning of `M`
  reaches a screen reader.

---

## 5. Reusability from a separate repository

This is the decisive section. Each source is rated by how a repository outside this
monorepo consumes it.

| Source | Consumption | Drift risk |
|---|---|---|
| `lucide-react` 0.564.0 | **Public npm package.** `pnpm add lucide-react`. No relation to the fork. | None |
| `@pierre/trees` 1.0.0-beta.4 | **Public npm package.** `pnpm add @pierre/trees`. Published by the Pierre team, Apache-2.0, `latest` is `1.0.0-beta.6`. | None |
| `apps/web/src/pierre-icons.ts` | **Copy the file** (117 lines), or re-derive it. **Upstream-owned.** | Real — see below |
| `apps/web/src/components/chat/PierreEntryIcon.tsx` | **Copy the component** (94 lines). **Upstream-owned.** | Real |
| `Icons.tsx` / `JetBrainsIcons.tsx` | Copy individual components. **Upstream-owned.** | Low — these are static logos |
| `MesuraWordmark.tsx` | **Fork-owned**; branding only, not applicable | n/a |

### 5.1 Ownership check

Every icon file was tested against `upstream/main`:

```
apps/web/src/pierre-icons.ts                  upstream: YES   fork-modified: no
apps/web/src/components/Icons.tsx             upstream: YES   fork-modified: no
apps/web/src/components/chat/PierreEntryIcon.tsx  upstream: YES   fork-modified: no
apps/web/src/components/JetBrainsIcons.tsx    upstream: YES   fork-modified: no
apps/web/src/components/files/FileBrowserPanel.tsx upstream: YES fork-modified: no
apps/web/src/components/MesuraWordmark.tsx    upstream: NO
```

`pierre-icons.ts` was added by upstream commit `de8bdc10f` (Julius Marminge, "Add
workspace file browser and preview panel (#3087)").

**Consequence.** The entire icon system except the wordmark belongs to
`pingdotgg/t3code`. Mesura Code has changed none of it. If the file manager copies
`pierre-icons.ts` or `PierreEntryIcon.tsx`, it creates a **drift** problem, not a merge
conflict: upstream can add a token, change a colour or bump the `@pierre/trees` pin,
and the copy in a separate repository will not notice. Nothing will break; the two
products will simply stop looking the same.

**Mitigation.** Do not copy the two files verbatim as a permanent arrangement. Two
options, in order of preference:

1. **Depend on `@pierre/trees` directly and write a thin local resolver.** The public
   package gives `createFileTreeIconResolver` and `getBuiltInSpriteSheet`. Those two
   exports are the entire file-type icon system. `pierre-icons.ts` adds only the T3
   overlay sprite, the language-id alias table and three small helpers — about 60 lines
   of substance, none of it hard. Write the file manager's own version, with its own
   overlay sprite. Then upstream drift only affects icons the file manager chose not to
   adopt.
2. **Copy `pierre-icons.ts` and pin the `@pierre/trees` version identically**, and
   record in a comment that the file mirrors `t3code:apps/web/src/pierre-icons.ts`.
   Cheaper today, needs a periodic diff.

### 5.2 Import shape and bundle cost

`@pierre/trees` exposes four subpaths: `.`, `./react`, `./ssr`, `./web-components`
(package manifest, `exports`). `createFileTreeIconResolver` and
`getBuiltInSpriteSheet` are exported from the **root**, and the root index also
imports the whole `FileTree`. The manifest declares
`"sideEffects": ["./dist/components/web-components.js"]`, so a modern bundler
tree-shakes the tree renderer away when only the resolver is imported. Vite and
Rollup both honour this. If the file manager also uses `<FileTree>` for its tree view,
the question does not arise.

The resolver itself pulls in `builtInIcons.js` (47 KB source, of which the `complete`
sprite string is 37 919 bytes). That string is only injected into the DOM when
`getBuiltInSpriteSheet` is called, so it costs bundle size but no runtime work until
the first icon renders.

**The resolver is DOM-free and framework-free.** It runs in the Electron main process,
in a worker, and in Node tests, unchanged. Only `ensurePierreIconSprite` touches
`document`.

### 5.3 Licence obligations

- `lucide-react` — ISC. Reproduce the copyright notice and permission notice.
- `@pierre/trees` — Apache-2.0. Retain `LICENSE.md` and `NOTICE.md`; state any
  modification if the source is copied and changed.
- `@pierre/vscode-icons` — MIT, and not a runtime dependency.
- The T3 overlay sprite in `pierre-icons.ts` carries the t3code repository licence.
  The npm, TypeScript, Claude and pnpm marks in it are third-party trademarks; a
  redistribution of that file carries the same trademark exposure that t3code already
  accepts.

---

## 6. Coverage — what the file manager needs that Mesura Code does not have

### 6.1 The file manager's icon system today

Three sources, per the inventory of this repository:

1. **Material Symbols Rounded** glyphs, rendered as text through
   `qml/Symmetria/FileManager/UI/components/MaterialIcon.qml`. The font family is set
   at `qml/Symmetria/FileManager/UI/services/FmTheme.qml:73`.
2. **XDG icon-theme files on disk**, resolved in C++ and drawn by
   `Image { source: "file://" + iconPath }`.
3. **Raw Unicode characters and single letters** as micro-indicators.

There are **no SVG assets** in this repository. The only bitmap is
`assets/symmetria-fm.png`, the launcher icon.

The two modes already coexist. `qml/Symmetria/FileManager/UI/components/FileIcon.qml:22`
reads `Config.fileManager.iconMode`, declared at
`qml/Symmetria/FileManager/UI/config/FileManagerConfig.qml:5` as `"material" | "system"`
with `"system"` as the default. When the mode is `material`, or when the resolver
returned an empty path, the component falls back to a glyph (`FileIcon.qml:40-54`).

**So a curated icon set is not a new concept for this product. It is the existing
fallback mode, promoted to the only mode.**

### 6.2 The file-type fallback table is tiny

`qml/Symmetria/FileManager/UI/services/FileManagerService.qml:245-251`:

| Glyph | Concept |
|---|---|
| `article` | any `text/*` |
| `movie` | any `video/*` |
| `music_note` | audio |
| `picture_as_pdf` | `application/pdf` |
| `description` | catch-all |

Plus `folder` and `image`, branched at the call sites
(`FileListItem.qml:173-180`, `FileTreeRow.qml:112-118`).

That is **7 file-type concepts**. Pierre's `complete` set has 53. On code and config
files the Mesura set is a large upgrade. The four gaps below are the entire cost.

### 6.3 Gap table — file-type concepts

| Concept | File manager today | Pierre `complete` | Verdict |
|---|---|---|---|
| Directory | `folder` glyph + themed `folder` icon | **No symbol** | **Build** — use lucide `folder` / `folder-open` |
| Generic file | `description` | `default` | Covered |
| Text | `article` | `text` | Covered |
| Source code | `description` (no distinction) | 30+ language tokens | **Upgrade** |
| Config / tooling | `description` | 20+ tool tokens | **Upgrade** |
| Image | `image` | `image` | Covered |
| **Video** | `movie` | none | **Build** — lucide `file-video` |
| **Audio** | `music_note` | none | **Build** — lucide `file-audio` |
| **PDF** | `picture_as_pdf` | none | **Build** — lucide has no PDF icon; use `file-text` or draw one |
| Archive | `description` (no list icon) | `zip` | **Upgrade** |
| Spreadsheet | `description` (no list icon) | `table` | **Upgrade** |
| **Symlink** | `link` glyph in the metadata bar only | none | **Build** — lucide `file-symlink` / `folder-symlink` |
| **Executable** | no visual treatment at all | none | **Build**, or keep the current non-treatment |
| **Remote mount** | `lan` glyph | none | **Build** — lucide `network` or `hard-drive` |
| Hidden (dotfile) | no visual treatment | n/a | Unchanged |
| Permissions | plain mono text, no glyph | n/a | Unchanged |

Six new file-type icons, of which five exist in lucide and only the PDF mark needs a
decision.

### 6.4 Gap table — chrome, action and state icons

The file manager renders roughly **90 distinct Material glyphs** outside file types.
They fall into groups; lucide covers all of them. A representative mapping, with every
lucide name verified present in 0.564.0:

| Group | File manager glyphs | Lucide equivalents |
|---|---|---|
| Navigation | `arrow_back` `arrow_forward` `keyboard_arrow_down/up` `keyboard_double_arrow_down/up` `chevron_left/right` `subdirectory_arrow_left` `vertical_align_top/bottom` `unfold_more` `expand_more` | `arrow-left` `arrow-right` `chevron-down/up` `chevrons-down/up` `chevron-left/right` `corner-down-left` `arrow-up-to-line` `arrow-down-to-line` `chevrons-up-down` |
| Clipboard | `content_copy` `content_cut` `content_paste` `content_paste_go` | `copy` `scissors` `clipboard-paste` |
| Selection | `check_box` `deselect` | `square-check` `square-dashed` |
| File actions | `delete` `edit` `edit_note` `add` `drive_file_rename_outline` `refresh` `open_in_new` | `trash-2` `pencil` `file-pen` `plus` `pencil-line` `refresh-cw` `external-link` |
| Search and jump | `search` `manage_search` `bolt` `jump_to_element` `arrow_upward/downward` `history` | `search` `text-search` `zap` (no direct jump icon) `arrow-up/down` `history` |
| Sort | `sort` `sort_by_alpha` `schedule` `straighten` `extension` `format_list_numbered` `swap_vert` | `arrow-down-up` `arrow-down-a-z` `clock` `ruler` `puzzle` `list-ordered` `arrow-up-down` |
| View | `account_tree` `visibility` `visibility_off` `html` `rule` | `folder-tree` `eye` `eye-off` `code-2` `list-filter` |
| Archive | `unarchive` `inventory_2` `check_circle` | `package-open` `package` `circle-check` |
| Preview error / empty | `broken_image` `videocam_off` `music_off` `block` `grid_off` `folder_open` `device_hub` `hourglass_empty` | `image-off` `video-off` `volume-off` (**no `music-off`**) `ban` `grid-2x2-x` `folder-open` `network` `loader-circle` |
| Bookmarks | `home` `download` `description` `image` `screenshot_monitor` `video_library` `library_music` `desktop_windows` `settings` `bookmark` | `house` `download` `file-text` `image` `monitor` `film` `list-music` `monitor` `settings` `bookmark` |
| Chrome | `close` `help` `keyboard` `more_horiz` `apps` `link` `lan` `label` `explore` `play_arrow` `pause` `play_circle` | `x` `circle-help` `keyboard` `ellipsis` `layout-grid` `link` `network` `tag` `compass` `play` `pause` `circle-play` |

Only two names have no clean lucide equivalent: `jump_to_element` (the flash-jump
mode) and `music_off`. Both have adequate substitutes.

**Cut, yank and selection markers need nothing.** `IndicatorStrip.qml` is a 5 px
coloured bar, not an icon, and the design carries over unchanged.

**Git status needs nothing.** Both products render a letter in a chip. See §3.3.

---

## 7. The "Open With" case, and the last XDG need

### 7.1 Two XDG lookups exist today, not one

`IconThemeResolver` has three public entry points, and they serve two independent
purposes:

| Entry point | Source | Purpose |
|---|---|---|
| `resolveForFile(fileInfo, mimeType)` | `plugin/src/Symmetria/FileManager/Models/iconthemeresolver.cpp:284` | File and folder icon for a list row |
| `resolve(iconName)` | `iconthemeresolver.cpp:305` | The raw XDG name lookup that `resolveForFile` delegates to |
| `resolveApp(iconName)` | `iconthemeresolver.cpp:328` | Application icon from a `.desktop` `Icon=` value |

**Lookup 1 — file and folder icons.** `resolveForFile` walks the user's active theme
and its whole `Inherits` chain. The icon *name* comes from `QMimeDatabase`, so the
name space is unbounded. Consumed by every list row (`FileListItem.qml:171`), every
tree row (`FileTreeRow.qml:106`), the fuzzy finder (`fuzzyfinder.cpp:261`) and the
fallback preview card (`FallbackPreview.qml:21`).

**This lookup is exactly what a curated set replaces.** Adopting Mesura Code's icons
removes it in full.

**Lookup 2 — "Open With" application icons.** The application list is produced at
runtime by shelling out to `gio mime <mimetype>`
(`qml/Symmetria/FileManager/UI/modules/filemanager/ContextMenuPopup.qml:70-71`).
`AppIconProvider` then reads each entry's `Icon=` key from the real `.desktop` file
(`plugin/src/Symmetria/FileManager/Models/appiconprovider.cpp:53-75`) and resolves it
through `resolveApp`. The icon is rendered by
`OpenWithView.qml:152-161`, with a `MaterialIcon { text: "apps" }` fallback at
`:164-170`.

**A curated set cannot serve this lookup.** The icons belong to whatever the user has
installed. Mesura Code proves the point negatively: its own application icons are 34
hardcoded brand components, and adding a new editor means writing a new SVG by hand.
The file manager cannot do that, because it does not know the user's applications.

### 7.2 Confirmation: "Open With" is the ONLY remaining need

I checked for every other consumer of a system-resolved icon in this repository, and
found none.

- **Drive and device icons** — none exist. There is no mount or volume sidebar. The
  only device signal is the `lan` glyph for a remote mount
  (`FileListItem.qml:191`), which is a plain Material glyph and needs no XDG lookup.
- **Bookmark icons** — `BookmarkService.qml:53-77` is a hardcoded table of 9
  well-known directories plus a `bookmark` default. All Material glyphs, no XDG.
- **The trash** — `user-trash` appears only inside the places-versus-mimes router of
  `iconthemeresolver.cpp:234-237`. No caller asks for it; the file manager has no trash
  view.
- **The application's own icon** — `assets/symmetria-fm.png`, installed by the host
  build and bound through `QGuiApplication::setDesktopFileName("symmetria-fm")`. That
  is a desktop-entry contract, not an icon lookup.
- **Thumbnails** — image previews are decoded content, not icons, and there are no
  thumbnails in list rows.

**Verdict: yes. "Open With" is the only remaining need for XDG icon resolution.**

### 7.3 What the reduced resolver must keep

`resolveApp` alone, plus the machinery it needs. From
`docs/electron-transition/09-node-backend-capability-map.md:518-577` and my own read of
`iconthemeresolver.cpp:328-396`, the surviving logic is:

1. An **absolute** `Icon=` path is returned verbatim if the file exists. Steam and
   Flatpak entries use this.
2. A trailing `.png` / `.svg` / `.xpm` is stripped before the theme lookup, so a sloppy
   `Icon=foo.png` does not become `foo.png.svg`.
3. The active theme's `apps/` directories, and its `Inherits` chain, trying `.svg`,
   `.png`, `.xpm` in that order.
4. **`hicolor` explicitly**, even when the active theme does not declare it — most app
   icons live there.
5. `/usr/share/pixmaps/<stripped>{.png,.svg,.xpm}`, then the bare literal name last.
6. The hand-written INI parser, because `QSettings` mishandled long values and group
   names with spaces (`iconthemeresolver.cpp:72`), and a Node `ini` package has the
   same class of problem.
7. `.desktop` location by basename across `$XDG_DATA_HOME/applications` then each
   `$XDG_DATA_DIRS/applications`, including the dash-as-subdirectory XDG variant.
8. `Icon=` read **only** from the `[Desktop Entry]` group, ignoring
   `[Desktop Action …]` groups. Pinned today by
   `AppIconProviderTest::iconKeyInActionGroupIsIgnored`.

What can be **deleted**: `resolveForFile`, the MIME chain
(`iconName` → `genericIconName` → parent MIME types), the `mimes/` and `places/`
context routing, the `folder` special case, the places-versus-mimes fallback pass,
and the SVG-only restriction that applied to those. That is the larger half of the
398 lines.

### 7.4 Rendering an application icon in a renderer process

The icon is a real file on disk, so the renderer cannot load it with `file://` without
weakening `webSecurity`. Register a custom scheme instead:

```ts
protocol.handle("app-icon", (request) => { /* resolve, then serve the bytes */ });
```

This keeps the vector intact end to end, gives a natural cache point, and lets the
handler refuse any path outside the icon search paths.

Do **not** use `app.getFileIcon(path)` for this. It exists in Electron 41.5.0
(`node_modules/.pnpm/electron@41.5.0/.../electron.d.ts:1158`) and its own
documentation says that on Linux the icon "depends on the application associated with
file mime type". It returns a rasterised `NativeImage`, which is exactly the fidelity
loss the C++ was written to avoid, and it resolves a *file's* icon rather than an
arbitrary `.desktop` `Icon=` value.

---

## 8. Recommendation

### 8.1 Which icon source to adopt

Adopt **two** packages, with a clear division of labour.

1. **`@pierre/trees` for file-type icons.** The `complete` set, 53 tokens, is a large
   upgrade over the file manager's 7-concept table, it is the exact set the user
   prefers, its colours are already tuned for a dark UI, and it inherits
   `currentColor`.
2. **`lucide-react` for everything else** — chrome, actions, states, folders, and the
   six file-type gaps. It covers roughly 90 file-manager glyphs with two near-misses.

Reject the third source. `Icons.tsx` and `JetBrainsIcons.tsx` are product logos with
no file-manager use.

### 8.2 How to consume from a separate repository

```
pnpm add @pierre/trees@1.0.0-beta.4 lucide-react@^0.564.0
```

Both are public on the npm registry, both are permissively licensed, and neither is
tied to the fork.

Then write **one local module**, roughly 80 lines, modelled on `pierre-icons.ts` but
owned by this repository:

- Build the resolver once: `createFileTreeIconResolver({ set: "complete", colored: true, spriteSheet: FM_OVERLAY_SPRITE, byFileName: {...}, byFileExtension: {...} })`.
- Inject `getBuiltInSpriteSheet("complete") + FM_OVERLAY_SPRITE` into the document once.
- Export `resolveIconForEntry(path, kind)` returning `{ name, token } | null`.
- Own the token→colour table locally. Copy the shape of
  `PierreEntryIcon.tsx:5-60`, but resolve the values from the file manager's own
  `color-scheme.json` chain rather than hardcoding light/dark hex pairs.

Pin `@pierre/trees` to an exact version, as Mesura Code does. It is a beta package;
`1.0.0-beta.6` is already `latest`, so the pin is what keeps the two products
identical.

**Do not copy `pierre-icons.ts` or `PierreEntryIcon.tsx` verbatim.** Both are
upstream-owned by `pingdotgg/t3code` and unmodified by the fork, so a copy drifts
silently rather than conflicting loudly. Depend on the public package and write the
thin layer locally. Record the mirror relationship in a comment so a future agent can
diff against upstream deliberately.

### 8.3 What the file manager must build itself

| Item | Effort | Notes |
|---|---|---|
| Folder icon, open and closed | Trivial | `lucide` `folder` / `folder-open`. The Pierre set has none. |
| Video, audio, PDF, symlink, executable, remote-mount file icons | Small | Five come from lucide. The PDF mark needs a decision or a drawn glyph. |
| The `byFileName` / `byFileExtension` overlay sprite | Small | The file manager's own equivalent of the T3 sprite. Optional at first. |
| Token→colour table wired to `color-scheme.json` | Small | Keeps icons in step with the theme instead of hardcoding two hex ladders. |
| Chrome icon mapping, ~90 glyphs | Medium, mechanical | The mapping in §6.4 is the starting table. |
| `app-icon://` protocol handler | Small | Serves the resolved application icon bytes to the renderer. |
| Reduced XDG resolver for `resolveApp` | Medium | See §7.3. |

### 8.4 The verdict on `IconThemeResolver`

**It cannot be dropped entirely. It survives in a reduced form, and only for
"Open With".**

- **Drop**: `resolveForFile`, the `QMimeDatabase` icon-name chain, the `mimes/` and
  `places/` context routing, the `folder` special case, and the cross-context fallback
  pass. The curated set replaces all of it. This is the larger half of the 398 lines,
  and it removes the icon lookup from the hot path of every directory scan.
- **Keep**: `resolveApp` and its supports — the search-path list, the hand-written
  `index.theme` parser, the `Inherits` walk with its cycle guard, the scalable-first
  sort, the explicit `hicolor` pass, the `/usr/share/pixmaps` legacy fallback, and the
  `.desktop` locate-and-parse of `AppIconProvider`.
- **Also keep the negative-result cache.** A missing application icon must not re-probe
  the filesystem on every menu open.
- **Port target**: TypeScript in the main process, per
  `09-node-backend-capability-map.md:540`. Roughly half the original line count now
  that the MIME half is gone.

This is a real reduction in the hardest-to-port capability, and it is the direct
consequence of decision D8. Report 02 rated `IconThemeResolver` one of the three
hardest pieces to port. Adopting Mesura Code's icons cuts it in half and moves what
remains off the hot path, where a cache miss now costs one menu open rather than one
scroll frame.
