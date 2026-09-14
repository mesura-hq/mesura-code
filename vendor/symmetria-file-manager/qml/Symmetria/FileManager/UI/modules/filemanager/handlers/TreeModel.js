// FileTreeView expansion + row-model state machine.
//
// Non-library JS — shares the QML component scope of FileTreeView.qml (the sole
// importer). All FileTreeView state is reached through the `root` parameter
// (root._models, root._expanded, …); component IDs and sibling handlers are
// resolved via the importing file's scope, exactly as TreeFlashHandler.js
// reaches `FlashLogic` and SearchHandler.js reaches `fsModel`.
//
// Component IDs accessed via scope: view (the ListView), fsModelComponent (the
//   Component { FileSystemModel {} } factory), gitignoreSvc (the Gitignore
//   service).
// Singletons accessed via scope: Logger, Config, FileSystemModel, Qt.
// Sibling handlers accessed via scope: SearchHandler (jumpToCurrentMatch),
//   TreeFlashHandler (invalidateEntryCache, recompute).
//
// This is a behaviour-preserving extraction of the original inline functions —
// every regression-guard comment is carried over verbatim. Do NOT "clean up"
// the orphan-identity guard, the Qt.callLater deferral, or the _modelHandlers
// disconnect map without reading their rationale below.

// Auto-expand guardrails (failure-mode protection, NOT configuration) — pure
// constants consumed only by this module. They live here, next to the logic
// that enforces them, rather than as FileTreeView properties, so callers can't
// raise them and re-discover the failure modes the defaults protect against.
// Each triggers a one-shot Logger.info on hit (an expected big-tree outcome,
// not a bug) so we can diagnose without UI feedback.
//   FANOUT_CAP — skip dirs with more children than this (unreadable expanded).
//   MODEL_CEILING — cascade-wide cap on directories instantiated; the real cost
//     driver is FileSystemModel + QFileSystemWatcher per dir, so this caps I/O
//     on $HOME-class trees where most subdirs are individually under FANOUT_CAP.
//     Counted across _models (settled) + _pending (in-flight) so a synchronous
//     fan-out burst within one round is accounted for at the next round's gate.
//   NODE_CEILING — last-resort total-row backstop for pathological trees.
//   SKIP_NAMES — never auto-expanded (.git is never useful, even without gitignore).
//   LAZY_BUFFER_ROWS — overscroll headroom (rows) before the lazy cycle re-fires;
//     8 hides a single momentum-scroll flick without re-triggering mid-frame.
var FANOUT_CAP = 200;
var MODEL_CEILING = 100;
var NODE_CEILING = 10000;
var SKIP_NAMES = ({ ".git": true });
var LAZY_BUFFER_ROWS = 8;

function isHidden(name) {
    return name.length > 0 && name.charAt(0) === ".";
}

function resetTreeState(root) {
    root._generation++;
    var models = root._models;
    for (var key in models) {
        var m = models[key];
        destroyModel(root, m, key);
    }
    root._models = ({});
    root._modelHandlers = ({});
    root._expanded = ({});
    root._ignored = ({});
    root._pending = ({});
    root._autoExpandPending = ({});
    root._mountInFlight = false;
    root._lazyExpandActive = false;
    root._lazyExpandCount = 0;
    root._restoreActive = false;
    root._restorePending = [];
    root._rows = [];
    root._loading = false;
    gitignoreSvc.clear();
    view.currentIndex = 0;
}

// Arm the auto-expand cascade for a fresh mount and kick off the root expand.
// Holds the shared priority-ladder body that onRootPathChanged and refreshAll
// both need (it was duplicated inline before this extraction).
//
// Compute the effective auto-expand depth BEFORE expand() so the rootPath's
// onChange callback can see _autoExpandActive on its first emission. Order is
// critical: expand() registers an async entriesChanged handler that reads these
// flags when entries land.
//
// Priority ladder for this mount:
//   1. restoreExpandedPaths (non-empty)  -> replay saved set
//   2. lazyExpand                        -> viewport-driven cascade
//   3. initialExpandDepth                -> BFS fan-out
//
// Each is mutually exclusive for the lifetime of one mount. Restore is highest
// priority because it's the ONLY one that reflects user intent from a prior
// session; the other two are heuristic cascades for first-time / no-cache
// mounts.
function beginMount(root) {
    // Duck-typed check: a Python `list` arrives via PySide6 as a QVariantList,
    // which QML exposes as array-like (has `length` and integer indexing) but
    // does NOT pass `Array.isArray()` — that returns false for QVariantList in
    // Qt 6.11. Use the weaker `cache != null` + `length > 0` form so both a
    // true JS Array and a QVariantList satisfy the gate.
    var cache = root.restoreExpandedPaths;
    var hasCache = cache != null && cache.length > 0;
    if (hasCache) {
        root._autoExpandTargetDepth = 0;
        root._autoExpandActive = false;
        root._lazyExpandActive = false;
        root._restoreActive = true;
        // Build the restore queue: filter to paths under rootPath (skipping
        // rootPath itself — it's expanded unconditionally below) and sort
        // shortest-first so each path's parent is always expanded before the
        // path itself reaches the front of the queue.
        var prefix = root.rootPath === "/" ? "/" : root.rootPath + "/";
        var queue = [];
        for (var i = 0; i < cache.length; i++) {
            var p = cache[i];
            if (typeof p !== "string") continue;
            if (p === root.rootPath) continue;
            if (!p.startsWith(prefix)) continue;
            queue.push(p);
        }
        queue.sort(function (a, b) { return a.length - b.length; });
        root._restorePending = queue;
    } else if (root.lazyExpand) {
        root._autoExpandTargetDepth = 0;
        root._autoExpandActive = false;
        root._lazyExpandActive = true;
    } else {
        var target = root.initialExpandDepth === -1
            ? root.maxExpandDepth
            : root.initialExpandDepth;
        root._autoExpandTargetDepth = Math.max(0, target);
        root._autoExpandActive = root._autoExpandTargetDepth > 0;
    }
    root._mountInFlight = true;
    root._autoExpandCeilingLogged = false;
    root._autoExpandFanoutLogged = false;
    root._autoExpandModelCeilingLogged = false;
    expand(root, root.rootPath);
}

// Disconnect onChange signal handlers before destroy to prevent a deferred
// Qt.callLater invocation from accessing a destroyed C++ object. Must be called
// instead of m.destroy() at every destroy site.
//
// The `path` arg is OPTIONAL — pass it for any model registered in `_models`,
// since the entry in `_modelHandlers[path]` holds the function we connected and
// we need it to disconnect cleanly. Pass empty string (or omit) for orphan
// models that never made it into `_models` — there's no handler entry to look
// up (the registered model owns the map slot for that path), and Qt's
// destructor will cascade-disconnect the orphan's signals anyway.
function destroyModel(root, m, path) {
    if (!m) return;
    if (path && path !== "") {
        var handler = root._modelHandlers[path];
        if (handler) {
            m.entriesChanged.disconnect(handler);
            m.loadingChanged.disconnect(handler);
            var cleared = Object.assign({}, root._modelHandlers);
            delete cleared[path];
            root._modelHandlers = cleared;
        }
    }
    if (m.destroy) m.destroy();
}

function expand(root, path) {
    if (root._models[path] || root._pending[path]) {
        if (root._models[path]) {
            var e = Object.assign({}, root._expanded);
            e[path] = true;
            root._expanded = e;
            rebuildRows(root);
            emitExpandedState(root);
        }
        return;
    }
    var newPending = Object.assign({}, root._pending);
    newPending[path] = true;
    root._pending = newPending;
    root._loading = true;
    var gen = root._generation;
    var m = fsModelComponent.createObject(root, {
        "path": path,
        "showHidden": root.showHidden,
        "sortBy": FileSystemModel.Natural,
        "sortReverse": false,
        "watchChanges": true
    });
    if (!m) {
        Logger.warn("FileTreeView", "failed to create FileSystemModel for " + path);
        var failedPending = Object.assign({}, root._pending);
        delete failedPending[path];
        root._pending = failedPending;
        root._loading = Object.keys(failedPending).length > 0;
        return;
    }
    // Single per-scan handler. Connected to BOTH `loadingChanged` and
    // `entriesChanged` via a `Qt.callLater` deferral:
    //   - `entriesChanged` fires when applyChanges() actually inserts /
    //     removes rows (non-empty scans, watcher-driven updates).
    //   - `loadingChanged` (the false transition) is the ONLY signal we
    //     get for EMPTY directory scans — applyChanges() does nothing
    //     when there are no adds and no removes, so `entriesChanged`
    //     never fires there. Without this second connection, empty
    //     directories leak their entry in `_pending` forever, blocking
    //     the BFS auto-expand from ever signalling completion.
    // Deferral rationale: the C++ FileSystemModel emits loadingChanged
    // BEFORE calling applyChanges() inside the same futureWatcher
    // ::finished handler, which means m.entries is still EMPTY at the
    // moment loadingChanged fires for a non-empty scan. Running the
    // finish path synchronously here would see no candidates, skip
    // fan-out, and settle the mount at 0 rows. `Qt.callLater` queues
    // onChange for the next event-loop tick, by which time the
    // synchronous applyChanges() (and any cascaded entriesChanged
    // emit) has completed and m.entries is populated. callLater also
    // COALESCES duplicate scheduling, so when both loadingChanged and
    // entriesChanged fire in the same tick (the normal non-empty
    // path), onChange runs exactly once.
    var onChange = function() {
        if (gen !== root._generation) return;
        // Skip the "loading just started" emission of loadingChanged.
        // We only act on the loading→false transition, which is when
        // the scan has settled and m.entries reflects the post-scan
        // state.
        if (m.loading) return;
        var entries = m.entries;
        var candidates = [];
        for (var i = 0; i < entries.length; i++)
            candidates.push(entries[i].path);

        var finish = function(ignoredSet) {
            if (gen !== root._generation) return;
            // Defensive orphan guard: only destroy `m` if a DIFFERENT model
            // is already registered for `path` (the orphan-races-winner
            // scenario). The earlier identity-less check
            // (`if (root._models[path])`) was a regression — it fired on
            // EVERY subsequent entriesChanged emit on the registered model
            // (showHidden flip, watchChanges disk update), destroying the
            // live model and emptying the tree. With the _pending guard at
            // the top of expand, the true orphan case is unreachable, but
            // this defensive check is cheap and correct.
            if (root._models[path] && root._models[path] !== m) {
                destroyModel(root, m);
                return;
            }
            var newIgnored = Object.assign({}, root._ignored);
            newIgnored[path] = ignoredSet || ({});
            root._ignored = newIgnored;
            var newPendingClear = Object.assign({}, root._pending);
            delete newPendingClear[path];
            root._pending = newPendingClear;
            root._loading = Object.keys(newPendingClear).length > 0;
            if (!root._models[path]) {
                var newModels = Object.assign({}, root._models);
                newModels[path] = m;
                root._models = newModels;
                var newExpanded = Object.assign({}, root._expanded);
                newExpanded[path] = true;
                root._expanded = newExpanded;
            }
            rebuildRows(root);
            emitExpandedState(root);

            // Expansion cycle drive — mutually exclusive: restore
            // queue, lazyExpand walker, or BFS fan-out. Each path
            // synchronously adds to `_pending` if it wants to keep
            // going, so the pendingEmpty check below sees the
            // post-recursion state correctly. Manual user toggles
            // after all three flags clear don't trigger further
            // recursion, preserving the user's expansion choices for
            // the rest of the session.
            if (root._restoreActive) {
                advanceRestoreFor(root, path);
            } else if (root._lazyExpandActive) {
                advanceLazyExpand(root);
            } else if (root._autoExpandActive) {
                var expansionsTaken = root._autoExpandPending[path] !== undefined
                    ? root._autoExpandPending[path]
                    : 0;  // rootPath itself — implicit zero
                var clearedPending = Object.assign({}, root._autoExpandPending);
                delete clearedPending[path];
                root._autoExpandPending = clearedPending;
                autoExpandChildrenOf(root, path, expansionsTaken);
            }
            // Check pending once, after expansion-cycle drive — used by
            // the active-flag flips and the mount-settled emit below.
            var pendingEmpty = Object.keys(root._pending).length === 0;
            if (root._autoExpandActive && pendingEmpty) {
                root._autoExpandActive = false;
            }
            // _lazyExpandActive normally clears inside advanceLazyExpand
            // (when viewport is full or no more un-expanded dirs remain).
            // The pendingEmpty fallback handles a hypothetical race where
            // the flag's still true at this point but no new expand was
            // queued — guarantees we never settle mount-in-flight without
            // also clearing the lazy gate.
            if (root._lazyExpandActive && pendingEmpty) {
                root._lazyExpandActive = false;
            }
            // `_restoreActive` clears inside `advanceRestoreFor` once
            // the queue drains. The pendingEmpty fallback mirrors the
            // lazyExpand one: if the queue is empty but the flag's
            // still set (e.g. all remaining queue paths were not
            // children of any settled model and got requeued
            // unsuccessfully), force-clear so the mount can settle.
            if (root._restoreActive && pendingEmpty) {
                root._restoreActive = false;
                root._restorePending = [];
            }

            // Terminal "tree mount settled" emit — fires on the first
            // pending-drained-to-empty transition after rootPath change,
            // regardless of whether auto-expand finished naturally, hit
            // the model ceiling, or was disabled (initialExpandDepth: 0).
            // Single deterministic ground-truth marker for "the tree is
            // now interactive"; consumers (incl. bench/measure_mount.py)
            // grep for this. Gated by _mountInFlight so subsequent
            // user-driven expand cycles don't re-emit it.
            if (root._mountInFlight && pendingEmpty) {
                root._mountInFlight = false;
                var lazySuffix = root.lazyExpand
                    ? " (lazy: " + root._lazyExpandCount + " dirs)"
                    : "";
                Logger.info(
                    "FileTreeView",
                    "tree mount settled: " + root._rows.length + " rows visible" + lazySuffix
                );
            }
        };
        // Short-circuit: when the consumer supplies a precomputed
        // ignored-path map, do an O(n) membership filter against it
        // instead of spawning `git check-ignore --stdin` per dir
        // through gitignoreSvc. See `ignoredPathSet` prop docstring
        // for the rationale (the per-dir subprocess queue dominates
        // mount time on big repos by ~30–40ms per directory). When
        // the prop is null we fall back to the original gitignoreSvc
        // path so the standalone FM (which has no IDE-side
        // GitController) keeps working unchanged.
        if (root.ignoredPathSet && root.respectGitignore) {
            var dirIgnored = ({});
            for (var j = 0; j < candidates.length; j++) {
                var c = candidates[j];
                if (root.ignoredPathSet[c]) dirIgnored[c] = true;
            }
            finish(dirIgnored);
        } else if (root.respectGitignore && candidates.length > 0)
            gitignoreSvc.filter(path, candidates, finish);
        else
            finish({});
    };
    var scheduleOnChange = function() { Qt.callLater(onChange); };
    // Stash the handler in the path-keyed map (NOT on `m` — QML's
    // strict-property mode under `pragma ComponentBehavior: Bound`
    // silently rejects `m._scheduleOnChange = fn` assignments to
    // C++ QObject types like FileSystemModel; the warning emits to
    // the Qt log but the assignment no-ops, leaving disconnect
    // unable to find the function. Storing keyed on `path` works
    // because there is exactly one model per path at any time.
    var newHandlers = Object.assign({}, root._modelHandlers);
    newHandlers[path] = scheduleOnChange;
    root._modelHandlers = newHandlers;
    m.entriesChanged.connect(scheduleOnChange);
    m.loadingChanged.connect(scheduleOnChange);
}

function collapse(root, path) {
    var e = Object.assign({}, root._expanded);
    delete e[path];
    // Recursively forget descendant expansion state
    var prefix = path === "/" ? "/" : path + "/";
    for (var key in root._expanded)
        if (key !== path && key.startsWith(prefix))
            delete e[key];
    root._expanded = e;

    var newModels = Object.assign({}, root._models);
    var cur = newModels[path];
    destroyModel(root, cur, path);
    delete newModels[path];
    for (var key2 in root._models) {
        if (key2 !== path && key2.startsWith(prefix)) {
            var cm = newModels[key2];
            destroyModel(root, cm, key2);
            delete newModels[key2];
        }
    }
    root._models = newModels;

    var newIgnored = Object.assign({}, root._ignored);
    delete newIgnored[path];
    for (var key3 in root._ignored)
        if (key3 !== path && key3.startsWith(prefix))
            delete newIgnored[key3];
    root._ignored = newIgnored;

    rebuildRows(root);
    emitExpandedState(root);
}

function toggle(root, path) {
    if (root._expanded[path]) collapse(root, path);
    else expand(root, path);
}

function refreshAllExpanded(root) {
    // Propagate showHidden to all live models (they re-scan automatically).
    // Also called when respectGitignore changes to rebuild the visible rows.
    for (var path in root._models) {
        var m = root._models[path];
        if (m) m.showHidden = root.showHidden;
    }
    rebuildRows(root);
}

function refreshAll(root) {
    resetTreeState(root);
    if (root.rootPath !== "") {
        // Re-arm auto-expand state (same priority ladder as the mount path) so
        // Shift-R respects restoreExpandedPaths > lazyExpand > initialExpandDepth.
        // Without this, refreshAll would leave _autoExpandActive=false from the
        // previous mount and the tree would always reload collapsed.
        beginMount(root);
    }
}

// Auto-expand fan-out — invoked from the async expand finish callback for each
// directory whose entries just landed. `parentExpansions` is the number of
// fan-out rounds taken from rootPath to reach `parentPath`; rootPath itself = 0,
// its direct children = 1, etc.
//
// We stop recursion if any of these guardrails fire:
//   1. _autoExpandActive went false (BFS settled or rootPath changed)
//   2. parentExpansions >= _autoExpandTargetDepth (budget exhausted)
//   3. models + pending >= _autoExpandModelCeiling (cascade-wide cap on
//      directories instantiated — flips _autoExpandActive false to halt
//      pending in-flight expansions from fanning out further)
//   4. _rows.length >= _autoExpandNodeCeiling (last-resort backstop)
//   5. The parent has > _autoExpandFanoutCap children (predictive skip
//      — saves the I/O cost of expanding hundreds of siblings the user
//      can't reasonably scan visually)
function autoExpandChildrenOf(root, parentPath, parentExpansions) {
    if (!root._autoExpandActive) return;
    if (parentExpansions >= root._autoExpandTargetDepth) return;
    var modelCount = Object.keys(root._models).length + Object.keys(root._pending).length;
    if (modelCount >= MODEL_CEILING) {
        if (!root._autoExpandModelCeilingLogged) {
            Logger.info(
                "FileTreeView",
                "auto-expand: model ceiling reached (" + MODEL_CEILING
                + " directories instantiated), halting cascade"
            );
            root._autoExpandModelCeilingLogged = true;
        }
        root._autoExpandActive = false;
        return;
    }
    if (root._rows.length >= NODE_CEILING) {
        if (!root._autoExpandCeilingLogged) {
            Logger.info(
                "FileTreeView",
                "auto-expand: node ceiling reached (" + NODE_CEILING
                + " rows), leaving remainder collapsed"
            );
            root._autoExpandCeilingLogged = true;
        }
        return;
    }
    var m = root._models[parentPath];
    if (!m) return;
    var entries = m.entries;
    if (entries.length > FANOUT_CAP) {
        if (!root._autoExpandFanoutLogged) {
            Logger.info(
                "FileTreeView",
                "auto-expand: skipping high-fanout dir (" + entries.length
                + " children > " + FANOUT_CAP + " cap): " + parentPath
            );
            root._autoExpandFanoutLogged = true;
        }
        return;
    }
    var ignored = root._ignored[parentPath] || ({});
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e || !e.isDir) continue;
        if (SKIP_NAMES[e.name]) continue;
        if (!root.showHidden && isHidden(e.name)) continue;
        if (root.respectGitignore && ignored[e.path]) continue;
        // pathFilter gate: skip dirs that aren't in the consumer's
        // membership set. This is the load-bearing perf win — a
        // changeset across 4 subtrees instantiates 4 FileSystemModel
        // + QFileSystemWatcher pairs, not the dozens a full
        // recursive expansion would otherwise spawn. The leaf-row
        // filter in rebuildRows is the secondary gate.
        if (root.pathFilter && !root.pathFilter[e.path]) continue;
        // Skip if already expanded, has a model, or is mid-flight —
        // protects against re-entrant expansion of the same path.
        if (root._expanded[e.path] || root._models[e.path] || root._pending[e.path]) continue;
        // Tag the child with its expansion depth so the async finish
        // callback can recover the budget when this dir's entries land.
        var tagged = Object.assign({}, root._autoExpandPending);
        tagged[e.path] = parentExpansions + 1;
        root._autoExpandPending = tagged;
        expand(root, e.path);
    }
}

// Lazy-expand cycle driver. Called from the expand finish callback when
// _lazyExpandActive is true. Synchronously decides whether to expand one more
// directory: if the rendered row count is short of the viewport (plus overscroll
// buffer) AND there's an un-expanded directory in `_rows`, calls expand on it.
// That `expand` adds to `_pending` synchronously, so the finish-callback's
// pendingEmpty check sees we're still working and skips the mount-settle. When
// viewport is full OR no more candidates remain, clears _lazyExpandActive so the
// next pendingEmpty cycle settles the mount.
//
// Cycle re-arm from scroll/resize/density events comes through kickLazyExpand
// below — keep the two entry points distinct so recursive re-entry can't loop on
// an already-active cycle.
//
// Why lazy beats `initialExpandDepth: -1` (the eager BFS cascade): the cascade
// instantiates one FileSystemModel + QFileSystemWatcher per expanded directory —
// on medium-to-large repos (bambin: ~480 dirs) it cap-trips at MODEL_CEILING
// (100 dirs) whose visible-row payoff is small (~30 rows fit in the IDE
// sidebar). Lazy expand follows the user's attention instead of fanning out
// blindly. The single-shot `tree mount settled` diagnostic logs
// `_lazyExpandCount` so we can tell at a glance whether the lazy cycle is
// pulling its weight on a given repo.
function advanceLazyExpand(root) {
    if (!shouldExpandMore(root)) {
        root._lazyExpandActive = false;
        return;
    }
    var next = findNextUnExpandedDir(root);
    if (next === "") {
        root._lazyExpandActive = false;
        return;
    }
    root._lazyExpandCount = root._lazyExpandCount + 1;
    expand(root, next);
}

// Emit `expandedStateChanged` with the current `_expanded` keys as a sorted
// list. Suppressed during a restore cycle to avoid churning the consumer's save
// path while we're replaying their own saved set back at them — see the signal
// docstring for the full rationale. The sort keeps the emitted list stable
// across consumers that diff it for change detection.
function emitExpandedState(root) {
    // Suppress during restore cycle (replaying saved state — consumer
    // already holds this set) and during the initial mount cascade
    // (_mountInFlight covers lazyExpand + BFS auto-expand — emitting
    // on every directory settle during a 100-dir cascade churns the
    // consumer's atomic-write path with partial sets).
    if (root._restoreActive || root._mountInFlight) return;
    var keys = Object.keys(root._expanded);
    keys.sort();
    root.expandedStateChanged(keys);
}

// Restore-cycle advance: called from the `expand` finish callback whenever a
// model has just settled at `expandedPath`. Walks `_restorePending` and
// dispatches `expand` for every queued path whose parent is exactly
// `expandedPath`. The "exact parent" check matters: queue is sorted
// shortest-first, so all direct children of a just-settled parent are clustered
// contiguously. We pop them off in one pass, leaving deeper descendants in the
// queue until their own parents settle.
//
// Termination: when the queue drains, clear `_restoreActive` so the
// mount-settled emit in the `expand` finish callback fires on the next
// pendingEmpty cycle. If `expandedPath` has no matching children in the queue
// (e.g. the saved set skipped over a level), this is a no-op — the queue might
// still have entries whose parents haven't been visited yet, in which case the
// eventual pendingEmpty fallback in the finish callback clears the active flag
// and force-empties the queue.
function advanceRestoreFor(root, expandedPath) {
    if (!root._restoreActive) return;
    var queue = root._restorePending;
    if (!queue || queue.length === 0) {
        root._restoreActive = false;
        return;
    }
    var prefix = expandedPath === "/" ? "/" : expandedPath + "/";
    var remaining = [];
    var toExpand = [];
    for (var i = 0; i < queue.length; i++) {
        var p = queue[i];
        // Direct-child check: starts with parent's path-prefix AND
        // has no further `/` after that prefix (i.e. one level deeper).
        if (p.startsWith(prefix)) {
            var tail = p.substring(prefix.length);
            if (tail.length > 0 && tail.indexOf("/") < 0) {
                toExpand.push(p);
                continue;
            }
        }
        remaining.push(p);
    }
    root._restorePending = remaining;
    // Second-pass rescue: if this node had no direct children in the
    // queue but the remaining list contains paths whose parent is
    // already in _expanded (e.g. an intermediate ancestor was omitted
    // from the cache), dispatch those now rather than waiting for
    // pendingEmpty to force-clear them. Handles the case where the
    // cached set skips a level (e.g. saved ["/a/b", "/a/b/c/d"] but
    // not "/a/b/c") — without this, "/a/b/c/d" would be silently
    // abandoned once "/a/b" settles with no matching children.
    if (toExpand.length === 0 && remaining.length > 0) {
        var rescued = [];
        var stillPending = [];
        for (var r = 0; r < remaining.length; r++) {
            var rp = remaining[r];
            var lastSlash = rp.lastIndexOf("/");
            var parentPath = lastSlash > 0 ? rp.substring(0, lastSlash) : "/";
            if (root._expanded[parentPath]) {
                rescued.push(rp);
            } else {
                stillPending.push(rp);
            }
        }
        root._restorePending = stillPending;
        for (var s = 0; s < rescued.length; s++) {
            expand(root, rescued[s]);
        }
        if (rescued.length === 0 && stillPending.length === 0) {
            root._restoreActive = false;
        }
        return;
    }
    for (var t = 0; t < toExpand.length; t++) {
        expand(root, toExpand[t]);
    }
}

// External re-arm: called when the user scrolls, the viewport resizes, or
// compactScale changes. No-op when:
//   - lazyExpand isn't enabled,
//   - a cycle is already in flight (_lazyExpandActive flag),
//   - the initial mount is still draining its pending queue,
//   - or there's other expansion work in flight from manual user toggles.
// The order of guards matters: cheapest checks first so the typical mid-scroll
// path (cycle already active OR plenty of buffer) bails before we touch
// row-height math.
function kickLazyExpand(root) {
    if (!root.lazyExpand) return;
    if (root._lazyExpandActive) return;
    if (root._mountInFlight) return;
    if (Object.keys(root._pending).length > 0) return;
    if (!shouldExpandMore(root)) return;
    root._lazyExpandActive = true;
    advanceLazyExpand(root);
}

// Pixel height of one tree row. Rows are uniform, so this is the single
// index<->pixel conversion factor for all viewport math (shouldExpandMore's
// visible-bottom calc and rebuildRows' scroll anchoring). MUST stay equal to
// the delegate's rendered height (FileTreeRow.qml's implicitHeight, which is
// itemHeight * compactScale) — any drift silently corrupts scroll positioning.
function rowHeight(root) {
    return Config.fileManager.sizes.itemHeight * root.compactScale;
}

// Returns true when the rendered tree has fewer rows below the visible viewport
// bottom than _lazyExpandBufferRows. Synchronous on `_rows` length + cached row
// height — does NOT depend on `view.contentHeight`, which lags `_rows` mutations
// by a layout cycle.
function shouldExpandMore(root) {
    if (Object.keys(root._pending).length > 0) return false;
    var rh = rowHeight(root);
    if (rh <= 0) return false;
    var visibleBottomRow = Math.ceil((view.contentY + view.height) / rh);
    var rowsBeyond = root._rows.length - visibleBottomRow;
    return rowsBeyond < LAZY_BUFFER_ROWS;
}

// First-in-row-order un-expanded directory. We mirror the same skip filters as
// autoExpandChildrenOf — .git etc. — even though most of them are also enforced
// by the FileSystemModel + rebuildRows pipeline. Belt-and-suspenders here is
// cheap and keeps the lazy path's behaviour identical to the BFS path's when
// ambiguous.
function findNextUnExpandedDir(root) {
    var rows = root._rows;
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r.isDir) continue;
        if (r.expanded) continue;
        if (SKIP_NAMES[r.name]) continue;
        // Hidden + ignored entries are already absent from `_rows` (they
        // get filtered in rebuildRows), so no explicit check needed.
        return r.path;
    }
    return "";
}

function rebuildRows(root) {
    // Capture cursor by PATH before reassigning the model array.
    // Reassigning ListView.model to a fresh JS array resets currentIndex,
    // so an integer-only preservation strategy is unreliable. Path-based
    // restore also keeps the cursor stable across file-watcher mutations
    // (inserts/removes that shift indices around the cursor).
    var prevPath = root.currentRow ? root.currentRow.path : "";
    // Capture the viewport-top anchor BEFORE reassigning the model. Reassigning
    // ListView.model to a fresh array zeroes contentY, so we must re-establish
    // the scroll position afterwards. We anchor on the ROW AT THE VIEWPORT TOP
    // (not the cursor — see the restore block below for why): record its path
    // and the sub-row pixel offset, then after the rebuild we scroll so that
    // same row sits at the same place. This keeps whatever the user is looking
    // at visually stationary regardless of where rows were inserted/removed.
    var prevContentY = view.contentY;
    var rh = rowHeight(root);
    var prevTopIndex = rh > 0 ? Math.floor(prevContentY / rh) : 0;
    var prevSubRowOffset = prevContentY - prevTopIndex * rh;
    // root._rows is still the OLD array here (reassigned below).
    var prevTopPath = (root._rows && prevTopIndex >= 0 && prevTopIndex < root._rows.length)
        ? root._rows[prevTopIndex].path : "";

    var newRows = [];
    var visited = ({});
    var walk = function(parentPath, depth) {
        if (visited[parentPath]) return;
        visited[parentPath] = true;
        var m = root._models[parentPath];
        if (!m) return;
        var entries = m.entries;
        var ignored = root._ignored[parentPath] || ({});
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e) continue;
            if (!root.showHidden && isHidden(e.name)) continue;
            if (root.respectGitignore && ignored[e.path]) continue;
            // pathFilter gate (leaf-row): hide entries not in the
            // consumer's set. Pairs with the same gate in
            // autoExpandChildrenOf — this one catches mixed dirs
            // (some children in-set, some out-of-set) once they're
            // already expanded.
            if (root.pathFilter && !root.pathFilter[e.path]) continue;
            newRows.push({
                "path": e.path,
                "name": e.name,
                "isDir": e.isDir,
                "depth": depth,
                "expanded": !!root._expanded[e.path],
                "entry": e
            });
            if (e.isDir && root._expanded[e.path])
                walk(e.path, depth + 1);
        }
    };
    walk(root.rootPath, 0);
    root._rows = newRows;

    // Fuzzy-finder pending focus takes precedence over path-based restore:
    // the user explicitly asked for this file. Match name + depth=0 because
    // the popup always navigates to the file's parent, so the picked file
    // is a direct child of the new rootPath.
    var restored = -1;
    var viaPendingFocus = false;
    if (root._pendingFocusName !== "") {
        for (var f = 0; f < newRows.length; f++) {
            if (newRows[f].name === root._pendingFocusName && newRows[f].depth === 0) {
                restored = f;
                viaPendingFocus = true;
                break;
            }
        }
        // Always consume _pendingFocusName — keeping it set when the file
        // isn't found on THIS rebuild causes every future rebuild to attempt
        // the same stale match, potentially hijacking cursor placement for
        // unrelated file-watcher or expand/collapse events.
        root._pendingFocusName = "";
    }
    if (restored < 0 && prevPath !== "") {
        for (var g = 0; g < newRows.length; g++) {
            if (newRows[g].path === prevPath) { restored = g; break; }
        }
    }
    // --- Cursor restoration (currentIndex) — independent of the viewport ---
    if (restored >= 0) {
        view.currentIndex = restored;
    } else if (view.currentIndex >= newRows.length) {
        view.currentIndex = Math.max(0, newRows.length - 1);
    }

    // --- Viewport restoration (contentY) ---
    // Reassigning the model zeroed contentY; re-establish the scroll position.
    if (viaPendingFocus && restored >= 0) {
        // Fuzzy-finder navigation is an EXPLICIT jump to a row — bring it into
        // view rather than preserving the old scroll position.
        view.positionViewAtIndex(restored, ListView.Contain);
    } else if (rh > 0) {
        // REGRESSION GUARD — do NOT re-anchor the viewport on the CURSOR (e.g.
        // positionViewAtIndex(currentIndex, ListView.Contain)).
        //
        // rebuildRows fires on lazy-expand, which is driven by the user
        // scrolling (onContentYChanged -> kickLazyExpand). Anchoring the
        // restored viewport on the cursor snaps the tree upward on every scroll
        // tick: during a mouse/trackpad scroll the cursor stays parked while the
        // viewport moves away, so Contain force-scrolls the off-screen cursor
        // back into view (the original "scroll jumps back up" bug). Keyboard nav
        // never hit it because it moves the cursor WITH the scroll.
        //
        // Anchor on the row that was at the VIEWPORT TOP instead: find that
        // row's new index and restore the same sub-row pixel offset. This is
        // correct no matter where rows were inserted/removed — above, below, or
        // straddling the viewport. (A cursor-index delta only accounts for rows
        // above the cursor, so it mis-anchors when an expansion lands between the
        // viewport top and the cursor.)
        //
        // forceLayout() first is load-bearing: a fresh model leaves
        // contentHeight stale (delegates not yet created), so BOTH the contentY
        // assignment and the maxY clamp would otherwise run against stale
        // geometry and still snap partway. forceLayout flushes the model change
        // synchronously, so view.contentHeight is final and authoritative for
        // the clamp (no need to reconstruct it from row count).
        view.forceLayout();
        var maxY = Math.max(0, view.contentHeight - view.height);
        var newTopIndex = -1;
        if (prevTopPath !== "") {
            for (var t = 0; t < newRows.length; t++) {
                if (newRows[t].path === prevTopPath) { newTopIndex = t; break; }
            }
        }
        if (newTopIndex >= 0) {
            // Put the old top row back at the same pixel position.
            view.contentY = Math.max(0, Math.min(newTopIndex * rh + prevSubRowOffset, maxY));
        } else {
            // The old top row was collapsed away — preserve the raw offset so
            // the view at least doesn't snap to the top.
            view.contentY = Math.max(0, Math.min(prevContentY, maxY));
        }
    }

    // Re-compute search matches against the new row list — expand/collapse
    // changes the set of visible rows, so previous indices are now stale.
    if (root.windowState && root.windowState.searchQuery !== "")
        computeMatches(root, true);

    // Same staleness concern for flash: row indices in flashCurrentMatchMap
    // reference the OLD row order, so re-resolve against the new rows.
    // Cache invalidation alone isn't enough — the active session's per-row
    // match map needs to be recomputed against the new index space.
    TreeFlashHandler.invalidateEntryCache();
    if (root.windowState && root.windowState.flashActive)
        TreeFlashHandler.recompute(root, view);
}

function halfPageCount() {
    return Math.max(1, Math.floor(view.height / Config.fileManager.sizes.itemHeight / 2));
}

// Search — matches against `_rows` (the flattened DFS list), so only currently-
// visible nodes match. Collapsed subtrees are intentionally out of scope per the
// v1 spec ("every visible element").
function computeMatches(root, preservePosition) {
    if (!root.windowState) return;
    var query = root.windowState.searchQuery.toLowerCase();
    if (query === "") {
        root.windowState.matchIndices = [];
        root.windowState.currentMatchIndex = -1;
        return;
    }
    var rows = root._rows;
    var indices = [];
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].name.toLowerCase().indexOf(query) !== -1)
            indices.push(i);
    }
    root.windowState.matchIndices = indices;
    if (indices.length === 0) {
        root.windowState.currentMatchIndex = -1;
    } else if (preservePosition) {
        var prev = view.currentIndex;
        var pos = indices.indexOf(prev);
        root.windowState.currentMatchIndex = pos >= 0 ? pos : 0;
    } else {
        root.windowState.currentMatchIndex = 0;
    }
    // Always jump after recomputing — currentMatchIndexChanged won't fire
    // if the value stays numerically the same (e.g. 0→0) even though
    // matchIndices changed and the target row is different. Reuses the
    // shared, source-agnostic jump helper (same as FileList's search).
    SearchHandler.jumpToCurrentMatch(root, view);
}

function jumpToParent(root) {
    var cur = root.currentRow;
    if (!cur || cur.depth === 0) return;
    for (var i = view.currentIndex - 1; i >= 0; i--) {
        if (root._rows[i].depth === cur.depth - 1) {
            view.currentIndex = i;
            view.positionViewAtIndex(i, ListView.Contain);
            return;
        }
    }
}

function activate(root, row) {
    if (!row) return;
    if (row.isDir) toggle(root, row.path);
    else root.fileActivated(row.path);
}

// onPathFilterChanged re-arm. pathFilter changes are frequent (a git-status
// watcher emits a new map per working-tree change). When auto-expand is
// configured AND a filter remains, re-arm the cascade against every settled
// model so newly-arrived in-set paths under unexplored dirs become reachable —
// the autoExpandChildrenOf guardrail caps still bound worst-case I/O. We do NOT
// touch _expanded / _models / _pending: expanded stays expanded, user-collapsed
// stays collapsed, in-flight expansions race to completion. No-op when
// auto-expand is off or no filter is present.
function rearmAutoExpandForFilter(root) {
    if (root.initialExpandDepth === 0 || !root.pathFilter) return;
    root._autoExpandActive = true;
    root._autoExpandCeilingLogged = false;
    root._autoExpandFanoutLogged = false;
    root._autoExpandModelCeilingLogged = false;
    for (var parent in root._models) {
        var taken = root._autoExpandPending[parent] !== undefined
            ? root._autoExpandPending[parent]
            : 0;
        autoExpandChildrenOf(root, parent, taken);
    }
    if (Object.keys(root._pending).length === 0)
        root._autoExpandActive = false;
}

// Fuzzy finder picked a file in some directory. The popup emits its signal
// BEFORE calling navigate(parentPath) so we capture the name first; if the
// parent is reached via tree retarget, rebuildRows consumes _pendingFocusName
// once the children land. The same-dir case (file's parent === current
// rootPath) bypasses that path because navigate() is a no-op on an unchanged
// path, so we focus immediately here.
//   depth === 0: only direct children of rootPath — the popup always navigates
//   to the file's parent before emitting, so the picked file is guaranteed to
//   be a depth-0 row in the CURRENT tree.
function focusFuzzyResult(root, filename) {
    root._pendingFocusName = filename;
    for (var i = 0; i < root._rows.length; i++) {
        if (root._rows[i].name === filename && root._rows[i].depth === 0) {
            view.currentIndex = i;
            view.positionViewAtIndex(i, ListView.Contain);
            root._pendingFocusName = "";
            return;
        }
    }
}
