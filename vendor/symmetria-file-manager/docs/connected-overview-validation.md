# Connected overview validation

The final production measurements meet the root-paint target of 200 ms, cached-paint target of 100 ms, and settled-update target of 500 ms.

## Environment and method

- Date: 2026-09-10 UTC.
- Host: Arch Linux, kernel 7.1.8-arch1-3, AMD Ryzen 7 8700G, 16 logical CPUs.
- Runtime: Electron 41.5.0, isolated Xvfb display, native Chromium CDP input.
- Viewport: 1440 × 900 CSS pixels, device scale 1.
- Build: `pnpm --filter @symmetria/fm-app build`, run explicitly after the test suite. The measured renderer artifact is `index-D0NItfJm.js`.
- Each instance uses a temporary `SYMMETRIA_FM_SOCKET`. `ELECTRON_RUN_AS_NODE` is cleared. No installed service is restarted.

Cold means an overview-cache miss in an already running renderer. It does not mean a cold OS filesystem cache. The harness creates local fixtures immediately before each measurement. These figures are single local samples, not universal filesystem guarantees or timing assertions for CI.

Each fixture has the recorded number of immediate branch directories and files per branch. The first branch also contains `nested/deep/boundary/deep.txt`. The boundary directory reaches depth 4, so initial traversal leaves its file unopened. The large fixture exceeds the 5,000-entry inspection cap. Its incomplete groups retain explicit limit labels.

The harness waits for the renderer before sending the socket open-path request. It starts the cold timer at native Shift+O and polls for the first graph group. Full-scan timing ends when the toolbar stops reporting loading. Cached paint measures close/reopen through the same trigger. DOM counts include every descendant of the graph viewport, first at reading scale and then after Fit.

Create, rename and delete timings measure a filesystem operation to the matching graph-row update. The large fixture first deletes a represented file to release one entry slot. This permits a create measurement without claiming that a full snapshot can exceed its cap. The shared watcher coalesces named events for 20 ms. The overview coalesces branch invalidations for 100 ms, which accounts for most measured update latency.

## Recorded samples

All times are milliseconds. `mountedReading` and `mountedFit` count DOM elements. `entries` counts fixture entries, excluding its root.

```json
[
  {
    "name": "small",
    "entries": 104,
    "branches": 10,
    "filesPerBranch": 9,
    "coldRootMs": 12.89,
    "fullScanMs": 50.92,
    "cachedPaintMs": 10.66,
    "createMs": 131.53,
    "renameMs": 130.79,
    "deleteMs": 131.68,
    "mountedReading": 260,
    "mountedFit": 464,
    "inspected": 103
  },
  {
    "name": "medium",
    "entries": 1004,
    "branches": 20,
    "filesPerBranch": 49,
    "coldRootMs": 5.94,
    "fullScanMs": 53.88,
    "cachedPaintMs": 11.37,
    "createMs": 128.91,
    "renameMs": 130.16,
    "deleteMs": 135.43,
    "mountedReading": 628,
    "mountedFit": 3197,
    "inspected": 1003
  },
  {
    "name": "large",
    "entries": 6014,
    "branches": 10,
    "filesPerBranch": 600,
    "coldRootMs": 4.96,
    "fullScanMs": 173.93,
    "cachedPaintMs": 67.01,
    "createMs": 135.75,
    "renameMs": 137.18,
    "deleteMs": 142.74,
    "mountedReading": 5652,
    "mountedFit": 15545,
    "inspected": 5000
  }
]
```

## Resource and behavior checks

The tests exercise branch-only updates, immediate cached structure, the 128-watch ceiling, watch cleanup, the three-root and 15,000-entry cache limits, visible failed coverage, and selection fallback after deletion. Existing traversal tests continue to exercise depth, entry and concurrency limits. Fault injection exercises unnamed watcher events and runtime watch errors through the shared watcher.

Independent Electron verification exercised these behaviors through native input and the actual IPC boundary:

- Create, rename, atomic replacement and deletion updated the affected branch. An unaffected sibling kept its text and coordinates. Deleting the selected row selected its surviving parent.
- Cached camera restoration retained zoom 1.2 and scroll offsets 362,439 before closing, at first cached paint and after revalidation. Earlier verification also checked collapse state and sibling coordinates.
- A 180-directory fixture held 128 overview watches in sampled `/proc` counts. Closing left only the fixture's Miller watch. Repeated close/open cycles returned to the baseline count.
- Four 6,010-entry fixtures each exposed 5,001 loaded paths including the root. Three retained snapshots therefore represented 15,000 entries. Reopening the third root retained its count. Reopening the evicted first root started an empty cold snapshot.
- Restoring directory permissions and invoking Scope Refresh loaded a new file and removed the cached `Unreadable: EACCES` status.
- An injected `fs.watch` setup failure in the isolated main process showed Retry and `Live updates unavailable`. Two failed calls occurred 505 ms apart. No third call occurred during another 800 ms. Clearing the injected fault and invoking Retry restored live updates. This establishes the error path through the real IPC boundary; it does not claim a naturally occurring filesystem failure.
- Native `BrowserWindow.hide()` paused overview watches. A change made while hidden appeared after `show()` revalidated the snapshot. External navigation closed the overview.
- Native `/` input arrived while a large fixture still showed Loading and opened loaded-path search. This establishes responsiveness during scanning without a timing guarantee for every key.

Deterministic tests additionally hold watch setup and unwatch acknowledgments open. They prove that replacement setup waits for capacity and that an old unsubscribe cannot remove the replacement. Other guards cover full-cache revalidation, canceled-read accounting, retry limits and removal of obsolete measured/collapsed state.

## Build distinction and the missed diagnostic target

An intermediate run used the artifact left by `pnpm -r test`, rather than rebuilding with the report's standalone production command. That artifact contained React's development `jsxDEV`, element-freezing and debug-remount code. It recorded 200.68 ms for large cached opening, which missed the 100 ms target. Its large full scan took 407.48 ms, and its updates took 191.51–245.48 ms.

A diagnostic CPU profile of that artifact attributed about 36.91 ms of sampled time to development JSX creation and 35.99 ms to synchronous folder measurement. Its first cached DOM mutation occurred 117.70 ms after the key event, and its next animation frame occurred at 125.80 ms. The polling-based cached result for that profiled run was 155.77 ms. Profiling adds overhead, so these values identify rendering work rather than provide a second production benchmark.

The explicit production build removed the development runtime. The final table records that build: large cached opening took 67.01 ms, and the full bounded scan took 173.93 ms. The source did not change between the diagnostic and production runs. Performance measurements must rebuild explicitly after the suite, because `app/test/build.setup.ts` passes the test process environment into its child build.

## Practical limits

Fit can mount many groups at once. The large fixture mounts about 15,500 DOM elements at Fit, despite the bounded snapshot. Culling operates at group level, so a single wide sibling group keeps all its rows mounted. Reading scale mounts fewer elements. The final production bounded scan remains below 200 ms on this host, but slower hardware can expose this rendering cost.

Watch coverage depends on the filesystem. A failed overview watch receives at most one delayed rearm attempt. Persistent failure stays visible until explicit Refresh. Unloaded and excluded branches receive no recursive watch. New directories appear as unopened leaves. Cache entries contain in-memory structure and view state only, with no retained subscriptions.
