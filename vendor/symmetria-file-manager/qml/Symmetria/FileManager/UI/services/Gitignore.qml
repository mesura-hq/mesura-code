pragma ComponentBehavior: Bound

// Gitignore — per-instance service that filters child paths through
// `git check-ignore --stdin`, with per-directory caching keyed on the
// directory's .gitignore mtime (so edits to .gitignore invalidate the
// cache without restarting the daemon).
//
// Used by FileTreeView to skip ignored entries when respectGitignore is on.
// Combines stat + check-ignore in a single shell pipeline so we pay one
// process spawn per directory instead of two.
//
// Sequential execution: only one git invocation runs at a time per Gitignore
// instance. Concurrent filter() calls are queued and drained in onExited.

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick

QtObject {
    id: root

    property bool enabled: true

    // dirPath -> { mtime: number, ignored: { absChildPath: true, ... } }
    property var _cache: ({})

    // Queue of pending requests: [{ dirPath, candidates, callback }, ...]
    property var _queue: []
    property var _active: null

    property ShellRunner _runner: ShellRunner {
        id: runner
        onExited: (exitCode, exitStatus) => root._onRunnerExited(exitCode, exitStatus)
    }

    function clear(): void {
        _cache = {};
    }

    function filter(dirPath: string, candidates: var, callback: var): void {
        if (!enabled || !candidates || candidates.length === 0) {
            callback({});
            return;
        }
        const cached = _cache[dirPath];
        if (cached) {
            callback(cached.ignored);
            return;
        }
        _queue.push({ dirPath: dirPath, candidates: candidates.slice(), callback: callback });
        _drain();
    }

    function _drain(): void {
        if (_active !== null || _queue.length === 0)
            return;
        const job = _queue.shift();
        _active = job;
        // Combined pipeline: print .gitignore mtime first (or empty line if missing),
        // then run check-ignore on the candidates piped via stdin. Both errors and
        // a non-zero check-ignore exit (no matches) are absorbed by 2>/dev/null + exit 0.
        const script = 'cd "$1" && stat -c %Y .gitignore 2>/dev/null; echo ""; git check-ignore --stdin 2>/dev/null; exit 0';
        runner.workingDirectory = job.dirPath;
        runner.command = ["sh", "-c", script, "--", job.dirPath];
        runner.start();
        runner.write(job.candidates.join("\n") + "\n");
        runner.closeWriteChannel();
    }

    function _onRunnerExited(exitCode: int, exitStatus: int): void {
        const job = _active;
        _active = null;
        if (!job) {
            _drain();
            return;
        }
        const out = runner.stdoutText || "";
        const lines = out.split("\n");
        // First line is the .gitignore mtime (or empty if missing), separator
        // empty line, then ignored paths follow. We tolerate any layout by
        // taking the first non-empty leading numeric line as mtime and
        // treating everything after the first empty line as ignored paths.
        let mtime = 0;
        let ignoredStart = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line === "") {
                ignoredStart = i + 1;
                break;
            }
            const num = parseInt(line, 10);
            if (!isNaN(num))
                mtime = num;
        }
        const ignored = {};
        for (let i = ignoredStart; i < lines.length; i++) {
            const line = lines[i];
            if (line !== "")
                ignored[line] = true;
        }
        const newCache = Object.assign({}, _cache);
        newCache[job.dirPath] = { mtime: mtime, ignored: ignored };
        _cache = newCache;
        try {
            job.callback(ignored);
        } catch (e) {
            Logger.warn("Gitignore", "filter callback threw: " + e);
        }
        _drain();
    }
}
