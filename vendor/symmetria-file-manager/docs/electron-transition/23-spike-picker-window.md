# 23 — Spike: what a picker window costs

**Question.** Should a save dialog get a **fresh** window per request, or should
one hidden window be kept **warm** and reused?

**Answer, in the unit the instrument actually measures: warm takes 2 frames,
every single time. Fresh takes 4 to 7, and which one you get varies by run.**

The recommendation is still **fresh**, but on architecture alone — the speed
evidence now favours warm more clearly than the first two versions of this
document admitted, and this is a judgement worth making deliberately rather than
reading off a table. See *The recommendation, and why it is not settled*.

## Everything here is quantised to a frame, and that is the whole finding

`app/bench/pickerWindow.mjs` measures request-to-paint with a double
`requestAnimationFrame`. **`requestAnimationFrame` fires on the compositor's
frame clock, so a duration measured this way cannot land between two frames** —
however long the work underneath really took, the number that comes out is a
multiple of ~16.7 ms.

Every figure ever produced by this harness, across twelve runs, divides cleanly:

| measurement | ms | frames | whose run |
|---|---:|---:|---|
| warm p50 | 32.2–32.7 | **1.94–1.96 → 2** | every run, both of us |
| warm p95 | 33.1–35.1 | **1.99–2.11 → 2** | every run, both of us |
| fresh p50 | 66.1 | **3.97 → 4** | verification's reruns |
| fresh p50 | 82.5 | **4.95 → 5** | both |
| fresh p50 | 115.6 | **6.94 → 7** | the author's fourth frame-reporting run |
| fresh p95 | 83.0–132.7 | **4.98–7.96 → 5 to 8** | both |

**Each figure is attributed on purpose.** An earlier version of this table listed
`115.6` among the p50 examples without saying where it came from, and 115.6 also
appears in verification's own report as a *p95* — so a reader checking the
evidence against that report found the same number under a different label.
Verification caught it. It is a genuine p50, from the author's fourth run of the
frame-reporting harness, and in a document whose whole purpose is to be checkable
that needed saying rather than assuming.

**This was missed twice, and it is why this document has had three sets of
numbers.** Version one read a single run as the answer. Version two treated a
17 ms swing as instability the harness had introduced, "fixed" it, and claimed a
0.6 ms spread from three runs that happened to land in the same mode.
Verification re-ran it five times, got 82.5, 66.2, 66.1, 66.2, 82.7, and called
the claim broken. Dividing by 16.7 explained all of it at once: **those are
5, 4, 4, 4 and 5 frames.** They were never noisy measurements of one value; they
are exact measurements of two adjacent frame counts.

**Sub-frame differences in this data mean nothing.** Reporting 82.5 against 66.2
as though the 16 ms between them described a property of the strategy — which
both earlier versions did — was reading the instrument's resolution as signal.

## The measurement

Under `xvfb-run` on 2026-09-01. Electron 41.5.0, Chromium 146.0.7680.216. Sixty
iterations per strategy per run, first discarded, inside an already-warm process
with a resident window painted. The two strategies are interleaved and alternate
order each iteration, and `destroy()` is awaited — both corrections came from
review, and both were right even though neither explained the bimodality.

| | p50 | p95 |
|---|---|---|
| **warm** — one hidden window, shown and hidden | **2 frames**, in all twelve runs | **2 frames**, in all twelve runs |
| **fresh** — created and destroyed per request | **4, 5 or 7 frames**, varying by run | **5 to 8 frames** |

Warm did not vary once. Not across twelve runs, not between p50 and p95.

## Reading it against the bar

The inherited target is **p50 under 60 ms, p95 under 120 ms** — under 4 frames
and under 8 frames respectively.

- **Warm clears both with a frame to spare at p50 and six at p95.**
- **Fresh misses p50 in every run** (4 frames at its best is 66 ms) and reaches
  the p95 bar in its worst run (8 frames is 133 ms).

**That bar was derived for the BROWSE window and this is not that** — a picker
arrives after a click in another application, behind a portal round trip and a
D-Bus hop that already cost something. But that is an argument, not a second
measurement, and the portal round trip is measured nowhere in this repository.

## The recommendation, and why it is not settled

**Build the picker with a fresh window per request — on architecture, and only
on architecture.**

- **It removes the reset problem entirely.** Report 10 §3.2 enumerates what a
  reused window must clear between uses. A window that has never been used has
  nothing to clear; that class of defect cannot be written.
- **Report 10 §3.4 recommends warm and this reverses it deliberately.** That
  advice assumed a *pool* of warm windows, so the reset machinery was being paid
  for anyway. Decision D3 collapsed the pool, leaving a warm picker as the only
  warm window in the application, carrying all of that complexity alone.

**The speed evidence points the other way, and each correction has strengthened
it rather than weakened it.** Version one put the gap at 2 frames. This one puts
it at 2 to 5, and adds that warm is perfectly deterministic while fresh is not.
A dialog that takes 2 frames every time is a different object from one that takes
4 frames usually and 7 sometimes, even though both are fast in absolute terms.

**So this is a judgement, not a readout.** The numbers do not settle it; they
price it. Two extra frames for a defect class you can never write is a good
trade. Five extra frames, sometimes, is a worse one — and nothing here explains
*why* a run lands on 4 frames or on 7, which is the piece of understanding that
would let anyone predict which they will get.

**What would settle it.** Build the picker fresh, then measure the WHOLE path —
socket, validation, FIFO, window — against a real portal request. If the total
approaches where a person notices, switch to warm: this document is the evidence
for switching and report 10 §3.2 is the price. Do not treat "fresh" as settled
beyond that measurement.

## What this did NOT measure, and it matters

**This is the window, not the request.** The real path also carries a socket
round trip, command validation, and opening a FIFO the portal is blocked
reading. None of that exists yet, so none of it is here. Do not read 5 frames as
the budget for a save dialog; it is the budget for one component of it.

**Why a run lands on 4 frames or 7 is unexplained.** It is stable *within* a run
and varies *between* runs, which points at process-level state settled at
startup rather than at anything per-iteration. Nobody has chased it, and it is
the first thing to chase if this number ever has to be tighter.

**It ran on a virtual display.** `xvfb-run` means software rendering with no GPU
compositor, and a 60 Hz frame clock is Chromium's default rather than any real
monitor's. On hardware the frame period changes and so does every number here —
the frame COUNTS are the portable part, not the milliseconds.

**Presentation to the X server is not confirmed.** The paint signal is a frame
produced by the renderer's compositor; buffer swap and window mapping are past
that point. Both strategies use the identical instrument, so the comparison
holds and the absolute figures are a proxy.

**`min` and `max` are absent from the tables.** They are single samples and they
wander across frame boundaries like everything else here. The first version put
them beside `p50` as if equally solid, and verification found the reported `min`
unreproducible.

## Reproducing it

```bash
mkdir -p /tmp/picker-bench && cp app/bench/pickerWindow.mjs /tmp/picker-bench/main.js
printf '{"name":"picker-bench","version":"1.0.0","main":"main.js","type":"module"}\n' > /tmp/picker-bench/package.json
env -u ELECTRON_RUN_AS_NODE xvfb-run -a -- node_modules/electron/dist/electron /tmp/picker-bench \
  --no-sandbox --ozone-platform=x11 | grep PICKER_BENCH
```

`xvfb-run` and clearing `ELECTRON_RUN_AS_NODE` are both required, for the reasons
at the top of `app/test/smoke.test.ts`: the first keeps the windows off the
operator's session, and without the second the Electron binary starts as plain
Node and opens no window at all.
