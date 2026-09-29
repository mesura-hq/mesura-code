# Mesura Code server discovery fixture

A `procRoot` for `mesuraServerDiscovery.ts`, plus the state homes its processes point at. Tests do not read this tree in place: `mesuraServerDiscovery.test.ts` stages a copy in a temp directory, because real `/proc` holds absolute paths.

Staging does three things:

- `@ROOT@` in every `environ` and `cmdline` is replaced with the staged `root/` directory.
- `cwd.target` becomes a `cwd` symlink to that path (with `@ROOT@` replaced), and the target directory is created.
- Only the PIDs a spec names are staged, so each spec states which processes the host runs.

`proc/stat` carries the real `btime` of vigilia-home (1790621781). Clock ticks are 100 per second. The `stat` lines are a real line from vigilia-home with the PID, `comm`, parent PID and start time (field 22) replaced. `status` keeps only the fields up to `Gid`.

| PID     | Process                                                                  | Runtime file                                                                        | Expected       |
| ------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------- |
| 1163    | installed `t3 serve`, default home (real argv and times)                 | default home `userdata`, own PID, written 9.167 s after start                       | installed      |
| 17807   | `node --watch src/bin.ts`, the dev watcher parent                        | the worktree home's file names its child                                            | not counted    |
| 2606635 | the dev server the watcher runs (real argv tail and times)               | worktree home `userdata` with `devUrl`, written 5.933 s after start                 | dev            |
| 6060    | `node src/bin.ts` without `T3CODE_HOME`                                  | default home `dev` with `devUrl`, 4.412 s after start                               | dev            |
| 4242    | `t3 serve` on a reused PID                                               | own PID, but `startedAt` two hours before the process started                       | not counted    |
| 5151    | a dev server in a worktree                                               | stale: names PID 9999, which is not running                                         | not counted    |
| 7070    | `t3 pair`, a short-lived CLI                                             | the default home's file names 1163                                                  | not counted    |
| 8080    | `t3 serve`                                                               | own PID, written 11 s after start: outside the 10 s window                          | not counted    |
| 9090    | `t3 serve` owned by uid 1001                                             | own PID, 2 s after start                                                            | not counted    |
| 3773    | the desktop app's bundled server (`electron …/dist/bin.mjs`)             | none                                                                                | only as itself |
| 2222    | `-bash`                                                                  | none                                                                                | not counted    |
| 3100    | bare `t3` with no subcommand                                             | own home, 3 s after start                                                           | installed      |
| 3200    | `node dist/bin.mjs --base-dir …` in `apps/server`                        | only under `--base-dir`; its `T3CODE_HOME` has no file                              | installed      |
| 3300    | a second desktop app's bundled server                                    | own home, 3 s after start                                                           | installed      |
| 3400    | `node …/_npx/…/node_modules/t3/dist/bin.mjs serve`                       | own home, 3 s after start                                                           | installed      |
| 3500    | `/usr/bin/mesura-code start`                                             | own home, 3 s after start                                                           | installed      |
| 3600    | `node <absolute>/apps/server/src/bin.ts`                                 | own home with `devUrl`, 3 s after start                                             | dev            |
| 3700    | a desktop app's bundled server run with another `HOME`, no `T3CODE_HOME` | under its own `HOME`, 3 s after start                                               | installed      |
| 3800    | `node src/bin.ts` on a reused PID                                        | `userdata`: its PID, two hours stale; `dev`: its PID with `devUrl`, 3 s after start | dev            |
| 3900    | `t3 serve` whose environment has neither `T3CODE_HOME` nor `HOME`        | `homes/no-home`, which a spec passes as the counting server's default home          | installed      |

Deliberate edits:

- 6060's `comm` is `node ) S 1`, so a parser that splits `stat` at the first `)` reads the wrong start time. The kernel allows any bytes in `comm`.
- The worktree state homes are named `state`, not `.t3`, because the repository's `.gitignore` ignores `.t3` at any depth.
