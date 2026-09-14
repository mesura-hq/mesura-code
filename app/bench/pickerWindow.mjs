import { app, BrowserWindow } from "electron";

/**
 * What a picker window costs, measured two ways.
 *
 * Phase 4 of the single-window run. This changes no product behaviour and is
 * not a test — it exists to answer one question with a number, because the
 * design that follows it turns on the answer:
 *
 *   Should a save dialog get a FRESH window per request, or should one hidden
 *   window be kept warm and reused?
 *
 * Report 10 §3.4 recommends the warm one. That advice was written when the
 * design still had a POOL of warm windows; decision D3 collapsed the pool, so a
 * warm picker would now be the only warm window in the whole application and
 * would carry all of the between-uses reset correctness on its own. A fresh
 * window has no state to reset, by construction. The operator's position:
 * "I like the fresh one a little bit more only if it does not come with
 * slowness with it." This produces the *with it*.
 *
 * ── What is measured, and what is deliberately not ──────────────────────────
 * The clock starts when a picker is "requested" and stops when the window has
 * PAINTED. Not at `ready-to-show`, which fires before pixels exist: it would
 * flatter both strategies, and by different amounts, which is the worst kind of
 * measurement error because it survives a sanity check.
 *
 * Everything is measured WARM. The process is already up, the bundle is in the
 * page cache and the scheme handler is registered — which is the state the real
 * picker path will always be in, because the daemon is resident.
 *
 * It does NOT measure the socket round trip, the request validation or the FIFO
 * open. Those are on the real path and are not built yet. The document this
 * produces has to say so, or the number reads as the whole budget.
 */

/** How many times each strategy is exercised. */
const ITERATIONS = 60;

/**
 * The first iteration of each strategy is thrown away.
 *
 * The first `BrowserWindow` after boot pays one-time costs no later one pays —
 * GPU process handshake, first compositor surface, first paint of the shared
 * stylesheet. Leaving it in moves the median of a sixty-sample run visibly, and
 * the number that matters is what the SECOND dialog of a session costs, not the
 * first.
 */
const DISCARD_FIRST = 1;

const PAGE = "data:text/html,<style>body{background:%23111}</style><h1>picker</h1>";

const now = () => Number(process.hrtime.bigint()) / 1e6;

/** Options a picker window would really use: hidden until painted, framed. */
function pickerOptions() {
  return { width: 900, height: 600, show: false, backgroundColor: "#0b0b0b" };
}

/**
 * Wait until the renderer's compositor has produced a frame.
 *
 * `ready-to-show` says the renderer has rendered; it does not say a frame
 * exists. A double `requestAnimationFrame` round trip resolves only after one
 * does.
 *
 * **It does NOT confirm the frame reached the X server.** Buffer swap and
 * window mapping are past this point, and under software rendering there is no
 * vsync forcing that boundary — so this is "a frame was produced", which is a
 * narrower claim than "the user can see it". Both strategies are measured with
 * the identical instrument, so the COMPARISON is unaffected; only the absolute
 * numbers are a proxy.
 */
async function awaitPaint(window) {
  await window.webContents.executeJavaScript(
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
  );
}

/** A window created and destroyed for one request. */
async function measureFresh() {
  const started = now();
  const window = new BrowserWindow(pickerOptions());
  await window.loadURL(PAGE);
  await new Promise((resolve) => window.once("ready-to-show", resolve));
  window.show();
  await awaitPaint(window);
  const elapsed = now() - started;

  // Awaited, and review found why it has to be. `destroy()` only PROMISES the
  // window will close; without waiting, the native and renderer teardown of
  // iteration N was still in flight while iteration N+1 constructed its window,
  // so the two competed for the same GPU process. That cost is real but it is
  // "overlapping cleanup", not window construction — and it landed on this
  // strategy alone, because this is the only one that destroys anything.
  await new Promise((resolve) => {
    window.once("closed", resolve);
    window.destroy();
  });
  return elapsed;
}

/** One window kept alive, shown and hidden. */
async function measureWarm(window) {
  const started = now();
  window.show();
  await awaitPaint(window);
  const elapsed = now() - started;

  window.hide();
  return elapsed;
}

/**
 * The compositor's frame period, and the resolution of this whole instrument.
 *
 * **Every measurement here is an integer number of frames, and that is not a
 * coincidence — it is what the instrument can express.** `requestAnimationFrame`
 * fires on the frame clock, so a request-to-paint duration cannot land between
 * two frames however long the work underneath actually took.
 *
 * This was missed twice. The first two versions of the accompanying document
 * reported figures like "82.5 ms" and "66.2 ms" as though the 16 ms between them
 * were a stable property of one strategy, and treated runs that landed on
 * different sides of a frame boundary as instability to be explained. They are
 * the same measurement, one frame apart. Verification caught the bimodality;
 * dividing by this number is what explained it.
 */
const FRAME_MS = 1000 / 60;

function summarise(samples) {
  const kept = samples.slice(DISCARD_FIRST).sort((a, b) => a - b);
  const at = (q) => kept[Math.min(kept.length - 1, Math.floor(kept.length * q))];
  const ms = (x) => Number(x.toFixed(1));
  // Reported alongside the milliseconds, so the next reader sees the
  // quantisation rather than rediscovering it as noise.
  const frames = (x) => Math.round(x / FRAME_MS);
  return {
    n: kept.length,
    discarded: DISCARD_FIRST,
    p50: ms(at(0.5)),
    p95: ms(at(0.95)),
    p50Frames: frames(at(0.5)),
    p95Frames: frames(at(0.95)),
  };
}

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  // A window that stays up for the whole run, so every measurement below is
  // taken in a warm process rather than a booting one.
  const resident = new BrowserWindow(pickerOptions());
  await resident.loadURL(PAGE);
  await new Promise((resolve) => resident.once("ready-to-show", resolve));
  resident.show();
  await awaitPaint(resident);

  const warmWindow = new BrowserWindow(pickerOptions());
  await warmWindow.loadURL(PAGE);
  await new Promise((resolve) => warmWindow.once("ready-to-show", resolve));
  // Shown and hidden once before measuring, so the pre-made window is genuinely
  // warm rather than merely constructed. Measuring its very first `show()`
  // against a fresh window's second would be comparing two different things.
  warmWindow.show();
  await awaitPaint(warmWindow);
  warmWindow.hide();

  // INTERLEAVED, alternating within one loop, and this is the correction review
  // asked for. Running all of `fresh` and then all of `warm` confounds the
  // strategy with the process's lifetime: anything that drifts over a run — GC
  // pressure from sixty create/destroy cycles, X server surface accumulation —
  // always lands on whichever went first. The reported instability of `fresh`
  // has exactly the signature that confound would produce, so measuring them
  // alternately is what tells the two apart.
  const fresh = [];
  const warm = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Order flipped on alternate iterations, so neither strategy is
    // systematically the one that pays for the other's leftovers.
    if (i % 2 === 0) {
      fresh.push(await measureFresh());
      warm.push(await measureWarm(warmWindow));
    } else {
      warm.push(await measureWarm(warmWindow));
      fresh.push(await measureFresh());
    }
  }

  process.stdout.write(
    `PICKER_BENCH ${JSON.stringify({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      iterations: ITERATIONS,
      fresh: summarise(fresh),
      warm: summarise(warm),
    })}\n`,
  );

  // Explicit, for symmetry with `measureFresh` and so this file survives being
  // imported rather than run: `app.exit(0)` reclaims these either way, but that
  // is process semantics doing the work rather than the code saying what it
  // means.
  resident.destroy();
  warmWindow.destroy();
  app.exit(0);
});
