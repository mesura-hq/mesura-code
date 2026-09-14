# Syntax highlighting — measured, and it overrides report 09

Report 09 chose `shiki`, and flagged that its syntax-highlighting section rested
on its own verification because a research agent had not reported in time. That
agent reported afterwards, **with benchmarks run on this machine**. Where this
document and report 09 disagree, this one wins: it measured.

No published head-to-head benchmark of these engines on large files exists. The
table below is original measurement — Node v26.7.0, this Arch box, one corpus of
concatenated real JavaScript, explicit language (never auto-detect).

## 1. The benchmark

| Engine | 4.05 MB | Throughput | 1 MB | 100 KB |
|---|---|---|---|---|
| **Lezer** (`@lezer/highlight` `highlightTree`, headless) | **1139 ms** | **3.56 MB/s** | 354 ms | 56 ms |
| `highlight.js` 11.12.0 (explicit language) | 1673 ms | 2.42 MB/s | 447 ms | 63 ms |
| Prism 1.30.0 | 1610 ms | 2.52 MB/s | 470 ms | — |
| `tree-sitter` WASM (parse + highlights query) | 1987 ms | 2.04 MB/s | 493 ms | 86 ms |
| **Shiki 4.4.3** oniguruma → HTML | **9600 ms** | 0.42 MB/s | 2182 ms | 211 ms |
| Shiki 4.4.3 oniguruma → tokens | 8209 ms | 0.49 MB/s | 1823 ms | 486 ms |
| **Shiki 4.4.3 JS engine** → tokens | **17434 ms** | 0.23 MB/s | 3921 ms | 1031 ms |

Three consequences that change the design.

**1. Shiki's JavaScript regex engine is 2.1× SLOWER than the Oniguruma WASM**, not
faster. The documentation's "faster for some languages" does not hold for
JavaScript. The JS engine is a **bundle-size lever, not a speed lever**:
~39 KB gzip against ~234 KB.

**2. Shiki's output explodes.** Token JSON is **9× the input** (36.5 MB from
4 MB); HTML is 5× (20.8 MB). That memory, not the CPU, is what kills a preview
pane.

**3. Truncation fixes everything.** Highlighting only the first N lines of the
4 MB file:

| Lines | Bytes | Shiki | `highlight.js` |
|---|---|---|---|
| 2000 | 64 KB | **156 ms** | **55 ms** |
| 5000 | 153 KB | 341 ms | 98 ms |

**A preview pane never needs the whole file.** This single fact makes the engine
choice much less load-bearing than the raw throughput suggests.

**Never call `highlightAuto`.** Measured: 1688 ms on a 50 KB slice — about 35× the
explicit-language cost — **and it misdetected JavaScript as `dns`**. A file
manager always knows the extension.

Shiki cold start is cheap and is not a concern: `import('shiki')` 42 ms,
`createHighlighter` with one language and one theme 45 ms.

The real blow-up axis is **line length, not file length**. Both Shiki engines
apply regexes line by line, so a minified single-line file is the worst case.

https://github.com/shikijs/shiki/issues/893

## 2. Language coverage, corrected

Report 09 recorded "~400 KSyntaxHighlighting definitions drop to ~200 Shiki
grammars". Both halves were wrong.

| Engine | Real count |
|---|---|
| KSyntaxHighlighting (installed, 6.28.1) | **407 distinct language names**, 458 installed XML files, 10 MB total |
| Shiki | **360 grammar modules**; `bundle/full` registers **242 language IDs**, `bundle/web` 57; 65 themes |
| `highlight.js` 11.12.0 | **193** total, **36** in `lib/common`, 82 CSS themes |
| CodeMirror `language-data` | 143 listed — but **110 are legacy CM5 stream parsers**; only ~33 have real Lezer grammars |
| Monaco 0.56.0 | 81 Monarch grammars |
| `tree-sitter` best maintained bundle | **112 grammars, 133 MB**; only ~66 npm packages ship a `.wasm` at all |

Two notes that matter for shipping. Shiki's grammars come from `tm-grammars` and
**their licences vary, including GPL-3.0** (for example `ada`) — relevant if the
app is redistributed. And Lezer's weakness is hidden: its coverage looks like 143
until you notice 110 entries are the old CM5 regex tokenizers, roughly
`highlight.js`-grade rather than TextMate-grade.

## 3. tree-sitter — ruled out, but for different reasons than first recorded

A third agent investigated tree-sitter specifically and **corrected two claims**
made from the first pass. Both corrections make tree-sitter look *better*; the
verdict still holds, on better grounds.

**Correction 1 — the ABI break is avoidable, not inherent.** The failure was
`tree-sitter-wasms@0.1.13`, built with `tree-sitter-cli` 0.20.x, which upstream
issue #5171 names explicitly as incompatible with `web-tree-sitter` 0.26.x. A
*current* bundle behaves: `tree-sitter-wasm@1.1.6` (112 languages) loaded
**112 of 112** under `web-tree-sitter@0.26.13`. The lesson is that grammar WASM
lags the runtime and version skew is a hard failure — not that the stack is
broken.

**Correction 2 — performance is a non-issue.** Measured on this machine:

- WASM parses within **~10% of native** (1 MB JavaScript: 233 ms WASM against
  203 ms native).
- **No long-line pathology.** The same 512 KB of minified JavaScript as one line
  versus split into 16,256 lines differed by 3.5%. Scaling is linear, not
  quadratic. The editor pathologies come from injections and per-line machinery
  layered on top, which a read-only pane does not have.
- End to end (`parse` + `Query.captures`) runs at **~2 MB/s**, and 6.3 ms for a
  4 KB file. `Query.captures` costs about 2× the parse.
- Native bindings **no longer need `electron-rebuild`** — N-API plus prebuildify
  since 2024, six platform triples shipped.

**What actually rules it out** is coverage and cost of ownership:

| | KSyntaxHighlighting | Best tree-sitter bundle |
|---|---|---|
| Languages | **407 distinct** (458 installed files) | **112** |
| Payload | **10 MB**, one `.so` | **133 MB**, avg 1,219 KB per grammar |
| Per-language build steps | zero | a pipeline |

Only ~66 npm grammar packages ship a prebuilt `.wasm` at all. Nothing in the
ecosystem reaches 400 languages — nvim-treesitter has 323, Helix 341.

Three further costs:

1. **Capture names are explicitly not standardised.** Across the 112 bundled
   query files there are **186 distinct capture names, 93 used by exactly one
   language**. The same grammar highlights differently in Neovim (Python: 50
   captures), Helix (35) and upstream (17). Zed filed this against itself.
2. **10 of the 112 `highlights.scm` files fail to compile** even in a curated
   bundle — three-argument `#set!`, Neovim-only `#is?`, and queries written
   against a different grammar revision.
3. **A leaked tree kills the WASM module irrecoverably.** Trees allocated in the
   WASM heap are not freed by JavaScript garbage collection. Reproduced: parsing
   a 13.7 MB file repeatedly without `tree.delete()` aborted at iteration 7 with
   `Aborted()`, and **every later correctly-written loop in the same process
   aborted immediately** — the module stays dead until the renderer reloads.
   There is a related open upstream issue on unbounded growth (#5547).

Two Electron notes worth keeping even though tree-sitter is out, because they
generalise: **Chromium blocks WebAssembly under a CSP without
`'wasm-unsafe-eval'`**, and Electron's own security guide recommends
`script-src 'self'` without mentioning WASM — following it verbatim breaks any
WASM decoder or highlighter.

**Ruled out** for this project.

## 4. Converting the Wine theme

The file manager's theme is a KSyntaxHighlighting `.theme` JSON that deliberately
mirrors the user's NeoVim Lush colorscheme. The KDE enum was read from the
installed header, not from documentation: **31 text styles**, `Normal = 0` …
`Others = 30`, plus 28 `EditorColorRole` values.

`/usr/include/KF6/KSyntaxHighlighting/KSyntaxHighlighting/theme.h`

**Conversion difficulty, easiest first:**

1. **`highlight.js`** — the theme *is* a stylesheet of `.hljs-*` rules. Generating
   it is a script. Lossiness is at the scope level: ~40 flat scopes.
2. **Lezer `HighlightStyle`** — maps onto a fixed, small, semantic tag set that is
   **much closer to KDE's 31 styles than TextMate scopes are**. This makes
   KDE → Lezer *easier* than KDE → TextMate.
3. **Monaco Monarch `rules[]`** — token names, not scopes.
4. **TextMate / Shiki** — the most work, and the mapping is genuinely lossy.

**No canonical KDE ↔ TextMate mapping exists.** KDE's own `utils/` only converts
old Kate KConfig schemas. The only prior art runs the opposite direction
(`vscode-theme-converter`). The best empirical anchor is that KDE ships hand-made
ports of VS Code themes (`data/themes/github-dark.theme`), so diffing that
against `primer/github-vscode-theme` yields an observed mapping. A full
31-row KDE-style → TextMate-scope table with confidence ratings is in the source
research; the three traps worth stating here:

- `BuiltIn`, `Extension` and `DataType` all want `support.*` — split by depth, and
  rule order matters.
- **`Operator` must claim `punctuation.*`** or the output looks flat, because KDE
  folds delimiters into `dsOperator` and TextMate does not.
- `Annotation`, `CommentVar`, `RegionMarker`, `Information` and `Alert` have **no
  canonical TextMate home**. Drop those rules rather than invent scopes.

**Four silent-failure traps in the KDE `.theme` format itself**, all confirmed
against a real file and the loader source (`themedata.cpp`):

1. **`strike-through` (KDE, hyphenated) → `strikethrough` (TextMate, one word).**
2. **Qt `#AARRGGBB` → CSS `#RRGGBBAA`.** The byte order is opposite.
3. **`read-only` is not a JSON key.** `isReadOnly()` derives from filesystem
   permissions. Do not emit it.
4. **`metadata` must stay flat.** The loader finds it by a raw byte scan to the
   first `}`, so a nested object truncates the parse and the theme silently fails
   to load.

And one on the Shiki side: **`normalizeTheme()` silently substitutes VS Code's
grey defaults** (`#bbbbbb` / `#1e1e1e`) unless the generated theme carries either
a leading scope-less rule with fg/bg, or `colors["editor.foreground"]` and
`["editor.background"]`.

## 5. Revised recommendation

Report 09 chose `shiki`, and its strongest argument still stands: **Shiki is
already a direct dependency of Mesura Code** through `@pierre/diffs`, which
already runs it in a worker pool. But the measurements add three qualifications
report 09 could not make, and they point somewhere else for the preview pane.

**Recommended: `highlight.js` with a generated Wine stylesheet, hard-truncated.**

- Cheapest to ship (~43 KB gzip for 36 languages), cheapest to theme (the
  conversion is a script), and 2.42 MB/s measured.
- **It has no size guards at all** — no document limit, no line-length guard.
  Grepping the source finds only `MAX_KEYWORD_HITS`, which caps a *relevance*
  score. One documented pathological case: a 4-line JavaScript banner comment
  took ~5 seconds. So the wrapper is mandatory: cap the byte count, truncate to
  ~2000 lines, and run it off the main thread.
- Always pass the language. Never `highlightAuto`.

**Reuse, do not duplicate, the existing `@pierre/diffs` Shiki worker pool** for
the diff and review surfaces, where it is already paid for and already correct.

**Keep Lezer's headless `highlightCode()` / `highlightTree()` in reserve.** It was
the fastest thing measured, and its tag set maps onto KDE's 31 styles more
naturally than anything else. Its ~33 real grammars are the blocker, not its
design. If the language set the user actually opens turns out to be small, this
becomes the best option rather than the reserve one.

**Monaco is out.** ~580 KB gzip of JavaScript plus 115 KB of CSS before any
language, 99 MB unpacked, and for a 5 MB file it tokenises the whole document
from line 1 on the main thread. A read-only viewer buys nothing from it.

**tree-sitter is out**, for the coverage and ABI reasons in §3.
