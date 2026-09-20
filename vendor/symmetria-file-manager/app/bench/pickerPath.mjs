import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What the WHOLE picker path costs, against a running daemon.
 *
 * The earlier spike (`pickerWindow.mjs`) measured a bare `BrowserWindow` and
 * said so plainly in its own header: "It does NOT measure the socket round
 * trip, the request validation or the FIFO open. Those are on the real path and
 * are not built yet." They are built now, and this measures them.
 *
 * ── What is measured, and what is deliberately not ──────────────────────────
 * The clock starts when the command is written to the daemon's socket and stops
 * when the daemon's reply arrives. That reply is sent AFTER `PickerHost.create`
 * returns, which is after the `BrowserWindow` has been constructed — so this
 * covers the socket round trip, JSON decoding, the FIFO-path validation, the
 * one-at-a-time check and window construction.
 *
 * It does NOT cover PAINT. Nothing outside the process can see the first frame,
 * and instrumenting the product to report one would be measuring a probe rather
 * than the product. Paint is what the earlier spike measured in isolation, and
 * the document adds the two together rather than pretending one number covers
 * both.
 *
 * ── How to run it ───────────────────────────────────────────────────────────
 * Needs a daemon of its own. NEVER point it at the operator's socket.
 *
 *   scratch=$(mktemp -d)
 *   env -u ELECTRON_RUN_AS_NODE SYMMETRIA_FM_SOCKET="$scratch/d.sock" \
 *     xvfb-run -a -- ../node_modules/electron/dist/electron . --no-sandbox \
 *     --ozone-platform=x11 &
 *   SYMMETRIA_FM_SOCKET="$scratch/d.sock" node bench/pickerPath.mjs
 */

const ITERATIONS = 20;

/**
 * The first iteration of each run is thrown away.
 *
 * The first dialog after boot pays one-time costs no later one pays — the GPU
 * process handshake, the first compositor surface. The number that matters is
 * what the SECOND dialog of a session costs, not the first.
 */
const DISCARD_FIRST = 1;

/**
 * The compositor's frame period, and the resolution of the paint half.
 *
 * Reported alongside the milliseconds because the earlier spike's figures are
 * quantised to it — `requestAnimationFrame` fires on the frame clock, so a
 * request-to-paint duration cannot land between two frames. That document was
 * wrong twice by reading the quantisation as signal. Dividing by this number is
 * what explained it, and printing it here is what stops the next reader
 * repeating the mistake when they add the two halves together.
 */
const FRAME_MS = 1000 / 60;

const socketPath = process.env.SYMMETRIA_FM_SOCKET;
if (socketPath === undefined || socketPath === "") {
  process.stderr.write("SYMMETRIA_FM_SOCKET must name a daemon of your own.\n");
  process.exit(2);
}

const now = () => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One command, one reply. The same twelve lines the command-line tool carries. */
function send(payload) {
  return new Promise((resolve) => {
    const connection = createConnection(socketPath);
    let buffer = "";
    connection.setEncoding("utf8");
    connection.setTimeout(10_000, () => {
      connection.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    connection.once("connect", () => connection.write(`${JSON.stringify(payload)}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk;
    });
    connection.once("error", (error) => resolve({ ok: false, error: error.message }));
    connection.once("close", () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch {
        resolve({ ok: false, error: "no reply" });
      }
    });
  });
}

/**
 * The pipes go under the picker prefix, not in a scratch directory.
 *
 * The daemon refuses any FIFO outside `/tmp/symmetria-picker-` — that prefix is
 * a security boundary, because `/tmp` is world-writable and any local process
 * can name the path the daemon is about to open for writing. The first version
 * of this bench used a `mktemp -d` and every iteration was refused, which is
 * the boundary working exactly as intended.
 *
 * Each name carries this process's pid so two benches cannot collide, and every
 * one is removed at the end.
 */
const PIPE_PREFIX = `/tmp/symmetria-picker-bench-${process.pid}-`;
const scratch = mkdtempSync(join(tmpdir(), "fm-bench-"));
const made = [];

/**
 * A pipe with a reader already blocked on it, which is the real sequence.
 *
 * The portal opens the FIFO for reading before it ever sends the command, so a
 * measurement taken without a reader would exercise the retry loop instead of
 * the path an actual dialog takes.
 */
function pipeWithReader(index) {
  const fifo = `${PIPE_PREFIX}${index}`;
  execFileSync("mkfifo", ["-m", "600", fifo]);
  // **Every stream redirected, and `stdio: "ignore"` on top.** The reader is
  // backgrounded, but `execFileSync` waits for the child's inherited pipes to
  // reach EOF — not merely for the shell to exit — so a reader holding stderr
  // open blocks this call until the reader dies. The reader only dies when the
  // daemon answers, and the daemon is answered by the `closePicker` further
  // down this same function. That is a deadlock, and it is what made a
  // twenty-iteration run hang after the fifth while six iterations passed
  // cleanly: a harness defect wearing the shape of a product one.
  execFileSync(
    "sh",
    ["-c", `( timeout 20 cat ${JSON.stringify(fifo)} >/dev/null 2>&1 & ) </dev/null`],
    { stdio: "ignore" },
  );
  made.push(fifo);
  return fifo;
}

function summarise(samples) {
  const kept = samples.slice(DISCARD_FIRST).sort((a, b) => a - b);
  // An empty run is a failed run, and saying so beats a crash inside the
  // percentile helper — which is what the first version did when every
  // iteration was refused.
  if (kept.length === 0) return { n: 0, note: "no successful iterations" };
  const at = (q) => kept[Math.min(kept.length - 1, Math.floor(kept.length * q))];
  const ms = (x) => Number(x.toFixed(1));
  return {
    n: kept.length,
    discarded: DISCARD_FIRST,
    p50: ms(at(0.5)),
    p95: ms(at(0.95)),
    p50Frames: Number((at(0.5) / FRAME_MS).toFixed(2)),
    p95Frames: Number((at(0.95) / FRAME_MS).toFixed(2)),
  };
}

const samples = [];

for (let i = 0; i < ITERATIONS; i++) {
  const fifo = pipeWithReader(i);

  const started = now();
  const reply = await send({ cmd: "createPicker", fifo, title: "Bench" });
  const elapsed = now() - started;

  if (reply.ok !== true) {
    process.stderr.write(`iteration ${i} refused: ${JSON.stringify(reply)}\n`);
    break;
  }
  samples.push(elapsed);

  // Dismissed and given time to go, so the next iteration is not measuring the
  // previous window's teardown. The earlier spike learned this the hard way:
  // an unawaited destroy left iteration N competing with iteration N+1 for the
  // same GPU process, and the cost landed on one strategy alone.
  await send({ cmd: "closePicker", fifo });
  await delay(250);
}

process.stdout.write(
  `${JSON.stringify(
    {
      what: "socket write -> daemon reply (decode, validate, one-at-a-time, window construction)",
      excludes: "paint; see 23-spike-picker-window.md for that half",
      frameMs: Number(FRAME_MS.toFixed(3)),
      requestToReply: summarise(samples),
    },
    null,
    2,
  )}\n`,
);

for (const fifo of made) rmSync(fifo, { force: true });
rmSync(scratch, { recursive: true, force: true });
