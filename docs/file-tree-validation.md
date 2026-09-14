# File tree validation

## Environment and method

Measured on Vigilia home, Arch Linux, Electron 41.5.0, in an isolated Xvfb window.
The renderer viewport was 1000 × 700 CSS pixels. The usable tree height was 578 pixels.
This run used the phase-three working tree based on commit 276f109, with the production build.
The test used a separate profile and socket. A recording host captured zero file-opening requests.

Each result is one observation, not a latency guarantee. A cold entry means the first tree entry for that root in this application process; filesystem caches were not flushed. Cached means an immediate Miller/tree round trip. Cold and cached timings start at the Ctrl+E dispatch and end when more than one row appears. They exclude application startup and the initial Miller listing. Completion is the first sampled toolbar state without scanning, loading, or refreshing text. Sampling adds IPC overhead.

A MutationObserver sampled mounted treeitems. The bound was ceil(578 / 24) + 16 overscan rows + one pinned cursor + one boundary row = 43. Every fixture stayed within it. Each fixture received 150 rapid Ctrl+D events, then two samples 350ms apart. Every final cursor was visible and every second sample retained the same cursor and scroll offset.

The memory sample is Runtime.getHeapUsage usedSize after scrolling. It is renderer JavaScript heap usage, not process RSS or peak memory. The process retained earlier caches; the samples are not isolated per-fixture allocations.

## Fixtures and observations

| Fixture | Inspected / represented | Cold ms | Cached ms | Scan completion ms | Peak mounted | JS heap MiB |
| --- | --- | --- | --- | --- | --- | --- |
| Small | 100 / 100 | 29.2 | 13.6 | 43.8 | 42 | 5.35 |
| Medium file manager | 648 / 640 | 19.2 | 29.5 | 298.7 | 43 | 6.23 |
| Medium Mesura | 3716 / 3693 | 16.1 | 132.9 | 4526.5 | 43 | 12.97 |
| Large | 5000 / 5000 | 17.4 | 76.4 | 182.6 | 42 | 19.75 |
| Wide directory | 1000 / 1000 | 44.4 | 36.6 | 44.9 | 42 | 48.50 |
| Deep | 1236 / 235 | 17.6 | 19.4 | 102.8 | 42 | 12.16 |

- Small: 98 files, one empty folder, and one excluded node_modules folder.
- Medium file manager: the real checkout at /home/dev/symmetria-file-manager with its current generated folders excluded.
- Medium Mesura: the real checkout at /opt/dev/repos/mesura-code. Automatic discovery finished in about 4.5 seconds; the first tree rows appeared much earlier.
- Large: ten folders with 600 files each. The 5,000-entry budget retained a bounded subset of the 6,010 fixture entries.
- Wide directory: 1,100 files. The 1,000-entry per-directory limit retained 1,000 names. Include is not pagination.
- Deep: a branch through d1–d9, ordinary files, an excluded folder, and an unreadable folder. The tree exposed depth-limit and permission coverage states.

The represented counts exclude the synthetic root row. Inspected counts can exceed represented counts because revalidation and hidden entries consume inspection work. Coverage sampling inspected mounted rows only; it did not enumerate all branch warnings. A fast first frame does not imply a complete index. Automatic reads reach depths zero through seven; represented depth-eight branches can remain unscanned. All existing budgets and exclusions remain unchanged.

## Laptop evaluation

Build the committed branch with pnpm install --frozen-lockfile and pnpm --filter @symmetria/fm-app build, then start it with a separate SYMMETRIA_FM_SOCKET. No daily service needs a restart.

Use Ctrl+E to enter the tree and Escape to return to Miller without moving its selection. Ctrl+E inside the tree keeps it open. Check / search through collapsed folders, Enter to confirm, n/N to cycle, and Clear search to remove temporary expansion. Use s and type a filename prefix, then its inline label. Check the native font baseline, dimmed suffix, cancellation on scrolling, and the 150-key navigation behavior at the laptop's display scale. These server measurements do not replace that display-specific evaluation.

## Tree navigation during discovery

The tree now reads directories at depths zero through five automatically. It represents depth-six directories with a depth-limit status. Include can read a boundary directory. Overview still reads depths zero through seven. The shared directory session keys its cache by automatic depth, so an overview visit does not change the tree's scope. Entry, directory, watch and concurrency budgets remain unchanged.

The fixture measurements above describe the earlier depth-eight tree build. They are not new measurements for the depth-six tree.

An initial Miller selection remains pending until discovery settles, unless the user navigates, searches, starts flash, scrolls with the wheel, or changes expansion. These actions cancel the pending reveal. Discovery cannot reapply the initial Miller selection afterward. When discovery interrupts page animation, the tree settles on the selected path at its new row position.
