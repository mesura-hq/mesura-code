# Image decoding, RAW, ICNS and the XDG thumbnail cache

This document also overrides report 09, which chose `sharp` for image work. Two
research agents measured this area on this machine. Their findings change the
recommendation and surface one blocker report 09 did not know about.

## 1. What Chromium decodes on Linux, definitively

The authoritative source is Blink's format sniffer, not a documentation page.
The decoder directories that exist in Blink today are: **avif, bmp, gif, ico,
jpeg, jxl, png, webp**. That list is the answer.

https://github.com/chromium/chromium/tree/main/third_party/blink/renderer/platform/image-decoders

| Format | Chromium on Linux |
|---|---|
| JPEG, PNG (incl. **APNG** since Chrome 59), GIF, BMP | ✅ |
| WebP — still **and animated** | ✅ |
| **AVIF** — still **and animated** | ✅ since Chrome 85 |
| ICO / CUR | ✅ — the decoder holds **both** BMP readers and PNG decoders, so both entry codings work |
| SVG | ✅ via the SVG document pipeline, not a raster decoder |
| **JPEG XL** | ⚠ **back, behind a flag** — see §2 |
| **HEIC / HEIF** | ❌ no decoder, no sniffer branch |
| **TIFF** | ❌ Safari only |
| JPEG 2000, TGA, PPM, XBM, QOI | ❌ |

**HEIC is confirmed absent with no path in sight.** `caniuse` shows Chrome 4–154
all unsupported; licensing is the stated blocker. A W3C meeting on 2026-03-26
agreed only to form a Community Group.

## 2. Correction: JPEG XL came back

Report 09 worked from the premise that JPEG XL was removed in Chrome 110. That is
out of date.

- **December 2025** — `jxl-rs`, a pure-Rust decoder from the official libjxl
  organisation, was merged into Chromium, chosen over C++ libjxl for memory
  safety.
- **Chrome 145, released 2026-02-10**, ships it behind
  `chrome://flags/#enable-jxl-image-format`. **Off by default.**
- As of Chrome 150–154 (August 2026) it is still flag-gated. The sniffer requires
  **both** `BUILDFLAG(ENABLE_JXL_DECODER)` and the `kJXLImageFormat` feature.
- Electron 44 is Chromium 152 and Electron 45 is Chromium 156. Both contain the
  decoder.

**So try `app.commandLine.appendSwitch('enable-features', 'JXLImageFormat')`
before shipping any JavaScript JXL decoder.** If a decoder is still needed, the
measured winner is **`jxl-oxide-wasm@0.12.6`** (662 ms for 12 MP, works in Node
with no ceremony, actively maintained) over `@jsquash/jxl@1.3.0` (1697 ms, and
its default import **fails in the Electron main process** with `fetch failed`
because the glue resolves the `.wasm` by URL).

## 3. 🚨 The blocker: `sharp` on Electron + Linux

Report 09 chose `sharp`. **`sharp@0.35.3` emits a warning on every Electron start
on Linux**, from its own source:

```js
if (sharp && process.versions.electron && runtimePlatform.startsWith("linux")) {
  process.emitWarning("Binaries provided by Electron for use on Linux may be
    incompatible with sharp", { code: "SharpElectronLinux" });
}
```

Cause: Electron's Linux binaries dynamically link a global `glib` and leak its
symbols, producing `GLib-GObject: g_object_ref: assertion 'G_IS_OBJECT (object)'
failed` and **intermittent SIGTRAP and segfaults in `sharp::OpenInput` on a libuv
worker thread**.

**Status: open and unfixed.** `RTLD_DEEPBIND` and `-Wl,-Bgroup` were both tried
and failed. The libvips co-maintainer, 2026-07-08: *"the only way to fix this in
sharp is to statically link libvips… which does have licensing implications."*
Every workaround is bad — `UV_THREADPOOL_SIZE=1` serialises every decode, pinning
`sharp@0.33.5` freezes the dependency, and the WASM fallback did not clear it for
one reporter.

https://github.com/lovell/sharp/issues/4522
https://github.com/electron/electron/issues/46323

**This must be prototyped before `sharp` is committed to.** It can invalidate the
choice on its own.

### What `sharp` can and cannot do anyway

Measured by running `sharp.format` on a clean install here: jpeg, png, webp, gif,
tiff, svg (input, via librsvg), heif (container) — and **jp2 ✗, jxl ✗, pdf ✗,
raw ✗**, all disabled in the libvips build.

**HEIC specifically fails.** libheif 1.23.1 is compiled in but with
`-DWITH_LIBDE265=0 -DWITH_X265=0 -DENABLE_PLUGIN_LOADING=0`. AVIF works, HEIC does
not. Measured: `sharp(heic).png()` fails with `source: bad seek to 1024`.

⚠ **`metadata()` is not a capability probe.** It succeeds on a HEIC file and
reports `compression: 'hevc'` for a file `sharp` cannot render. Probe with a real
decode.

The maintainer's reason for the codec exclusion: *"I've been advised that the
current download counts of sharp might incur licensing fees of around US$25m/year."*

## 4. The alternatives, measured

`@napi-rs/image@1.14.0` — **no GLib collision, because it links no glib at all.**
Node-API, no rebuild, and the repo has a first-class Electron smoke test.
Measured on this box: TIFF ✅, WebP ✅, AVIF ✅, and **348.6 ms/op against sharp's
444.9 ms/op** on a 4928×3279 PNG downscale. But: **HEIC returns
`HEIC decoding is only supported on macOS and Windows`** (it delegates to system
frameworks and ships no HEVC codec), **GIF decode fails** with `The image format
Gif is not supported` — the feature is not enabled in `Cargo.toml` and **this is
documented nowhere** — and there is no RAW and no animation support.

`jimp@1.6.1` — pure JavaScript, immune to every ASAR, rebuild and GLib problem,
but BMP/GIF/PNG/JPEG/TIFF only and about 26× slower than `sharp`.

`wasm-vips@0.0.18` — libvips 8.18.3 in WASM. **Cannot decode HEIC either**;
libheif is built `-DWITH_LIBDE265=OFF`, present only for AVIF. Needs
`SharedArrayBuffer`, so a browser context must be cross-origin isolated. Its own
benchmark: `sharp` is 3.9× faster on JPEG, 1.9× on PNG, at parity on WebP.

`@squoosh/lib` is **dead** (last publish 2023-01-03).

## 5. HEIC: nothing in Node decodes it on Linux without pain

| Option | 1280×854 | 12 MP | Size |
|---|---|---|---|
| native libheif 1.23.1 + libde265 (system C) | 150 ms | **230 ms** | — |
| `libheif-js/wasm-bundle` 1.19.8 | 129 ms | **337 ms** | 6.4 MB |
| `libheif-js` default entry (pure JS asm.js) | 300 ms | 650 ms | 6.4 MB |
| **`@discourse/heic@1.0.0`** | 128 ms | 419 ms | **1.04 MB** |
| `magick` shell-out (incl. process spawn) | — | **610–720 ms** | system |

⚠ **The two research agents disagree on the WASM figure.** One measured
`libheif-js` full RGBA at 1794–4589 ms for a 12 MP file; the other measured
337 ms for the same class of file with `wasm-bundle`. The likely cause is the
entry point — the default `require('libheif-js')` is the **pure-JS asm.js build**,
kept only for backwards compatibility. **Never use the default entry.** Treat the
figure as unresolved and measure it once, in the real app, before deciding.

Four findings that matter more than the timing:

1. **`@discourse/heic@1.0.0` (2026-05-07) is the best option** and is new enough
   that report 09 could not have known it. It is Discourse's published build of
   the still-unmerged jSquash PR #101, at **one sixth the install size** of
   `libheif-js` with a clean `decode(ArrayBuffer) → ImageData` promise API.
2. **`libheif-js` cannot decode AVIF, and fails silently.** It is built with
   `ENABLE_AOM=0`. `decode()` *succeeds*, returns the correct dimensions parsed
   from the container, and then `display()` returns `null`. A naive "did it
   throw?" check passes and you get a null image later.
3. **`libheif-js/wasm` has a packaging bug that will bite in Electron**: it does
   `fs.readFileSync('./libheif-wasm/libheif.wasm')`, a **cwd-relative** path. Use
   `wasm-bundle` instead.
4. `libheif-js` wraps libheif **1.19.8** while upstream is at 1.23.1 — about a
   year behind.

**ImageMagick shell-out deserves serious consideration.** On this machine
`magick` 7.1.2-29 has LibRaw 0.22.2, libheif 1.23.1 and libjxl 0.12.0 compiled
in. One shell-out covers **everything Chromium cannot decode** — HEIC, RAW, TIFF,
JXL, JP2, PSD, PDF, EXR — at 0.6 s for a 12 MP HEIC, which beats the WASM route.
Its one gap is **ICNS**, because libicns is not linked.

## 6. RAW: extract the embedded preview — it is what every desktop does

All three Linux desktop thumbnailers were read, and none of them demosaics:

- **XFCE / Tumbler** calls `or_gdkpixbuf_extract_rotated_thumbnail()` from
  libopenraw.
- **KDE / kimageformats** calls `LoadTHUMB()` first, scans `imgdata.thumbs_list`
  for the **largest** embedded thumbnail, and only falls back to a full
  `LoadRAW()` if that fails — and even then sets `half_size`.
- **GNOME** ships no RAW loader in gdk-pixbuf; libopenraw provides one.

**Recommended: `exiftool-vendored@37.2.0`.** It is the most actively maintained
package in this whole research effort (repo last pushed 2026-08-08, **zero open
issues**), vendors ExifTool 13.59.2 for Linux with no system dependency beyond
perl, keeps a persistent `-stay_open` process pool, and publishes **20+
files/second/thread**. The API is exactly the right shape:

```js
await exiftool.extractThumbnail(path, out);
await exiftool.extractPreview(path, out);      // larger
await exiftool.extractJpgFromRaw(path, out);   // full-size embedded JPEG
```

The output is a JPEG that Chromium renders natively. ⚠ The tag name varies by
vendor — try `JpgFromRaw`, fall back to `PreviewImage`, then `OtherImage`.

**There is no maintained JavaScript library that extracts the full-size embedded
RAW preview without a full decode.** `exifr` is popular but dormant (last publish
2021), does not claim the classic RAW formats, and its `thumbnail()` returns the
tiny IFD1 thumbnail rather than the full-size preview. `libraw-wasm@1.6.0` is
alive but always pays for a full demosaic and exposes no preview extractor.

For the rare file with no embedded preview, do what Tumbler does: report failure.

## 7. ICNS: write the parser, do not install one

### 🚨 Security finding

**`icns-lib@1.0.1` hangs the event loop forever on a malformed ICNS.** Its parse
loop advances the cursor by a chunk's declared size, so a chunk declaring
`size = 0` never advances. An 80-byte crafted buffer was verified to hang until
killed at 6 seconds.

This is **the same bug class as CVE-2025-71330** in `image-size` ≤ 2.0.2 — "ICNS
parser allows denial of service through an infinite loop", CVSS 7.5–8.7, **no fix
available**.

https://github.com/advisories/GHSA-w3rx-r6r6-pgpr

`@fiahfy/icns` does not hang on that input, but it does not validate either — it
reported "9 images" parsed out of 64 zero bytes.

**A file manager parses attacker-controlled files.** Write the ~40-line chunk
walker, with `if (size < 8) break`.

### The extraction strategy

Neither library decodes pixels; they only split the container. That is fine,
because the modern subtypes are PNG-wrapped:

| OSType | Encoding | Chromium renders the extracted bytes? |
|---|---|---|
| `ic07`, `ic11`–`ic14`, `icp4`–`icp6` | PNG **or JPEG 2000** | only if PNG — sniff the magic |
| `ic08`, `ic09`, `ic10` | JPEG 2000 in 10.5-era files, PNG in modern ones | only if PNG |
| `ic04`, `ic05`, `icsb`, `icsB` | raw ARGB after a 4-byte `"ARGB"` header | no — trivial to shuffle by hand |
| `is32`, `il32`, `ih32`, `it32` + `s8mk`, `l8mk`, `h8mk`, `t8mk` | 24-bit RGB, PackBits-style RLE, plus separate 8-bit mask | no — ~60 lines |
| classic indexed types | 1/4/8-bit, Mac palettes | no — pre-OS-X, ignore |

**Strategy: walk the container, prefer the largest entry whose payload starts
with the PNG magic `89 50 4E 47`, and hand those bytes straight to an `<img>`.**
Fall back to `ic04`/`ic05`, then to the RLE pair. Give up on JPEG 2000 entries —
Chromium has never supported JP2, and `sharp`'s prebuild has `jp2: false`.

## 8. The XDG thumbnail cache — read it before generating anything

**Spec: Thumbnail Managing Standard 0.9.0, December 2020.** The canonical URL is
now `https://specifications.freedesktop.org/thumbnail/latest/`; the older
`thumbnail-spec` URL 301-redirects. ⚠ The spec's own title block still says
"Version 0.8.0, May 2012" while its history section records 0.9.0 — trust the
history.

| Directory | Max size |
|---|---|
| `$XDG_CACHE_HOME/thumbnails/normal` | 128×128 |
| `.../large` | 256×256 |
| `.../x-large` | 512×512 |
| `.../xx-large` | 1024×1024 |
| `.../fail/<appname>-<version>/` | empty PNGs recording failures |

Sizes are a **bounding box** — preserve the aspect ratio. Files are 8-bit
non-interlaced PNG with full alpha. Directories 0700, files 0600. Write to a temp
file **in the same directory**, then `rename()`.

**Naming: MD5 of the absolute canonical URI, hex, plus `.png`. Hash the URI
string, not the file contents.**

### 🚨 Two gotchas that will silently break a reader

**One — real producers write `zTXt`, not `tEXt`.** Qt's PNG writer compresses any
text value of **40 characters or more** into a `zTXt` chunk. A `file:///home/...`
URI is almost always longer than that, so **every KDE-written thumbnail stores
`Thumb::URI` and `Software` zlib-compressed**. Measured on this machine's cache:
`normal/` had 85 `zTXt` against 8 `tEXt`. A `tEXt`-only parser sees no
`Thumb::URI` and regenerates every one of those thumbnails forever. **Handle
`tEXt`, `zTXt` and `iTXt`.**

**Two — the URI escape set is not what Node produces.** GLib, Qt and Node agree on
14 of 16 test paths and disagree on two characters:

| Path | GLib (GNOME, Tumbler) | Qt (KDE) | Node `pathToFileURL` |
|---|---|---|---|
| `a;b.png` | `a%3Bb.png` | `a;b.png` ✗ | `a;b.png` ✗ |
| `a~b.png` | `a~b.png` | `a~b.png` | `a%7Eb.png` ✗ |

**Use the GLib rule** — keep `A-Za-z0-9` plus `! $ & ' ( ) * + , - . / : = @ _ ~`
and percent-escape every other byte as uppercase hex, UTF-8 bytes individually.
`encodeURI()` is worse still: it leaves `#` and `?` unescaped, which corrupts the
URI outright.

Verification: re-hashing every entry in this machine's real cache reproduced the
filename for **1554 of 1554 files, zero mismatches**.

### The cache really is shared — proven on this machine

Walking `~/.cache/thumbnails` and reading the `Software` key out of every PNG:

| Directory | Count | Producers |
|---|---|---|
| `normal/` | 93 | KDE ×89, unknown 4 |
| `large/` | 142 | KDE ×142 |
| **`x-large/`** | **1319** | **GNOME::ThumbnailFactory ×1253 + KDE ×66** |
| `fail/` | — | subdirectories `blender/` and `gnome-thumbnail-factory/` |

**1253 GNOME-written and 66 KDE-written thumbnails coexist in one directory**, all
validating under the same rule. Three independent ecosystems share one cache. The
forum claims that "Dolphin ignores the standard" are out of date — KIO gained an
explicitly spec-referencing `ThumbnailCache` module in 2026.

**So: read the existing cache before generating anything.** For a large share of
the user's files a thumbnail already exists, and writing ours back benefits
Nautilus, Dolphin and Thunar too. Use `fail/symmetria-fm-<version>/` for failures.

Validity check, verbatim from the spec — note that `file.mtime > thumb.MTime` is
explicitly **not** sufficient, because a restored older file would slip through:

```
if ((!thumb.isShared && !isSet(thumb.MTime)) ||
    (isSet(thumb.MTime) && file.mtime != thumb.MTime) ||
    (isSet(thumb.Size)  && file.size  != thumb.Size))
  recreate_thumbnail();
```

Two divergences to tolerate when reading: KDE inflates the tier by
`devicePixelRatio` (a 128 px request on a HiDPI display lands in `large/` at
256 px), and the top-level `~/.cache/thumbnails` on this machine is mode 0755,
not the mandated 0700.

**The one npm package implementing the spec, `thumbnail-manager@1.1.1`, uses
`png-chunks-extract` and will therefore almost certainly miss KDE's zTXt
`Thumb::URI`.** Write the ~150 lines instead. The spec is small; only the escape
set and the zTXt decoding need care, and both are settled above.

## 9. Revised recommendation for the image pipeline

| Layer | Choice |
|---|---|
| JPEG, PNG, APNG, GIF, WebP, AVIF, BMP, ICO, SVG | **Chromium, natively.** No library, no decode step, animation for free |
| JPEG XL | Try `enable-features=JXLImageFormat` first; `jxl-oxide-wasm` only if that fails |
| HEIC / HEIF | `@discourse/heic` (1 MB) — or `magick` shell-out, which is faster and covers more |
| RAW | `exiftool-vendored.extractPreview()` / `extractJpgFromRaw()` |
| ICNS | A hand-written chunk walker, extracting the largest PNG entry |
| TIFF, JP2, PSD, PDF-as-image | `magick` shell-out |
| Downscale and thumbnail generation | **Undecided — `sharp` is blocked on the Electron GLib bug.** `@napi-rs/image` is the leading alternative, at the cost of no HEIC and no GIF decode |
| Thumbnail cache | The XDG shared cache: read first, write back, own the ~150 lines |

**The shape that emerges is different from report 09's.** Rather than one image
library, the design is: **let Chromium do everything it can, shell out to
`magick` for the long tail, and keep the one native module decision open until
the `sharp` GLib bug is prototyped.** That also reduces the native-module budget
rather than raising it — `magick` is a process, not a linked library, so it
cannot crash the app.
