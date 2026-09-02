# Mesura Code

Mesura Code is a private fork of **T3 Code**, maintained by one developer for one developer's workflow. Upstream lives at https://github.com/pingdotgg/t3code and is worth reading directly.

The product is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients. T3 Code is an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor; this fork inherits all of that and changes very little of it.

## What this fork is, and is not

Be accurate about the difference, because most of this repository's engineering judgement follows from it.

**T3 Code** is a large open source project: Theo, Julius and a substantial community build it, it has over 200,000 users, its roadmap and code are public, and many of those users run forks of their own.

**Mesura Code** has none of that. It is a single person's fork, private, with no users but its author. It exists to fit one specific workflow, not to compete with upstream and not to diverge from it. Nothing in this repository should claim otherwise — no user counts, no community, no openness we do not have.

Four things follow. The first is this fork's own; the other three are upstream's standards, inherited and worth keeping.

### 1. Upstream keeps moving, and we keep pulling

This is the fork's first constraint and it outranks local tidiness.

Every week we fetch `upstream/main`, read what T3 shipped, and merge what is useful — security fixes especially, then bug fixes, then features. That only stays affordable while our own diff stays small and shallow.

What follows from it, in order of how often it bites:

- **A line changed inside an upstream file is a merge conflict every week, forever.** A new file of our own is free. Prefer adding beside upstream code over editing it.
- **Disabling beats deleting.** When a feature is one we will not use, turn it off through a setting or a default it already has, rather than removing its code. Deletion is the change most likely to conflict and hardest to undo at merge time.
- **A refactor that is locally tidier but touches more upstream lines is usually the wrong call here.** That includes changes this repository would otherwise want, such as extracting a repeated literal into a shared constant.
- **Before restructuring upstream code, say what it costs at the next merge.** If the answer is unknown, measure it: `git log --oneline --since="3 months ago" upstream/main -- <path>` tells you how often that file moves.
- **Do not break things that will hurt later.** A change that works today but sits across a file upstream rewrites often is a recurring cost, not a one-time one.

Where this fork already differs from upstream is listed in `.factory/` and in the commits with a `mesura` scope. Keep that list short.

**Running the sync.** The full procedure is in `.factory/mesura-code-identity-plan.md`. Four things about it are not guessable, and each one failed silently the first time — none of them announced itself as an error:

- **Read the conflict surface before merging**, as the intersection of what upstream touched and what we touched: `git diff --name-only <last-sha>..upstream/main` against `…<last-sha>..HEAD`, then `comm -12`. It is far smaller than either side. The first sync had 104 upstream files and 240 of ours, 11 in common, and one real conflict.
- **Use Node 24 via nvm, never the system's Node 26.** Node 26 breaks `extract-zip` in electron's postinstall and exits 0 having written 548 KB of a 310 MB archive. Skip `pnpm install` entirely when the lockfile did not change.
- **Never run bare `pnpm test`** — it exhausts the machine's RAM. Run per package, serially, with `--max-workers`. Watch the path depth: `apps/*` and `packages/*` need `../../node_modules`, but `tests/` and `scripts/` need `../node_modules`. With the wrong depth the command prints nothing and reads as a pass.
- **gitleaks does not scan merge commits.** Pointing it at one reports `0 commits scanned` and `no leaks found`, which reads as a pass. Scan the upstream range instead, which is where the content came from.

**Pin upstream's facts, do not delete them.** Where our own text has to restate something upstream asserts — a user count, a supported platform, a version — attribute it to T3 rather than dropping it. Then upstream changing that fact is a one-line conflict that shows up, instead of a stale claim that never does. This is how the first sync caught the user count moving from 100,000 to 200,000.

**A guard may not pin a number that is upstream's to change.** Assert a floor and assert that the suite is green; never an exact count. The first sync broke a guard that pinned upstream's contract-test total at 257 when upstream added one test — everything was green and the guard still failed. See `tests/unit/symmetria-phase-one.test.ts`.

### 2. Performance without compromise

Upstream avoided the bad tech decisions and "slop" that bog comparable apps down, and its performance is a standard this fork inherits rather than one it earned. Regressions usually come from sending too much data over websockets, css animations causing gpu spikes, and lists that are hard to render. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The websocket layer (`npx t3`) is what enables the remote features, and they are core to the product. Connecting over a local network and connecting over Tailscale both need to keep working. T3 Connect — upstream's tunnel solution, whose code is also in this repo — is operated by T3, not by us: we do not run that service, and nothing here should imply we do.

### 4. Surfaces, and which two matter here

The product has three surfaces: **web**, **desktop**, and **mobile**. Upstream weights them differently than this fork does.

**Two are the ones this fork is actually used on**, and they are where a change has to be correct:

- **Desktop on Linux.** A full Electron app that bundles the server runner. It is also the host server, so the other surfaces connect to it.
- **Mobile on Android.** A React Native app, used to drive work remotely against that desktop host.

**The rest stay supported, not prioritised**: the web app in both its forms — served locally by `npx t3`, and built for a hosted deployment, which upstream runs at `app.t3.codes` and this fork does not run at all — plus desktop on macOS and Windows, and mobile on iOS. Do not break them, do not remove them, and keep contracts honest across all of them. They simply do not earn the same verification effort, and a change does not need a pass on them before it ships here.

## Quality decides, merge cost informs

What this fork wants is the best code it can carry. It is driven every day by
the person who maintains it, so a shortcut here is not paid once at review — it
is paid every day, by the only user, forever.

Principle 1 above is real and every design has to price it. It is an **input to
the decision, not the decision.**

- **Never choose a hacky design because it conflicts less.** "It touches no
  upstream file" is an argument, not a verdict. A design that is worse to use or
  worse to maintain does not become right by being cheap at merge time.
- **When the better design costs more upstream, take it and say what it costs.**
  Name the files, give their commit rate, and record the trade in the decision —
  an accepted cost and an overlooked one look identical six months later.
- **Where a cheap variant is genuinely as good, it wins on the merge cost.** The
  constraint is a tiebreaker between comparable designs, and it decides many of
  them. It just does not get to break a tie it should have lost.

The failure this prevents is specific and it is easy to walk into: enumerating
the conflict surface of each option, then picking the lowest number. That
comparison reads as rigour, because the numbers are real and measured. It is
still the wrong question whenever the options are not equally good.

Decisions recorded under this rule live in `docs/mesura/adr-*.md`. The current
one on windowing is `adr-002-one-window-many-projects.md`; `adr-001` is kept
superseded because _why_ it was wrong is the reusable part — it compared two
candidates against each other and never against the architecture already running.

## A note from Theo

Kept verbatim from upstream. Theo is T3 Code's original creator; this is his note, not ours, and it is here because it is good advice rather than because we wrote it.

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most Mesura Code contributions will come from Mesura Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the Mesura Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Mesura Code.
- **we, us, and the developer** mean the one person who maintains this fork. That is who you are talking to now. There is no team and no other maintainer.
- **upstream** means T3 Code, the project this is forked from, and by extension its maintainers. Upstream is not "us": when a decision, a file, or a piece of copy belongs to them, say so.
- **user** means the person using Mesura Code to direct coding agents. Here that is the same person as the developer.
- **agent** means the coding agent a user runs inside Mesura Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness Mesura Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **the home** means the base data directory, `~/.mesura-code`. Runtime state normally lives below its `userdata` directory. `T3CODE_HOME` still names the environment variable that overrides it; the variable kept upstream's name deliberately, because renaming it would touch five upstream files to no user-visible benefit.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to a live install.** There are **two** on this machine, and neither is yours. `~/.mesura-code/userdata` is this fork's real database. `~/.t3/userdata` belongs to the **installed T3 Code**, a separate application the developer also runs daily — it is not a stale copy of ours and it is not ours to touch at all. Reading either and copying from it is fine, and is a good way to get real test data (see Test data). Never start a server against either, never open either read-write, never clean either up. The default home moved to `~/.mesura-code` precisely so this fork cannot reach the other one by accident; do not undo that by pointing a command at `~/.t3`.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, and OpenCode each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.mesura-code/userdata` (the developer's real data for this fork, the most realistic test set) or `~/.mesura-code/dev`. Worktree state lives at `<worktree>/.t3/userdata` — that path keeps upstream's name on purpose, because a worktree-local directory cannot collide with anything.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.mesura-code/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- **`pnpm test` can take the machine down, and this is measured, not theoretical.** The root config's `test.maxWorkers` reaches only `apps/server`, because it is the one package that composes the root config; `apps/web`, `apps/mobile`, `apps/desktop` and `infra/relay` each open their own default-sized pool. A full run reached load 38 with swap fully exhausted and had to be killed. If a full run is genuinely asked for, run it package by package with an explicit bound — `vp test run --max-workers=3` from inside each package — and never in parallel with another. Tracked as issue #3.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- **Verify a user-visible frontend change before reporting it done**, so what reaches the developer differs on taste rather than on whether it works. The preview tool needs no permission and shows nothing on screen with `open: false`. Its automation channel does not reach Mesura Code's own web app today (issue #36); until it does, this app's own UI is proved by targeted tests plus the instance below. `test-t3-app` and `test-t3-mobile` set the clients up.
- **Then leave that instance running.** `vp run dev` in the background, handing over the pairing URL with its token — the developer tests from a browser, so that is the default. When only the desktop shell shows the change, do every step up to the window and hand over the exact command; opening a window is theirs to run. Stop only what you started, by the PID you captured.
- Subagents do not launch their own dev servers. A headed browser still needs asking — Playwright `--headed` and headed chrome-devtools put windows on the developer's desktop, which the preview tool never does.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling. This fork keeps its own working material in `.factory/`, gitignored for the same reason.
- Track active work in the GitHub issue that owns it, on this fork's own repository. Upstream's contributor process in `CONTRIBUTING.md` describes T3 Code, not this fork.
- Put durable architecture, constraints, and decisions in `docs/internals/`. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native.
- `apps/marketing` - **upstream's** public site, including the Terms of Service, Privacy Policy and Security Policy of T3 Tools, Inc. This fork does not publish any of it. Never rebrand these pages: a privacy policy carrying our name would be a legal document we never wrote, describing services we do not operate.
- `infra/relay` - **upstream's** T3 Connect relay, which T3 operates and we do not. Same rule as above.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- This is driven all day, and a dropped frame, a lying spinner and a stale label all get noticed. One user rather than a hundred thousand does not lower the bar — it removes the excuse that someone else would have reported it. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Computer use and headed browsers need the developer's agreement. The preview tool does not, and verifying with it is expected rather than optional — see _Verifying_.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
