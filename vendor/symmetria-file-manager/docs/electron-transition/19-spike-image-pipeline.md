# Spike — the image pipeline, measured

Measurement spike run on 2026-08-25 to settle which image library the Electron
rewrite uses, whether `utilityProcess` isolation is affordable, and how many
thumbnails to decode at once. It extends report 18 §2 and §3 and corrects
report 14 §4.

Nothing appeared on the operator's screen. Every Electron run used `xvfb-run` on
a virtual X display with `--no-sandbox --ozone-platform=x11`. No repository was
modified; all scripts live in `/tmp/fm-spikes/img/`.

**The headline result changed the recommendation.** Report 18 recommended
"`sharp` in a `utilityProcess`". That combination does not run at all:
`sharp` **segfaults on its first decode inside an Electron `utilityProcess`**,
deterministically, and the parent never learns. Details in §4.

---

## 1. Method and environment

| Item | Value |
|---|---|
| Machine | AMD Ryzen AI 7 350, 16 hardware threads, 30 GB RAM |
| Kernel | Linux 7.2.0-rc1-1-mainline (Arch) |
| Node (plain-Node runs) | v26.7.0 |
| Electron | 41.5.0 — Chromium 146.0.7680.216, Node 24.15.0 |
| `sharp` | 0.35.3, libvips 8.18.3, `simd: true`, `sharp.concurrency()` default **1** |
| `@napi-rs/image` | 1.14.0 |
| ImageMagick | 7.1.2-29 |

**One operation** = read the file, decode it, resize to fit inside 256×256
preserving aspect ratio, encode PNG, return the bytes. PNG is the encode target
because the XDG thumbnail cache mandates PNG (report 14 §8). A second variant
("raw") stops after the resize and returns raw pixels, to separate decode+resize
cost from encode cost.

`@napi-rs/image`'s `resize(256)` sets the **width** only and leaves the height
free, so a portrait image comes out 256×455 — more work than `sharp`'s
`fit: "inside"`. Every measurement below uses
`resize({ width: 256, height: 256, fit: ResizeFit.Inside })`, which was verified
to produce byte-identical dimensions to `sharp`'s (144×256 for a 720×1280 input).
An early run that missed this made `@napi-rs/image` look worse than it is; those
numbers were discarded.

**Corpus** — 21 files in `/tmp/fm-spikes/img/corpus`, built from real files under
`/home/jc` plus format gaps filled with `magick`. The prior list at
`/tmp/fm-spikes/sharp/imgs.txt` held 8 photos only; it is extended here.

| File | Dimensions | Origin |
|---|---|---|
| `real0`–`real7` (.jpeg ×5, .png ×3) | 720×1280 … 1600×1292 | the 8 photos from `imgs.txt` |
| `photo.heic` | 4032×3024, 3.0 MB | `~/Downloads/IMG_5046.HEIC`, a real 12 MP iPhone photo |
| `still.avif` | 352×626 | real download |
| `still.webp` | 2400×422 | real download |
| `anim.gif` | 200×126, 2 frames | Symmetria Shell asset |
| `still-gif.gif` | 450×800, 1 frame | generated from `real0` |
| `anim.webp` | 200×126, 2 frames | generated from `anim.gif` |
| `still.tiff` | 900×1600, 4.3 MB | generated from `real0` |
| `still.jxl` | 675×1200 | generated from `real0` |
| `alpha.png` | 900×600, full alpha channel | generated gradient |
| `vector.svg` | 800×600 | hand-written |
| `still.bmp` | 720×370 | Unreal Engine splash |
| `small.ico` | 36×64 | generated from `real0` |
| `app.icns` | — | real macOS Chrome icon |
| `big.png` | 4928×3279, 19 MB | generated, to reproduce report 14 §4 |

**Common set** = the 13 files both libraries decode: `alpha.png`, `anim.webp`,
`real0`–`real7`, `still.avif`, `still.tiff`, `still.webp`. Every head-to-head
number uses this set, so the comparison is like-for-like.

**Statistics.** Each benchmark warms up with two full passes, then measures 20
passes over the set. Reported figures are medians over the per-image samples,
and each configuration ran 3 times end to end in a fresh process. Spread between
the 3 repeats was under 3 % for every throughput figure, so only the median
repeat is quoted.

---

## 2. Head to head — `sharp` 0.35.3 versus `@napi-rs/image` 1.14.0

Plain Node v26.7.0, common set, PNG encode, 260 operations per run, 3 repeats.

| Metric | `sharp` 0.35.3 | `@napi-rs/image` 1.14.0 | Winner |
|---|---:|---:|---|
| Cold `require()` | **47.5 ms** | **5.1 ms** | napi, 9.3× |
| Serial latency, median per image | **22.6 ms** | 31.9 ms | sharp, 1.41× |
| Serial throughput | **44.2 /s** | 31.4 /s | sharp, 1.41× |
| Throughput at concurrency 4 | **130.6 /s** | 92.0 /s | sharp, 1.42× |
| Peak RSS, sustained run | **272 MB** | 1957 MB | sharp, 7.2× |
| Peak RSS with forced GC pacing | 190 MB | 236 MB | tie (see below) |
| Installed size on disk | 19 MB (`sharp` + `@img/*`) | 17 MB (`@napi-rs/*`) | tie |

Decode + resize only, no encode (same runs, `raw` mode):

| Metric | `sharp` | `@napi-rs/image` |
|---|---:|---:|
| Serial latency, median | **20.0 ms** | 28.0 ms |
| Throughput at concurrency 4 | **142.5 /s** | 101.6 /s |
| Peak RSS | **223 MB** | 1651 MB |

The gap is the same with and without the encode, so it is a **decode and resize**
gap, not an encode gap.

### Per format, serial median milliseconds per image

| File | Input | `sharp` | `@napi-rs/image` |
|---|---|---:|---:|
| `still.tiff` | 900×1600 TIFF | **9.9** | 29.7 |
| `anim.webp` | 200×126 WebP | 9.6 | **5.3** |
| `real0.jpeg` | 720×1280 JPEG | **16.8** | 31.7 |
| `real4.png` | 960×678 PNG | **17.6** | 18.7 |
| `real5.png` | 960×868 PNG | **20.9** | 23.7 |
| `real3.jpeg` | 899×1599 JPEG | **21.7** | 49.6 |
| `still.avif` | 352×626 AVIF | **24.3** | 30.9 |
| `real7.jpeg` | 1600×1244 JPEG | **40.3** | 83.0 |
| `alpha.png` | 900×600 PNG + alpha | 40.3 | **19.5** |
| `real6.jpeg` | 1600×1292 JPEG | **42.9** | 83.2 |
| `still.webp` | 2400×422 WebP | **44.1** | 56.0 |
| `real2.png` | 1360×2286 PNG | **44.3** | 70.3 |

`sharp` wins every JPEG by roughly 2×, and wins TIFF by 3×. `@napi-rs/image`
wins two cases: small WebP and the alpha-channel PNG.

### ⚠ Correction to report 14 §4

Report 14 recorded `@napi-rs/image` at **348.6 ms** against `sharp`'s **444.9 ms**
on a 4928×3279 PNG downscale, i.e. napi 1.28× faster. **That does not
reproduce.** Measured here on `big.png`, exactly 4928×3279, 9 timed iterations
after 2 warm-ups:

| Library | 4928×3279 PNG → 256 px |
|---|---:|
| `sharp` 0.35.3 | **393.9 ms** (min 384.6, max 402.0) |
| `@napi-rs/image` 1.14.0 | **613.1 ms** (min 608.4, max 621.9) |

`sharp` is 1.56× faster, the opposite direction and a larger margin. The most
likely cause of the earlier result is the `resize` fit trap described in §1 —
a width-only resize of a landscape source is not the same work — but that is an
inference, not something this spike measured.

### 🚨 `@napi-rs/image` grows unboundedly without manual GC

This is the most consequential finding of §2, and it is documented nowhere.

Sustained run, concurrency 4, RSS sampled every 250 operations:

| Ops | 250 | 500 | 750 | 1000 | 1500 | 2000 | 2500 | 3000 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `sharp` RSS | 241 MB | 256 MB | 271 MB | 285 MB | 308 MB | 319 MB | 334 MB | **345 MB** |
| `@napi-rs/image` RSS | 846 MB | 1258 MB | 2292 MB | 2138 MB | 2487 MB | 4370 MB | 3758 MB | **4227 MB** |

`sharp` plateaus. `@napi-rs/image` reaches **4.2 GB and is still climbing**.

The memory is reclaimable, and the cause is visible in the numbers. Running
1200 operations under `node --expose-gc`:

| Configuration | RSS during the run | RSS after a forced `gc()` |
|---|---|---:|
| `@napi-rs/image`, no manual GC | 1103 → 2971 MB | 1553 MB |
| `@napi-rs/image`, `global.gc()` every 20 ops | **214 – 236 MB, flat** | **152 MB** |
| `sharp`, no manual GC | 169 – 190 MB, flat | 190 MB |

While `@napi-rs/image`'s RSS sat at 3 GB, `process.memoryUsage().external`
reported **9–42 MB**. The Rust-side allocations are never registered with V8's
external-memory accounting, so V8 feels no pressure and never schedules the
collection that would free them. `sharp` reports its buffers correctly and needs
no help.

**Consequence for a resident daemon:** using `@napi-rs/image` requires either an
explicit `global.gc()` cadence (which needs `--expose-gc`, i.e. `--js-flags`) or
a worker that gets recycled every N images. `sharp` needs neither.

---

## 3. Format support, measured on real files

Both libraries were handed each corpus file and asked for a 256 px PNG
thumbnail. The cell records what actually happened, not what the documentation
claims.

| Format | Test file | `sharp` 0.35.3 | `@napi-rs/image` 1.14.0 |
|---|---|---|---|
| JPEG | `real0/1/3/6/7.jpeg` | ✅ | ✅ |
| PNG | `real2/4/5.png` | ✅ | ✅ |
| PNG with alpha | `alpha.png` | ✅ | ✅ |
| WebP, still | `still.webp` | ✅ | ✅ |
| WebP, animated | `anim.webp` | ✅ — `pages: 2` with `{ animated: true }` | ✅ **first frame only**, no frame count |
| AVIF | `still.avif` | ✅ | ✅ |
| TIFF | `still.tiff` | ✅ | ✅ |
| SVG | `vector.svg` | ✅ from the same buffer API | ⚠ **only via `Transformer.fromSvg(string)`** — the normal constructor fails |
| **GIF, animated** | `anim.gif` | ✅ — `pages: 2` | ❌ `Decode image failed The image format Gif is not supported` |
| **GIF, still** | `still-gif.gif` | ✅ | ❌ same error |
| **HEIC** | `photo.heic`, 12 MP | ❌ `Input buffer has corrupt header: heif: Invalid input: Security limit exceeded: Number of references in iref box (48) exceeds the security limits of 16` | ❌ `HEIC decoding is only supported on macOS and Windows` |
| BMP | `still.bmp` | ❌ `Input buffer contains unsupported image format` | ✅ |
| ICO | `small.ico` | ❌ same | ✅ |
| **JPEG XL** | `still.jxl` | ❌ unsupported format | ❌ `The image format could not be determined` |
| **ICNS** | `app.icns` | ❌ unsupported format | ❌ `The image format could not be determined` |

**Report 14's two claims about `@napi-rs/image` are both confirmed**, on real
files, with the verbatim errors above:

1. **HEIC fails on Linux.** The message names the platform limitation directly.
2. **GIF cannot be decoded at all** — animated *or* still. The error is a
   compile-time feature gap, not a file problem, and it is documented nowhere.

Three further findings this spike adds:

3. **`@napi-rs/image` cannot decode SVG through its normal entry point.**
   `new Transformer(svgBuffer)` fails with "The image format could not be
   determined". `Transformer.fromSvg(svgString)` works and produced a correct
   256×192 PNG. Any router must special-case SVG by extension or MIME before
   reaching the decoder.
4. **`sharp` cannot decode BMP or ICO; `@napi-rs/image` can.** `sharp.format`
   confirms the input list is exactly `jpeg png webp tiff gif svg heif raw` —
   no `bmp`, no `ico`, no `jxl`. This is the mirror image of the GIF gap and is
   equally undocumented in report 14.
5. **`@napi-rs/image`'s `metadataSync()` IS a reliable capability probe.** It
   failed on exactly the files whose decode failed, and succeeded on every file
   that decoded. Report 14 §3 warns that `sharp`'s `metadata()` is *not* such a
   probe. That warning could not be re-tested on this HEIC file, because
   `sharp`'s `metadata()` also fails here — the 12 MP photo trips libheif's
   `iref` reference-count guard during header parsing, before any pixel work.
   Report 14's warning therefore stands unrefuted but also unconfirmed; treat it
   as still true and always probe with a real decode.

**Neither library covers the long tail.** HEIC, JPEG XL, ICNS and RAW need the
`magick` / `heif-convert` / `exiftool` routes report 14 §5–§7 already chose.
Report 18 §3 measured those: `magick` does a 12 MP HEIC → 512 px thumbnail in
0.37–0.39 s and `heif-convert` in 0.23–0.28 s. Nothing here changes that plan.

---

## 4. 🚨 `utilityProcess` isolation — the recommendation does not run

### 4.1 The finding

**`sharp` segfaults on its first decode inside an Electron `utilityProcess`.**
Reproduced on every attempt, across four independently written harnesses.

The failure is silent from the parent's point of view. What the parent observes:

- the child forks and reports ready normally;
- `require("sharp")` succeeds and reports libvips 8.18.3;
- the first request produces **no reply, no `error` event and no `exit` event**;
- the child process remains listed and looks alive.

Even `sharp(buf).metadata()` — the cheapest operation in the library — never
resolves. The child's event loop stops entirely: it never logs receipt of the
next message.

### 4.2 It is a crash, not a hang

`/proc/<child>/status` during the stall:

```
State:        I (idle)
CoreDumping:  1
Threads:      20
```

Every thread is parked except one `libuv-worker`, which is in `R`. The kernel is
writing a core dump. When `gdb` attaches, it reports
`Unable to attach: program terminated with signal SIGSEGV, Segmentation fault`,
and the parent's `exit` event finally fires with **code 139** (128 + SIGSEGV) —
about 57 s after the request, once the core write completes.

**This is report 14 §3's documented bug firing.** That report describes
"intermittent SIGTRAP and segfaults in `sharp::OpenInput` on a libuv worker
thread", caused by Electron's Linux binaries leaking global GLib symbols. Two
corrections to how it was recorded:

- In the `utilityProcess` it is **not intermittent**. It is 100 % reproducible on
  the first decode.
- Report 18 concluded the bug "did not reproduce" after 8000 decodes. That
  conclusion was correct **for the process it tested** — the Electron main
  process, where a real GTK window has initialised the GLib type system. The
  `utilityProcess` maps `libgtk-3.so`, `libglib-2.0.so`, `libgobject-2.0.so` and
  `libgio-2.0.so` (verified in `/proc/<pid>/maps`) but never initialises them.
  That difference is the most plausible explanation, and it is an **inference**;
  this spike did not obtain a symbolised stack.

### 4.3 No configuration knob fixes it

Each mode was run to completion and produced an identical stall:

| Mode | Result |
|---|---|
| default | SIGSEGV |
| `UV_THREADPOOL_SIZE=1` | SIGSEGV |
| `UV_THREADPOOL_SIZE=16` | SIGSEGV |
| `VIPS_CONCURRENCY=1` | SIGSEGV |
| `sharp.concurrency(1)` | SIGSEGV |

The `UV_THREADPOOL_SIZE=1` workaround report 14 mentions does not apply here.

### 4.4 Which combinations do run

Each cell is a real run: spawn, one request, 10 warm-up requests, then 60 timed
requests. Electron 41.5.0 under Xvfb with a real `BrowserWindow` open.

| Isolation mechanism | `sharp` 0.35.3 | `@napi-rs/image` 1.14.0 |
|---|---|---|
| Electron **main process** | ✅ 25.0 ms/image | ✅ 34.4 ms/image |
| **`utilityProcess`** | ❌ **SIGSEGV on the first decode** | ✅ 35.9 ms/image |
| **`worker_threads` Worker** in the main process | ✅ **25.5 ms/image** | ✅ 36.5 ms/image |
| `child_process.fork` with `ELECTRON_RUN_AS_NODE=1` | ❌ **SIGSEGV on the first decode** | ✅ 36.7 ms/image |

`sharp` survives only where the GTK-initialised main process's address space is
shared — the main process itself and a `worker_threads` Worker inside it.

**`sharp` in a `worker_threads` Worker is stable.** A soak of **1500 decodes at
8 in flight** inside an Electron main process with a live `BrowserWindow`
completed **1500 ok, 0 failures**, at 181.1 images/second, main-process RSS
363 MB.

### 4.5 The isolation overhead itself is cheap

Measured against decoding the identical images in the process that owns the
worker, 130 timed operations each, medians.

| Path | In-process | Isolated | Overhead per image |
|---|---:|---:|---:|
| `@napi-rs/image`, main → `utilityProcess` | 34.39 ms | 35.87 ms | **+1.48 ms (+4.3 %)** |
| `sharp`, main → `worker_threads` | 24.98 ms | 25.46 ms | **+0.48 ms (+1.9 %)** |

The message hop itself is far cheaper than that. An empty request-and-reply
round trip, 3000 samples:

| Channel | Median | p95 |
|---|---:|---:|
| `utilityProcess` `parentPort` | **0.053 ms** | 0.086 ms |
| `worker_threads` `parentPort` | **0.017 ms** | — |

So of the 1.48 ms `utilityProcess` overhead, only about 0.05 ms is the hop. The
rest is the payload copy plus scheduling.

**Startup cost**, `fork()` to the worker's first message, 7 spawns each:

| Mechanism | Median | Range |
|---|---:|---|
| `utilityProcess` | **150.1 ms** | 146.4 – 155.8 ms |
| `worker_threads` Worker | **73.5 ms** | 70.5 – 84.7 ms |

Both are one-time costs for a resident worker, and both are well under the
window-open budget.

### 4.6 The transfer list buys nothing — the payload is always copied

The child allocates an `ArrayBuffer` and posts it back, once with
`postMessage(msg, [ab])` and once without. 13 timed iterations each, medians.

| Payload | With transfer list | Structured clone | Transfer rate |
|---|---:|---:|---:|
| 4 KB | 0.10 ms | 0.08 ms | 41 MB/s |
| 64 KB | 0.25 ms | 0.23 ms | 252 MB/s |
| 1 MB | 2.19 ms | 2.27 ms | 457 MB/s |
| 8 MB | 20.81 ms | 21.49 ms | 384 MB/s |
| 64 MB | 160.61 ms | 156.46 ms | 398 MB/s |
| 256 MB | 607.65 ms | 605.79 ms | 421 MB/s |

**The two columns are identical at every size.** Cost is strictly linear in bytes
at roughly **400 MB/s**, which is a memory copy, not a handle move. Passing an
`ArrayBuffer` in the transfer list across a `utilityProcess` boundary is **not
zero-copy**.

Three related facts about the channel, each measured:

- **The parent → child direction rejects `ArrayBuffer` transfers outright**:
  `child.postMessage({ ab }, [ab])` throws
  `Port at index 0 is not a valid port`. Only `MessagePortMain` objects are
  accepted there. The child → parent direction silently accepts the list and
  copies anyway.
- **A Node `Buffer` arrives as a plain `Uint8Array`.** The prototype does not
  survive the structured clone. Any receiver that calls `.toString("base64")` or
  another `Buffer` method will break.
- **`MessageChannelMain` is not available inside a `utilityProcess`** —
  `require("electron").MessageChannelMain` is `undefined` there, so the
  documented "transfer a port" escape hatch cannot be built from the child side.

**Design consequence.** A 256 px PNG thumbnail is 30–120 KB, so the copy costs
0.1–0.3 ms and is irrelevant. Never ship **raw pixels** across the boundary: a
4032×3024 RGBA frame is 48 MB and would cost roughly 120 ms in copies alone.
Encode inside the worker and send the compressed bytes.

### 4.7 Killing a worker mid-decode is clean

`SIGKILL` sent to a `utilityProcess` that was busy in a 60-second spin:

| Observation | Result |
|---|---|
| Parent survived | **yes** |
| `exit` event latency after `SIGKILL` | **8 ms** |
| Exit code reported | 9 (SIGKILL) |
| The in-flight request | settled by the parent's own `exit` handler |
| Parent still decodes afterwards | yes, 22.5 ms — unchanged |
| Respawn time | **175.2 ms** |
| Respawned worker serves requests | yes, with a different pid |

This is exactly the behaviour the isolation design wants, **for a clean kill**.

⚠ **It is not the behaviour for the `sharp` segfault.** There the child enters
`CoreDumping` and the `exit` event is delayed by about 57 s. A supervisor that
relies only on `exit` will hang a request for the best part of a minute.
**Every request to an image worker needs its own timeout**, and the supervisor
must be able to kill and respawn a worker that has missed its deadline, without
waiting for `exit`.

### 4.8 Isolation costs no throughput

| Configuration | Images/second | RSS |
|---|---:|---|
| `@napi-rs/image`, main process, concurrency 4 | 83.0 | — |
| `@napi-rs/image`, 1 `utilityProcess` | 22.3 | 431 MB |
| `@napi-rs/image`, 2 `utilityProcess` | 43.0 | 789 MB total |
| `@napi-rs/image`, 4 `utilityProcess` | **82.4** | 1528 MB total |
| `sharp`, main process, concurrency 4 | **119.9** | — |

Four workers match the in-process figure almost exactly (82.4 versus 83.0), so
process isolation costs **no throughput**, only memory. It scales linearly:
22.3 → 43.0 → 82.4 across 1, 2 and 4 workers.

---

## 5. Concurrency shape

Measured for `sharp`, the winner. `sharp` runs its work on the **libuv
threadpool**, so `UV_THREADPOOL_SIZE` is the governing knob. It must be set in
the environment before the pool is first used.

### 5.1 Plain Node, common set, 600 operations per point

Throughput (images/second), and p50 / p95 per-image latency:

| Concurrency | `UV_THREADPOOL_SIZE` unset (4) | =8 | =16 | =32 |
|---|---|---|---|---|
| 1 | 34.3 · 24 / 50 ms | — | — | — |
| 2 | 67.6 · 25 / 52 ms | — | — | — |
| 4 | 138.9 · 24 / 50 ms | 135.7 · 24 / 51 | 145.7 · 23 / 46 | 145.9 · 22 / 46 |
| 8 | 145.2 · 49 / 78 ms | 225.8 · 30 / 61 | **245.6 · 27 / 56** | 243.5 · 28 / 55 |
| 16 | 145.2 · 104 / 132 ms | 230.7 · 66 / 100 | **310.1 · 48 / 83** | 305.6 · 48 / 84 |
| 24 | 140.8 · 166 / 201 ms | 245.7 · 94 / 124 | 311.1 · 73 / 112 | 302.3 · 76 / 118 |
| 32 | 140.0 · 225 / 264 ms | 246.1 · 126 / 155 | 295.1 · 104 / 143 | 301.9 · 102 / 160 |

Three conclusions.

1. **`UV_THREADPOOL_SIZE` matters, and the default cripples `sharp`.** At the
   libuv default of 4 threads, throughput caps at **145 /s** no matter how many
   requests are in flight. Raising it to 16 more than doubles the ceiling to
   **310 /s**.
2. **Diminishing returns arrive at `UV_THREADPOOL_SIZE = 16`**, this machine's
   hardware-thread count. Going to 32 gains nothing (306 versus 310) and costs
   RSS (543 MB versus 478 MB).
3. **Past concurrency = threadpool size, throughput is flat and latency grows
   linearly.** That is pure queueing: the extra requests wait. Requesting 32
   thumbnails at once at `UV_THREADPOOL_SIZE=16` triples p50 latency (104 ms
   versus 48 ms) and returns 5 % *fewer* images per second.

**`sharp.concurrency()` — the libvips per-operation thread count, default 1 —
is not a useful knob.** At `UV_THREADPOOL_SIZE=16`:

| `sharp.concurrency()` | conc 8 | conc 16 |
|---|---:|---:|
| 1 (default) | 232.5 /s | **291.4 /s** |
| 2 | 239.4 /s | 263.8 /s |
| 4 | 221.3 /s | 271.8 /s |

Leave it alone. Parallelism belongs at the request level, not inside libvips.

### 5.2 The same sweep inside the Electron main process

Run under Xvfb with a live `BrowserWindow`, 400 operations per point. The shape
holds; the absolute numbers are 30–40 % lower, which is the cost of sharing a
process with Chromium.

| Concurrency | `UV_THREADPOOL_SIZE` unset (4) | `UV_THREADPOOL_SIZE=16` |
|---|---|---|
| 1 | 32.1 /s · 27 / 50 ms | 32.5 /s · 26 / 51 ms |
| 2 | 62.2 /s · 27 / 54 ms | 57.8 /s · 31 / 58 ms |
| 4 | 113.2 /s · 31 / 59 ms | 109.2 /s · 32 / 62 ms |
| 8 | 116.3 /s · 67 / 100 ms | **173.1 /s · 42 / 78 ms** |
| 16 | 122.1 /s · 128 / 156 ms | 195.1 /s · 77 / 126 ms |
| 24 | 119.7 /s · 199 / 240 ms | 205.6 /s · 112 / 161 ms |

This also reconciles report 18's figure. Report 18 measured 178.8 /s for `sharp`
in Electron with a `BrowserWindow` at `UV_THREADPOOL_SIZE=16`; this sweep gives
173.1 /s at concurrency 8 and 195.1 /s at concurrency 16, on a larger and harder
image set. The two agree.

### 5.3 Recommended setting

**`UV_THREADPOOL_SIZE = 16` (the hardware-thread count), and at most 8 decodes in
flight.**

Concurrency 8 rather than 16 because a file manager pays for latency, not for
peak throughput. At concurrency 8 the first thumbnails land in 42 ms (p50) and
the grid fills at 173 /s; at 16 the p50 nearly doubles to 77 ms for 13 % more
throughput. A grid the user is looking at should fill visibly-first, and a
screenful is 20–40 tiles — one to two batches.

---

## 6. Recommendation

### 6.1 Library: `sharp` 0.35.3

`sharp` wins on every metric that matters to a resident file manager:

- 1.41× faster on the common set, 1.56× faster on a 19 MB PNG;
- flat memory instead of unbounded growth;
- decodes GIF and animated GIF, which `@napi-rs/image` cannot decode at all;
- reads SVG through the same API as everything else.

`@napi-rs/image` wins only on cold `require()` (5 ms versus 48 ms — irrelevant
once, at daemon start) and on BMP/ICO, which `magick` covers anyway.

### 6.2 Isolation: **`worker_threads`, not `utilityProcess`**

This reverses report 18's recommendation, on measurement.

- `utilityProcess` + `sharp` **does not run**. It segfaults on the first decode,
  every time, and no configuration knob avoids it.
- `worker_threads` + `sharp` runs, costs **+0.48 ms per image (+1.9 %)**, starts
  in **73.5 ms**, and completed a **1500-decode soak with zero failures**.

**Yes, make isolation the default** — the overhead is under 2 % and it keeps the
decode off the thread that paints the window. But understand what it buys and
what it does not:

| Property | `worker_threads` | `utilityProcess` |
|---|---|---|
| Runs `sharp` | ✅ | ❌ |
| Keeps decoding off the UI thread | ✅ | ✅ |
| Survives a native **crash** in the worker | ❌ — a SIGSEGV kills the whole process | ✅ |
| Startup | 73.5 ms | 150.1 ms |
| Per-image overhead | +0.48 ms | +1.48 ms |

A `worker_threads` Worker shares the address space, so it does **not** give crash
isolation. That was the original reason report 18 wanted a `utilityProcess`, and
it is precisely the thing that cannot be had together with `sharp` today. The
honest position: **take the thread isolation now, accept that a `sharp` crash
still takes the app down, and note that report 18's 8000-decode run plus this
spike's 1500-decode soak found zero crashes in the main process's address
space.**

### 6.3 Concurrency

- Set `UV_THREADPOOL_SIZE=16` in the daemon's environment, before Node starts.
- Cap in-flight decodes at **8**.
- Leave `sharp.concurrency()` at its default of 1.
- Prioritise the visible rows; queue the rest.

### 6.4 Rules the measurements impose on the worker protocol

1. **Every request gets its own timeout.** A `sharp` segfault does not produce a
   timely `exit` event; the process sits in `CoreDumping` for about 57 s. Do not
   rely on `exit` alone to fail a request.
2. **Send compressed bytes, never raw pixels.** The channel copies at ~400 MB/s
   in both directions, transfer list or not. A 30–120 KB PNG costs 0.1–0.3 ms;
   a 48 MB RGBA frame would cost ~120 ms.
3. **Do not expect a `Buffer` to arrive as a `Buffer`.** It arrives as a
   `Uint8Array`.
4. **The worker should read the file itself.** Sending a path costs one small
   message; sending the file bytes costs a copy of the whole file.

### 6.5 Fallback plan

Layered, in the order to reach for them:

1. **If `sharp` starts crashing in the main process** — move to
   `@napi-rs/image` in a `utilityProcess`, which is measured to work at
   82.4 images/second across 4 workers. Costs: no GIF, no HEIC, SVG through a
   separate entry point, 1.4× slower, and a mandatory `global.gc()` cadence or
   worker recycling to contain RSS. Route GIF through `magick`.
2. **If `@napi-rs/image`'s memory behaviour proves unmanageable** — run
   `magick` as a subprocess for everything Chromium cannot decode natively, and
   let Chromium decode the rest. Report 14 §9 already argues for this shape, and
   report 18 measured `magick` at 0.37–0.39 s for a 12 MP HEIC. It is a process,
   so it cannot crash the app.
3. **Long-term** — the upstream fix is a statically linked libvips
   (https://github.com/lovell/sharp/issues/4522). If that ships,
   `utilityProcess` + `sharp` becomes available and the crash-isolation gap in
   §6.2 closes. Re-run §4.4 when it does.

---

## 7. Caveats — read these before quoting any number

- **One machine.** AMD Ryzen AI 7 350, 16 threads, 30 GB RAM, Arch Linux,
  kernel 7.2.0-rc1. Nothing here has been reproduced on other hardware, other
  glibc versions, or other GLib versions. The `sharp` crash in particular is a
  GLib-interaction bug, so a different GLib may behave differently.
- **One Electron version.** 41.5.0. Electron 44 and 45 ship newer Chromium and
  Node; the crash may change.
- **Warm page cache throughout.** Every file was read repeatedly. A cold cache
  or a network mount will be much slower, and the decode/IO ratio will shift.
- **One image set, 21 files.** Real photographs and generated files from one
  user's home directory. It is not a benchmark corpus, and the per-format table
  rests on one to five files per format.
- **The operator's desktop was in use throughout.** Runs were serialised to avoid
  contention, but background load from the live session was not controlled.
  Repeat-to-repeat spread was under 3 %, which suggests the effect is small.
- **The `sharp` crash root cause is an inference.** What is *measured* is
  SIGSEGV, on the first decode, deterministic, in a `utilityProcess` and in an
  `ELECTRON_RUN_AS_NODE` child, absent in the main process and in
  `worker_threads`. The GLib-initialisation explanation matches report 14's
  upstream issue but was not proved here — no symbolised stack was obtained,
  because `gdb` could not attach to the crashing process before Crashpad
  released it.
- **`@napi-rs/image` got a fairness advantage in §4.8.** Its `utilityProcess`
  workers ran with `--expose-gc` and called `global.gc()` every 20 operations.
  Without that its RSS would be far higher. `sharp` needed no such help
  anywhere.
- **Report 18's `sharp`-under-Electron survival result stands and is
  strengthened** — 8000 decodes there, plus 1500 more here in a
  `worker_threads` Worker with a live `BrowserWindow`, all in the main process's
  address space, zero failures. The crash is specific to processes that map GLib
  without initialising it.

---

## 8. Corrections this spike makes to earlier reports

| Report | Claim | Correction |
|---|---|---|
| 18 §2 | "Run image work in a **`utilityProcess`**, so a crash kills a worker rather than the application" | `sharp` **cannot run** in a `utilityProcess` — deterministic SIGSEGV on the first decode. Use `worker_threads`, which costs +1.9 % and works, but gives no crash isolation. |
| 18 §2 | "the crash did **not** reproduce" | Correct for the Electron **main process**. It reproduces 100 % of the time in a `utilityProcess` and in an `ELECTRON_RUN_AS_NODE` child. |
| 14 §4 | `@napi-rs/image` 348.6 ms beats `sharp` 444.9 ms on a 4928×3279 PNG downscale | Does not reproduce. Measured `sharp` **393.9 ms**, `@napi-rs/image` **613.1 ms** — `sharp` 1.56× faster. |
| 14 §4 | `@napi-rs/image`: "HEIC returns *only supported on macOS and Windows*", "GIF decode fails" | **Both confirmed** on real files, with the verbatim errors. |
| 14 §4 | `@napi-rs/image` is "the leading alternative" | Still true, but it has two further gaps report 14 missed: it cannot decode SVG through its normal entry point, and its RSS grows without bound (4.2 GB over 3000 operations) unless GC is paced manually. |
| 14 §9 | "Downscale and thumbnail generation — **undecided**" | Decided: **`sharp` 0.35.3**, in a `worker_threads` Worker, `UV_THREADPOOL_SIZE=16`, 8 decodes in flight. |
| — | new | `sharp` cannot decode **BMP** or **ICO**; its input format list is exactly `jpeg png webp tiff gif svg heif raw`. |
| — | new | `utilityProcess` `postMessage` transfer lists **do not** make `ArrayBuffer`s zero-copy; the payload is copied at ~400 MB/s in either mode, and the parent → child direction rejects the transfer list outright. |
