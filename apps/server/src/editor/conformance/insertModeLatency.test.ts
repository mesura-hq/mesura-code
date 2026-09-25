// @effect-diagnostics nodeBuiltinImport:off - reads the developer's config and a source file.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge } from "../NvimBridge.ts";

/**
 * The insert-mode bench, and the number the design decision rests on.
 *
 * The question it settles is whether keys in insert mode can go to Neovim like
 * every other key (naive), or whether Monaco has to edit locally and hand the
 * result over when insert mode ends (delegated). It is a question about time,
 * so it is answered with measurements rather than with an argument, and it can
 * only be answered against the developer's real configuration: `--clean` says
 * nothing useful, because it is the plugins that run on every inserted
 * character — autopairs, nvim-cmp, LuaSnip — that cost the time.
 *
 * Gated on `MESURA_NVIM_CONFIG_DIR`, and it cannot run in continuous
 * integration: the configuration is a separate repository whose first start
 * installs its plugins. Run it twice and take the second, so the first start's
 * work is not in the numbers.
 *
 * Deliberately not an assertion against a threshold. A bench that fails on a
 * loaded machine reports a defect that is not there; this records what it saw
 * and writes it where the decision can cite it.
 */

const configDirectory = (() => {
  const raw = process.env["MESURA_NVIM_CONFIG_DIR"];
  if (raw === undefined || raw.trim() === "") return null;
  const expanded = raw.startsWith("~/") ? `${NodeOS.homedir()}/${raw.slice(2)}` : raw;
  try {
    return NodeFS.statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
})();

const nvimAvailable = (() => {
  try {
    NodeChildProcess.execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const enabled = configDirectory !== null && nvimAvailable;

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** The browser's share of a keystroke, from the prototype: 7.0 ms minus a 0.6 ms floor. */
const BROWSER_SHARE_MS = 6.4;

/** One frame at 60 Hz. At or under this, a key looks instant. */
const ONE_FRAME_MS = 16.7;

/** One-way link delays from the intent: local, tailnet minimum, average, loaded. */
const LINK_DELAYS_MS = [0, 5.6, 50, 250];

/** Three hundred lines of real TypeScript, read rather than copied into the repo. */
const SOURCE_FILE = "../web/src/components/files/monaco/MonacoFileSurface.tsx";

/**
 * A wait on a clock, and deliberately so.
 *
 * Everywhere else in this suite a clock would be a bug, because a settle has a
 * real event to wait for. Here the gap between keys is part of what is being
 * modelled: a person types, they do not hold the key down.
 */
const pause = (milliseconds: number) => Effect.sleep(`${milliseconds} millis`);

/** Did anything actually happen on screen between these two readings? */
const somethingHappened = (
  before: { readonly gridCells: number; readonly cursorMoves: number },
  after: { readonly gridCells: number; readonly cursorMoves: number },
) => after.gridCells !== before.gridCells || after.cursorMoves !== before.cursorMoves;

/**
 * Counts the gaps in which something happened with no key in flight.
 *
 * This is the bench's error bar, and it is not decoration. Under the real
 * configuration Neovim flushes about every four milliseconds whether or not
 * anything is going on — measured at 114 frames in 500 idle milliseconds,
 * nearly all of them drawing nothing at all. A bench that timed "the next
 * frame" after a key would therefore be timing that stream rather than the
 * key: an earlier version of this file did exactly that and reported a p50 of
 * 1.73 ms, which is about half the gap between two empty frames.
 *
 * So `probe` waits for a frame in which something happened, and this counts
 * how often something happens when nothing should. A total near zero says the
 * timings have nothing to be confused with.
 */
const idleSignals = (bridge: NvimBridge.Session, milliseconds: number) =>
  Effect.gen(function* () {
    const before = bridge.metrics;
    yield* pause(milliseconds);
    return somethingHappened(before, bridge.metrics) ? 1 : 0;
  });

interface Sample {
  readonly elapsedMs: number;
  readonly cells: number;
  readonly bufferEvents: number;
}

const quantile = (values: ReadonlyArray<number>, fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

const median = (values: ReadonlyArray<number>) => quantile(values, 0.5);

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Sends one key and times the frame in which something happened.
 *
 * "Something" is a cell drawn **or** the cursor moving, and it has to be both
 * of those. Cells alone miss every closer: with autopairs on, typing the `)`
 * it already inserted only steps the cursor over it and draws nothing, and
 * about one key in twelve of ordinary code is such a closer — enough to put
 * every one of them in the tail, which is how an earlier version of this file
 * came to report a p50 of 1.8 ms beside a p95 of 515 ms. The cursor alone
 * misses the keys that redraw without moving it.
 *
 * Waiting for the next frame whatever it held is worse than either: this
 * configuration emits an empty frame about every four milliseconds, so that
 * version timed the background stream and not the key.
 */
const probe = (bridge: NvimBridge.Session, keys: string) =>
  waitingFor(bridge, keys, (before) => somethingHappened(before, bridge.metrics));

/**
 * Sends keys and times the frame in which virtual text appears.
 *
 * For flash that is the frame carrying the labels, which is the number the
 * document talks about. Timing the first frame instead measured the cheap
 * redraw on entering the search and published it beside a sentence about the
 * expensive one.
 */
const probeUntilOverlays = (bridge: NvimBridge.Session, keys: string) =>
  waitingFor(bridge, keys, () => bridge.overlays.length > 0);

/**
 * The shared shape: subscribe, send, then wait for `done` to hold.
 *
 * Bounded in frames and in time, so keys that change nothing report a slow
 * sample instead of hanging the bench.
 */
function waitingFor(
  bridge: NvimBridge.Session,
  keys: string,
  done: (before: { readonly gridCells: number; readonly cursorMoves: number }) => boolean,
) {
  return Effect.gen(function* () {
    // Subscribed before the key is sent, never after. Reading state and then
    // waiting loses the race whenever the frame lands in between, and the wait
    // then belongs to a frame nobody asked for.
    let frame = yield* bridge.nextFrame;
    // The baseline is read after subscribing, so a frame landing during the
    // subscription cannot be folded into it and lost.
    const before = bridge.metrics;
    const started = performance.now();
    yield* bridge.input(keys);

    let waited = 0;
    while (waited < 400) {
      yield* frame.pipe(
        Effect.timeout("1 second"),
        Effect.catchCause(() => Effect.void),
      );
      waited += 1;
      if (done(before)) break;
      frame = yield* bridge.nextFrame;
    }

    const after = bridge.metrics;
    return {
      elapsedMs: performance.now() - started,
      cells: after.gridCells - before.gridCells,
      bufferEvents: after.bufferEvents - before.bufferEvents,
    } satisfies Sample;
  });
}

/** The line the report prints for one run of samples. */
const summarise = (name: string, samples: ReadonlyArray<Sample>) => {
  const times = samples.map((sample) => sample.elapsedMs);
  return {
    name,
    count: samples.length,
    p50: round(quantile(times, 0.5)),
    p95: round(quantile(times, 0.95)),
    max: round(Math.max(...times, 0)),
    medianCells: median(samples.map((sample) => sample.cells)),
    medianBufferEvents: median(samples.map((sample) => sample.bufferEvents)),
  };
};

if (!enabled) {
  it("skips the insert-mode bench", () => {
    // Said out loud rather than silently absent: a bench that vanishes looks
    // exactly like a bench that ran.
    assert.isTrue(
      configDirectory === null || !nvimAvailable,
      "MESURA_NVIM_CONFIG_DIR names a directory and nvim is on PATH, so this should have run",
    );
  });
}

if (enabled)
  it.layer(layer, { excludeTestServices: true })("insert-mode latency", (it) => {
    it.effect(
      "measures the cost of a keystroke against the real configuration",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-bench-" });
          const source = (yield* fs.readFileString(SOURCE_FILE)).split("\n");
          const seeded = Array.from(
            { length: 300 },
            (_, index) => source[index % source.length] ?? "",
          );
          const path = `${root}/bench.tsx`;
          yield* fs.writeFileString(path, `${seeded.join("\n")}\n`);

          const bridge = yield* NvimBridge.spawn({
            cols: 120,
            rows: 40,
            configDirectory: configDirectory as string,
            stateDir: root,
            cwd: root,
            initialFile: path,
          });
          yield* bridge.settle;

          // Insert mode: a sentence with spaces, brackets and quotes, so
          // autopairs has something to react to on a real share of the keys.
          const typed = 'const value = greet("world", [1, 2]); ';
          // `input`, not `type`. `type` finishes the typeahead before it
          // answers, which aborts a command on its way into insert mode — so
          // `ggo` would come back in normal mode and every character after it
          // would be read as a command.
          yield* bridge.input("ggo");
          yield* bridge.awaitFrame;
          const insert: Sample[] = [];
          let strayFrames = 0;
          for (let index = 0; index < 200; index += 1) {
            insert.push(yield* probe(bridge, typed[index % typed.length] ?? " "));
            strayFrames += yield* idleSignals(bridge, 25);
          }
          yield* bridge.input("<Esc>");
          yield* bridge.settle;

          // Normal mode, alternating so every key has somewhere to go.
          const normal: Sample[] = [];
          for (let index = 0; index < 50; index += 1) {
            normal.push(yield* probe(bridge, index % 2 === 0 ? "j" : "k"));
          }

          // Flash: the plugin that draws the most, and the reason the grid is
          // classified at all.
          //
          // Timed to its *labels*, not to its first frame. `s` redraws once on
          // entering the search and again when the labels land, so a probe that
          // took the first frame measured the cheap one and published it beside
          // a sentence about the expensive one. Twenty runs rather than five,
          // because a p95 over five samples is the maximum wearing a label.
          const flash: Sample[] = [];
          for (let index = 0; index < 20; index += 1) {
            flash.push(yield* probeUntilOverlays(bridge, "se"));
            yield* bridge.input("<Esc>");
            // `settle`, not the next frame. The next frame only came for free
            // while the configuration's status line redrew on its own; with
            // those plugins left out under Mesura an idle Neovim draws
            // nothing, and an `<Esc>` that finds nothing to clear then waited
            // for a frame that never came.
            yield* bridge.settle;
          }

          const runs = [
            summarise("insert", insert),
            summarise("normal j/k", normal),
            summarise("flash s+e", flash),
          ];

          const insertP95 = runs[0]!.p95;
          const predicted = LINK_DELAYS_MS.map((delay) => ({
            delay,
            // Two crossings of the link, one each way, plus the browser's own
            // share. The browser number is the prototype's constant and is not
            // re-measured here.
            predicted: round(insertP95 + BROWSER_SHARE_MS + delay * 2),
          }));
          const verdict =
            (predicted[0]?.predicted ?? Infinity) <= ONE_FRAME_MS ? "naive" : "delegated";

          const report = [
            `# Insert-mode bench`,
            ``,
            `nvim ${NodeChildProcess.execFileSync("nvim", ["--version"]).toString().split("\n")[0]}`,
            `configuration ${configDirectory}`,
            ``,
            `Gaps of 25 ms in which something happened with no key in flight: ${strayFrames} of 200.`,
            `That is the error bar. Neovim flushes about every 4 ms under this configuration`,
            `whether or not anything is happening, so timing the next frame would time that`,
            `stream; these are the gaps that could have been taken for a key.`,
            ``,
            `| run | n | p50 ms | p95 ms | max ms | median cells | median buffer events |`,
            `| --- | --- | --- | --- | --- | --- | --- |`,
            ...runs.map(
              (run) =>
                `| ${run.name} | ${run.count} | ${run.p50} | ${run.p95} | ${run.max} | ${run.medianCells} | ${run.medianBufferEvents} |`,
            ),
            ``,
            `Predicted keystroke-to-paint = insert p95 (${insertP95} ms) + browser ${BROWSER_SHARE_MS} ms + 2 x link delay.`,
            ``,
            `| one-way link delay ms | predicted ms |`,
            `| --- | --- |`,
            ...predicted.map((row) => `| ${row.delay} | ${row.predicted} |`),
            ``,
            `Rule: naive at or under ${ONE_FRAME_MS} ms locally, otherwise delegated.`,
            `Verdict: ${verdict}`,
            ``,
          ].join("\n");

          // Beside the package, worked out from this file rather than from the
          // process's working directory: the gitignore entry names one path,
          // and a run started from the repository root would otherwise drop
          // the report somewhere it does not cover.
          const benchDirectory = `${import.meta.dirname}/../../../.editor-bench`;
          NodeFS.mkdirSync(benchDirectory, { recursive: true });
          NodeFS.writeFileSync(`${benchDirectory}/latest.md`, report);
          yield* Effect.logInfo(`insert-mode bench\n${report}`);

          assert.isAbove(insert.length, 0, "the bench recorded something");
          assert.isAbove(runs[0]!.p50, 0, "and the times are real measurements");
        }),
      { timeout: 300_000 },
    );
  });
