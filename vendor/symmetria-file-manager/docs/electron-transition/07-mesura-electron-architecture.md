# 07 — Mesura Code: the Electron and monorepo foundations

Research notes on `/home/jc/projects/mesura-code`, branch `main`, a private fork of
`pingdotgg/t3code`. Scope: the Electron process model, the IPC layer, window
management, the renderer stack, Effect-TS conventions, the existing Symmetria
bridge, the native-code pipeline, and the quality gates. The file-browsing UI is
document 08 and is not covered here.

All paths are relative to the repository root unless stated otherwise. All line
references were read on 2026-08-24.

---

## 0. The house rules that govern every decision

`AGENTS.md` is the rulebook and it overrides local taste. Four rules decide where
new code goes.

- **Upstream is merged every week, so the fork's diff must stay small and
  shallow** (`AGENTS.md:17-31`). A new file of our own is free. A line changed
  inside an upstream file is a merge conflict every week, forever.
- **Disabling beats deleting** (`AGENTS.md:26`). A feature we do not want is
  turned off through a setting, not removed.
- **Quality decides, merge cost informs** (`AGENTS.md:63-85`). A worse design does
  not become right by conflicting less. When the better design costs more
  upstream, take it and record the cost.
- **Every surface must be hit** (`AGENTS.md:127-137`). Web, desktop and mobile all
  consume the same contracts, so a contract change propagates to four places.

Measured churn in `upstream/main` over the three months to 2026-08-24
(`git log --oneline --since="3 months ago" upstream/main -- <path> | wc -l`). This
is the number that prices any edit:

| Path | Commits |
|---|---|
| `apps/web/src` | 587 |
| `packages/` | 269 |
| `apps/desktop` (whole app) | 154 |
| `packages/contracts/src/ipc.ts` | 39 |
| `apps/desktop/src/window` | 38 |
| `apps/desktop/src/preload.ts` | 22 |
| `apps/desktop/src/main.ts` | 21 |
| `apps/desktop/src/ipc/channels.ts` | 19 |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts` | 14 |

A **new directory** inside any of these paths has a churn of zero. The fork has
already used that fact twice: `apps/desktop/src/symmetria/` and
`apps/web/src/symmetria/` are fork-owned directories inside upstream apps, and
neither has ever conflicted.

---

## 1. Process model

### 1.1 Entry point

`apps/desktop/package.json:6` sets `"main": "dist-electron/main.cjs"`. That file is
built from `apps/desktop/src/main.ts` by `vp pack` (see §9.3).

`src/main.ts` is 224 lines and contains no imperative logic. It is a **layer
assembly file**: it imports about fifty Effect service modules, composes them into
one `desktopRuntimeLayer`, and hands it to the program.

```ts
// apps/desktop/src/main.ts:223
DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
```

The layer graph is explicit and ordered (`src/main.ts:119-221`):

- `electronLayer` — one service per Electron API surface: `ElectronApp`,
  `ElectronDialog`, `ElectronMenu`, `ElectronPowerMonitor`, `ElectronProtocol`,
  `ElectronSafeStorage`, `ElectronShell`, `ElectronTheme`, `ElectronUpdater`,
  `ElectronWindow`, plus `DesktopIpc.layer(Electron.ipcMain)` (`src/main.ts:130`).
- `desktopFoundationLayer` — state, shutdown, settings, connection catalog,
  assets, observability, all provided the `DesktopEnvironment`.
- `desktopWindowLayer` = `DesktopWindow` over server exposure and the preview
  manager.
- `desktopBackendLayer` — the backend process pool, over the window layer.
- `desktopApplicationLayer` — lifecycle, application menu, Linux URL handler,
  shell environment, **`SttDelivery`**, **`ThreadPublisher`**, SSH.
- `desktopClerkLayer` is acquired **before** the application layer, because
  Clerk's `userData` resolution can yield and let Electron emit `ready`
  (`src/main.ts:214-221`).

### 1.2 What the main process owns

The main process owns everything privileged:

- The window set (`ElectronWindow`, `DesktopWindow`).
- The IPC registry (`DesktopIpc`).
- The custom `t3code://app` protocol that serves the renderer
  (`src/electron/ElectronProtocol.ts:11-25`).
- **The backend server as a child process** — not an import. `DesktopBackendPool`
  spawns `apps/server/dist/bin.mjs` with `ELECTRON_RUN_AS_NODE=1`, passing secrets
  on file descriptor 3. See `src/backend/DesktopBackendConfiguration.ts:400-405`
  and `src/backend/DesktopBackendManager.ts:438-498`.
- The auto-updater, safe storage, the native menu, the tray-less lifecycle.
- **Two Unix sockets for Symmetria Shell** (§6).
- The preview browser: `WebContentsView`/`<webview>` guests and a
  picture-in-picture window (`src/preview/Manager.ts`).

### 1.3 How `BrowserWindow`s are created

Every window is created through one service method,
`ElectronWindow.create(options)` (`src/electron/ElectronWindow.ts:169-197`), which
wraps `new Electron.BrowserWindow(options)` in `Effect.try` and, on failure,
produces a tagged `ElectronWindowCreateError` carrying a **schema-validated
diagnostic snapshot** of the options, `webPreferences` included
(`ElectronWindow.ts:13-33`, `:170-191`). Nothing else in the codebase calls
`new BrowserWindow` except the picture-in-picture path in `preview/Manager.ts`.

**The main window** (`src/window/DesktopWindow.ts:360-384`):

```ts
// apps/desktop/src/window/DesktopWindow.ts:371
webPreferences: {
  backgroundThrottling: false,   // boot unthrottled; re-enabled on first reveal
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: true,
},
preload: environment.preloadPath, // dist-electron/preload.cjs
```

Also set: `show: false` until `ready-to-show`, `minWidth: 840`, `minHeight: 620`,
`autoHideMenuBar: true`, a platform-specific title bar
(`DesktopWindow.ts:210-240`), and `backgroundColor` chosen from the current theme.

**The WSL "connecting" splash** (`DesktopWindow.ts:814-832`): frameless,
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, **no
preload**, and its content is an inline `data:text/html` URL with its own CSP
(`DesktopWindow.ts:174-181`).

**The picture-in-picture window** (`src/preview/Manager.ts:2804-2828`):
`alwaysOnTop`, `skipTaskbar`, preload `preview-pip-preload.cjs`,
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.

**Preview `<webview>` guests** are the one deliberate exception
(`src/preview/WebviewPreferences.ts:41`):

```ts
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";
```

`contextIsolation=false` is required so `react-grab`/`bippy` can read the page's
`__REACT_DEVTOOLS_GLOBAL_HOOK__`; `sandbox=true` is what keeps that safe, because
in sandboxed mode the preload gets a synthesized `electron` module and no Node
globals (`WebviewPreferences.ts:10-23`). Defence in depth: a
`will-attach-webview` handler re-asserts the security flags on the real options
object and rejects any partition that is not a preview partition
(`DesktopWindow.ts:477-489`).

### 1.4 Preload scripts

Four preload bundles are packed (`apps/desktop/vite.config.ts:38-92`), each its own
CJS entry in `dist-electron/`:

| Source | Artifact | Used by |
|---|---|---|
| `src/preload.ts` | `preload.cjs` | the main window |
| `src/preview-pick-preload.ts` | `preview-pick-preload.cjs` | preview `<webview>` guests |
| `src/preview-pip-preload.ts` | `preview-pip-preload.cjs` | the picture-in-picture window |
| (n/a) | — | the splash has no preload |

`src/preload.ts` exposes exactly one object:

```ts
// apps/desktop/src/preload.ts:30
contextBridge.exposeInMainWorld("desktopBridge", { ... } satisfies DesktopBridge);
```

It also calls `exposeClerkBridge({ passkeys: true })` (`preload.ts:12`), which is
why `@clerk/electron` is force-bundled into the preload artifact — a sandboxed
preload cannot resolve package imports from inside the ASAR
(`vite.config.ts:68-73`).

The preload is a thin, hand-written adapter. It does three things and nothing
more: it names the channel, it shapes the argument object, and — for every
main→renderer **push** channel — it hand-validates the payload before calling the
listener (for example `preload.ts:124-136`, `:174-184`, `:270-282`). Those pushes
do not go through the schema layer described in §2.

### 1.5 Can the renderer touch Node and `fs`?

**No.** The main window runs with `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`. The renderer has no `require`, no `process`, no `fs`, no
`child_process`. The only channel out of the renderer is `window.desktopBridge`,
whose surface is fixed at build time by `preload.ts`.

Two consequences for a file manager:

1. **Every filesystem call must live in the main process or in the backend
   server.** There is no third option that does not weaken the sandbox, and
   weakening it would contradict the posture the whole codebase maintains.
2. The renderer's path to the filesystem is already **two-lane**. Lane one is
   `desktopBridge` → `ipcMain` → main process. Lane two is the WebSocket RPC to
   the `t3` server, which already owns `apps/server/src/workspace/`
   (`WorkspaceEntries.ts`, `WorkspaceFileSystem.ts`, `WorkspacePaths.ts`,
   `WorkspaceSearchIndex.ts`) and already links the `fff` fuzzy finder. Lane two
   also works for remote and WSL environments, which lane one does not.

### 1.6 How many renderers exist

At most one main-window renderer at a time (§3), plus one renderer per open
preview `<webview>`, plus one picture-in-picture renderer while it is open, plus
the transient splash. There is **no multi-window renderer fan-out** today.

---

## 2. The IPC layer

### 2.1 Shape

`apps/desktop/src/ipc/` has four files:

- `channels.ts` — 95 lines, one exported string constant per channel.
- `DesktopIpc.ts` — the registry service and the two method constructors.
- `DesktopIpcHandlers.ts` — the registration list.
- `methods/` — `clientSettings.ts`, `connectionCatalog.ts`, `preview.ts`,
  `serverExposure.ts`, `sshEnvironment.ts`, `updates.ts`, `window.ts`, `wsl.ts`.

### 2.2 Channel naming

Every channel is the literal string `"desktop:<kebab-case-verb-noun>"`, declared as
a `SCREAMING_SNAKE_CASE` constant ending in `_CHANNEL`
(`src/ipc/channels.ts:1-95`). Example:

```ts
export const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
```

The constant is imported by both the preload and the method module, so a rename is
a single edit that the typechecker propagates.

### 2.3 The registry service

`DesktopIpc` is a `Context.Service` with exactly two members
(`src/ipc/DesktopIpc.ts:70-80`):

- `handle(method)` — registers an **asynchronous request/response** handler on
  `ipcMain.handle`.
- `handleSync(method)` — registers a **synchronous** handler on `ipcMain.on` that
  writes `event.returnValue`.

Both are `Effect.acquireRelease` pairs scoped to the caller's `Scope`, so a handler
is removed when its scope closes (`DesktopIpc.ts:92-114`, `:125-150`). Both call
`ipcMain.removeHandler` / `removeAllListeners` **before** registering, so a
re-registration cannot throw on a duplicate channel.

Both wrap the handler in an Effect span (`desktop.ipc.invoke` /
`desktop.ipc.invokeSync`) and annotate logs with the channel
(`DesktopIpc.ts:98-102`).

`DesktopIpcMain` is a **structural interface**, not `Electron.IpcMain`
(`DesktopIpc.ts:20-25`), which is what makes `DesktopIpc.test.ts` able to drive the
registry with a fake.

### 2.4 The type-safety mechanism

`makeIpcMethod` (`DesktopIpc.ts:188-228`) takes a channel, a **payload codec**, a
**result codec** and a handler, and returns a method whose `handler(raw: unknown)`
decodes, runs, and encodes:

```ts
// apps/desktop/src/ipc/DesktopIpc.ts:216-227
const decode = Schema.decodeUnknownEffect(method.payload);
const encode = Schema.encodeUnknownEffect(method.result);
return {
  channel: method.channel,
  handler: (raw) =>
    decode(raw).pipe(
      Effect.flatMap(method.handler),
      Effect.flatMap(encode),
      Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
    ),
};
```

`makeSyncIpcMethod` (`DesktopIpc.ts:248-277`) is the same without a payload.

So the guarantee is: **the main process validates every inbound payload with an
Effect Schema at the boundary.** The error channel widens to include
`Schema.SchemaError`, and the requirements channel widens to include the codec's
own decoding/encoding services — both are tracked in the type
(`DesktopIpc.ts:212-215`).

The **renderer** side gets its safety from a different mechanism: the
`DesktopBridge` TypeScript interface in `packages/contracts/src/ipc.ts:1064`. The
preload is checked against it by `satisfies DesktopBridge` (`preload.ts:293`), and
the renderer declares `Window.desktopBridge?: DesktopBridge`
(`apps/web/src/vite-env.d.ts:23-27`). The two halves are **not** derived from one
another — the schemas and the interface are written twice and kept in step by
hand.

### 2.5 Request/response or streaming

Three directions exist, and only two of them are typed by `DesktopIpc`.

| Direction | Mechanism | Schema-checked |
|---|---|---|
| renderer → main, async | `ipcRenderer.invoke` → `ipc.handle` | yes |
| renderer → main, sync | `ipcRenderer.sendSync` → `ipc.handleSync` | result only |
| main → renderer, push | `webContents.send` → `ipcRenderer.on` | **no** |

There is **no streaming primitive**. Continuous data is modelled as a push channel
plus a hand-written listener. `installPreviewEventForwarding`
(`src/ipc/methods/preview.ts:35-49`) is the canonical example: it subscribes to the
preview manager and forwards each event with `electronWindow.sendAll(channel, ...)`.
The preload validates the payload shape by hand before invoking the listener
(`preload.ts:270-291`), and the listener registration returns an unsubscribe
closure.

For high-rate data the codebase's own performance rule applies (`AGENTS.md:46`):
regressions come from sending too much over the wire. `useThreadFeed`
(`apps/web/src/symmetria/useThreadFeed.ts:44-51`) shows the accepted mitigation —
compare against the last sent payload and keep the message off the channel
entirely.

### 2.6 A concrete method, end to end

`pickFolder` is the cleanest full example. It already opens a native folder
dialog, which is the closest existing thing to a file-manager operation.

**1. The channel** — `apps/desktop/src/ipc/channels.ts:1`

```ts
export const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
```

**2. The method** — `apps/desktop/src/ipc/methods/window.ts:170-235`

```ts
export const pickFolder = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.pickFolder")(function* (options) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // ... routes to the WSL picker when options.targetEnvironmentId starts with "wsl:"
    const selectedPath = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath,
    });
    if (Option.isNone(selectedPath)) return null;
    return selectedPath.value;
  }),
});
```

**3. The registration** — `apps/desktop/src/ipc/DesktopIpcHandlers.ts:84`

```ts
yield* ipc.handle(pickFolder);
```

`installDesktopIpcHandlers` is one `Effect.fn` that resolves the registry once and
yields every method in sequence (`DesktopIpcHandlers.ts:49-98`). It is called once
from `bootstrap` (`src/app/DesktopApp.ts:200`).

**4. The bridge type** — `packages/contracts/src/ipc.ts` (inside
`interface DesktopBridge`)

```ts
pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
```

**5. The preload adapter** — `apps/desktop/src/preload.ts:103`

```ts
pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
```

**6. The renderer call**

```ts
const folder = await window.desktopBridge?.pickFolder({ initialPath: "~" });
```

### 2.7 Adding a new method — the recipe, and the fork-cheap variant

The **upstream recipe** is the six steps above. Its merge cost is four upstream
files: `channels.ts` (19), `DesktopIpcHandlers.ts` (14), `preload.ts` (22) and
`packages/contracts/src/ipc.ts` (39).

The **fork-cheap variant** is already in this repository and is worth copying.
`SttDelivery` and `ThreadPublisher` never appear in `DesktopIpcHandlers.ts`. They
register their own channels **inside their own layer's `make`**:

```ts
// apps/desktop/src/symmetria/ThreadPublisher.ts:124
yield* ipc.handle({
  channel: PUBLISH_THREADS_CHANNEL,
  handler: (raw: unknown) => Effect.sync(() => { /* ... */ }),
});
```

Note the shape: `ipc.handle` accepts a bare `{ channel, handler }`
(`DesktopIpc.ts:60-63`), so `makeIpcMethod` is a convenience, not a requirement.
The cost of that variant is **one line in `src/main.ts`** to merge the layer
(`main.ts:192-193`) and one line in `channels.ts`. `DesktopIpcHandlers.ts` and the
method directory are untouched.

The `DesktopBridge` cost was paid but flagged. Three Symmetria members were added
to that upstream interface, and the comment above them names the cheaper shape and
the tracking issue:

> ⚠ This member, and the two `stt*` ones above it, are FORK ADDITIONS to an
> upstream-owned interface, and each one is a merge conflict at every weekly
> upstream synchronization. … `DesktopBridge` is an `interface` and TypeScript
> declaration merging would let the fork add members without this file being
> touched at all. … tracked as issue #16. Do not add a fourth member here without
> reading it.
> — `packages/contracts/src/ipc.ts:1146-1157`

**A file manager must not be the fourth member.** Resolve issue #16 first, or use
a separate bridge object.

---

## 3. Window management

### 3.1 One window, and that is a decision

`docs/mesura/adr-002-one-window-many-projects.md` is *Accepted, 2026-08-21* and it
**supersedes ADR-001**. Its decision:

> **One instance, one window, every project inside it.** A project is a selection
> within that window, not a window and not a process.
> — `adr-002:11-12`

The ADR measured the three candidates on real data (`adr-002:37-53`):

| Projects | One window | One instance, N windows | N instances |
|---|---|---|---|
| 4 | **415 MB** | 989 MB | 1 662 MB |
| 7 | **415 MB** | 1 563 MB | 2 909 MB |
| 15 | **415 MB** | 3 094 MB | 6 233 MB |

The reason a window does not amortise is stated exactly: of the renderer's 233 MB
RSS, **196 MB are private pages** (`adr-002:60-64`). A second window pays that
again.

**The ADR names this transition.** Under *What this costs, accepted knowingly*:

> **Per-project cost is ~0 today and will not stay there.** The plan is to bring
> in the Symmetria File Manager and an editor. Both hold per-project state, so the
> flat line becomes a slope whose gradient is currently **unmeasured**.
> — `adr-002:117-120`

And: **eviction has to be built** (`adr-002:121-125`). One process means idle
projects must be written out and restored convincingly. That is the ADR's stated
price and it is unpaid.

### 3.2 The window lifecycle

`DesktopWindow` (`src/window/DesktopWindow.ts:77-111`) exposes:

- `createMain`, `ensureMain`, `revealOrCreateMain`, `activate`
- `createMainIfBackendReady` — gated on a `backendReadyRef` latch set by the
  backend pool's `onReady` callback (`DesktopWindow.ts:879-886`)
- `showConnectingSplash` — WSL-only, best-effort, never fails startup
- `flushMainWindowBounds`, `dispatchMenuAction`, `zoomMain`, `syncAppearance`

`ElectronWindow` (`src/electron/ElectronWindow.ts:80-98`) holds a single
`mainWindowRef: Ref<Option<BrowserWindow>>` and offers `currentMainOrFirst`,
`focusedMainOrFirst`, `setMain`, `clearMain`, `reveal`, `sendAll`, `destroyAll`,
`syncAllAppearance`. **There is no window collection and no window id map.** The
model is "the main window, or the first one, or none".

`reveal` is the standard restore sequence (`ElectronWindow.ts:212-241`): restore if
minimised, show if hidden, `app.focus({ steal: true })` on macOS, then `focus()`.

### 3.3 Fast first paint

Three deliberate tricks, all in `createWindow`:

1. `show: false` at construction, revealed on the first of `ready-to-show` or —
   on Linux only — `webContents did-finish-load`
   (`DesktopWindow.ts:740-756`). Linux gets the extra trigger because
   `ready-to-show` is unreliable there.
2. `backgroundThrottling: false` at boot, re-enabled on that first reveal
   (`DesktopWindow.ts:371-378`, `:745-749`). Chromium throttles hidden renderers,
   which stalls first paint on a window that boots hidden.
3. `backgroundColor` set from the theme before load, so the reveal is not a white
   flash (`DesktopWindow.ts:128-130`, `:367`).

### 3.4 Window state persistence

Bounds and the maximised flag live in `desktop-settings.json` under the state
directory (`src/app/DesktopEnvironment.ts:216`,
`src/settings/DesktopAppSettings.ts:29-30`, `:96-99`).

The write path is debounced at **500 ms** (`DesktopWindow.ts:36`,
`:429-457`) on `resize`, `move`, `maximize`, `unmaximize`, and flushed
synchronously on `close` and on quit (`DesktopWindow.ts:602-608`,
`src/app/DesktopLifecycle.ts:90`).

The read path validates against the connected displays before trusting the saved
bounds:

```ts
// apps/desktop/src/window/DesktopWindow.ts:158-169
export function resolveInitialMainWindowBounds(persistedBounds, displays) {
  if (persistedBounds !== null && displays.some((d) => windowFitsWithinDisplay(persistedBounds, d)))
    return persistedBounds;
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}
```

A window that would land off-screen falls back to the default size, and persistence
is disabled until the user moves it (`DesktopWindow.ts:391`, `:429-441`).

### 3.5 Single-instance lock and second instance

**The lock is not taken by this repository's own code.** It is taken by the Clerk
SDK bridge at creation, and `DesktopClerk` documents why the ordering matters:

> Electron scopes the single-instance lock to the userData directory and creates
> that directory when the lock is acquired. The SDK bridge takes the lock at
> creation, so userData must already point at the real directory here.
> — `apps/desktop/src/app/DesktopClerk.ts:88-93`

`resolveUserDataPath` therefore runs and `app.setPath("userData", …)` is called
*before* `createClerkBridge` (`DesktopClerk.ts:94-99`).

The secondary-instance path (`DesktopClerk.ts:127-147`):

```ts
if (!bridge.isPrimaryInstance) {
  yield* electronApp.quit;
  return yield* Effect.interrupt;   // stop bootstrap before whenReady can fire
}
yield* electronApp.on("second-instance", () => {
  // reveal the existing main window
});
```

So: a second launch quits itself and reveals the running window. There is **no
argument forwarding** on that path today — the handler ignores `argv` entirely.
A file manager that wants `mesura open ~/Downloads` from a second process would
have to add it, or use a socket (§6), which is the pattern the fork already chose
twice.

### 3.6 Quit, tray, background

- `window-all-closed` quits the app on every platform except macOS
  (`DesktopLifecycle.ts:234-244`). **The process does not stay resident after the
  last window closes on Linux.**
- `before-quit` is intercepted, the shutdown is awaited, then quit is re-issued
  (`DesktopLifecycle.ts:97-140`). `SIGINT`/`SIGTERM` route into the same sequence
  on non-Windows (`DesktopLifecycle.ts:246-253`).
- **There is no `Tray`, no `setLoginItemSettings`, no `openAtLogin`.** A grep over
  `apps/desktop/src` returns nothing for any of them.
- There *is* a hold-to-quit gate on the quit accelerator
  (`src/window/QuitHold.ts`, wired at `DesktopWindow.ts:568-596`), and a bounded
  renderer-crash recovery: reload after 500 ms, at most 3 times per rolling
  60 s window (`DesktopWindow.ts:41-43`, `:702-738`).

### 3.7 What this means for a resident file-manager daemon

The Qt file manager's model — a headless systemd service that spawns short-lived
windows on demand — has **no equivalent in Mesura today**. Three facts decide the
port:

1. A new Electron window costs ~196 MB of private renderer memory, measured
   (`adr-002:60-64`). "Spawn a window fast" cannot mean "spawn a renderer fast".
   The Electron equivalent of the Qt daemon is a **pre-warmed hidden
   `BrowserWindow`** revealed on demand, or a single window whose content
   switches.
2. The main process already knows how to listen on a Unix socket and act on a
   line of JSON (§6). That is the daemon's front door, already proven.
3. `window-all-closed → quit` would have to be disabled for a resident build. Per
   `AGENTS.md:26`, disable it through a setting or a platform branch rather than
   deleting the handler.

---

## 4. The renderer stack

`apps/desktop` ships no UI of its own. It loads `apps/web` through the custom
`t3code://app` protocol (`src/electron/ElectronProtocol.ts:11-25`,
`DesktopWindow.ts:333`). Development uses the `t3code-dev` scheme pointed at the
Vite dev server. Versions below are from `apps/web/package.json` and
`pnpm-workspace.yaml`'s catalog.

| Concern | Package | Version |
|---|---|---|
| UI framework | `react` / `react-dom` | `19.2.6` |
| Compiler | `babel-plugin-react-compiler` | `1.0.0` |
| Router | `@tanstack/react-router` (+ `@tanstack/router-plugin`) | `^1.160.2` / `^1.161.0` |
| Reactive state (Effect) | `@effect/atom-react` | `4.0.0-beta.103` (catalog) |
| Local stores | `zustand` | `^5.0.11` |
| Styling | `tailwindcss` + `@tailwindcss/vite` | `^4.0.0` |
| Variant helpers | `class-variance-authority`, `tailwind-merge` | `^0.7.1`, `^3.4.0` |
| Headless components | `@base-ui/react` | `^1.4.1` |
| Icons | `lucide-react` (+ Pierre icons via `@pierre/diffs`) | `^0.564.0` |
| List virtualisation | `@legendapp/list` (patched) | `3.3.5` (catalog) |
| Tree rendering | `@pierre/trees` | `1.0.0-beta.4` |
| Diff rendering | `@pierre/diffs` (patched) | `1.3.0-beta.10` |
| Drag and drop | `@dnd-kit/core` / `modifiers` / `sortable` / `utilities` | `^6.3.1` / `^9.0.0` / `^10.0.0` / `^3.2.2` |
| Rich text | `lexical`, `@lexical/react` | `^0.41.0` |
| Markdown | `react-markdown`, `remark-gfm`, `remark-breaks`, `rehype-raw`, `rehype-sanitize` | `^10.1.0`, `^4.0.1`, `^4.0.0`, `^7.0.0`, `^6.0.0` |
| Debounce / throttle | `@tanstack/react-pacer` | `^0.19.4` |
| Colour maths | `culori` | `^4.0.2` |
| Effect core | `effect` | `4.0.0-beta.103` (catalog) |
| Electron | `electron` | `41.5.0` |
| TypeScript | `typescript` | `~6.0.3` (catalog) |
| Node engine | — | `^24.13.1` (`package.json:71`) |
| Package manager | `pnpm` | `11.10.0` |

Notes that matter for a port:

- **There is no CSS-module or token file.** Styling is Tailwind v4 utilities plus
  one very large stylesheet, `apps/web/src/index.css` (80 KB), and the theme is
  computed in TypeScript: `apps/web/src/themePalette.ts` (75 KB),
  `themeBoot.ts`, `openVsxThemes.ts`, `vscodeThemeImport.ts`. VS Code themes can
  be imported at runtime. A file manager's colour tokens would have to route
  through `themePalette.ts`, not through a new token file.
- **The router uses hash history under Electron** and browser history on the web
  (`apps/web/src/main.tsx:22`). A file-manager route must work under both.
- **Virtualisation already exists** (`@legendapp/list`, patched) and is what a
  Miller-column list should reuse rather than re-implement.
- **State is split three ways**: `@effect/atom-react` atoms for server-derived
  read models (`packages/client-runtime/src/state/*`), `zustand` for large local
  UI stores (`rightPanelStore.ts` at 29 KB, `previewStateStore.ts` at 17 KB), and
  plain React state for the rest. `packages/client-runtime` is the code shared
  with mobile.

---

## 5. Effect-TS usage

### 5.1 How deep

Total, not partial. Effect is the runtime of the main process, the server and the
shared packages. It is `effect@4.0.0-beta.103` — the **v4 beta**, whose API differs
materially from v3.

`AGENTS.md:199` mandates: *"`apps/server` … Effect-heavy: read
`.repos/effect-smol/LLMS.md` before writing Effect code."* `.repos/` is vendored
read-only reference (`AGENTS.md:206`); never edit or import from it.

The v4 rules that most often catch out v3 habits, from that file:

- **Services are `Context.Service`, not `Effect.Service`.** Counted over
  `apps/server/src/**` non-test files: `extends Context.Service` 115 times,
  `Layer.effect(` 124 times, `Effect.Service` **once**.
- **Errors are `Schema.TaggedErrorClass`**, not `Data.TaggedError`.
- **`Effect.catch` replaces `Effect.catchAll`**; `Effect.catchTag` takes an array.
- **Never write a function that returns an `Effect.gen`** — use `Effect.fn(name)`,
  which also opens a tracing span. **Do not `.pipe` an `Effect.fn`**; pass
  combinators as extra arguments.
- **Always `return yield*` when raising an error**, so TypeScript narrows.
- **Namespace imports from deep paths only**: `import * as Effect from
  "effect/Effect"`, never `from "effect"`. This is enforced (§9.5).
- Use `Schema` for all validation; use the `Predicate` module instead of
  hand-rolled type guards; use `DateTime`, never `Date`.

### 5.2 The service and layer pattern, verbatim

Every service in this repository follows one shape. `DesktopWindow` is
representative.

```ts
// apps/desktop/src/window/DesktopWindow.ts:77-111
export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly dispatchMenuAction: (action: string) => Effect.Effect<void, DesktopWindowError>;
    // ...
  }
>()("@t3tools/desktop/window/DesktopWindow") {}

// :277
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  // ... resolve every dependency, build local state with Ref
  return DesktopWindow.of({ createMain, ensureMain, activate, /* ... */ });
});

// :936
export const layer = Layer.effect(DesktopWindow, make);
```

Four conventions are load-bearing:

1. **The tag string is `packageName/subdirectory/ServiceName`** — for example
   `"@t3tools/desktop/ipc/DesktopIpc"` (`DesktopIpc.ts:80`),
   `"t3/config/ServerConfig"` (`apps/server/src/config.ts:55`).
2. **The module exports `make` and `layer` separately.** `make` is testable
   without the layer; `layer` is what `main.ts` composes.
3. **`Service.of({...})` builds the instance**, never a bare object literal.
4. **Errors are declared beside the service** as `Schema.TaggedErrorClass` with an
   overridden `get message()`. See `DesktopIpc.ts:27-51`,
   `ElectronWindow.ts:44-78`.

Two more idioms appear constantly:

- **`Layer.unwrap(Effect.gen(...))`** when a layer must read a value out of the
  context before it can be built (`src/main.ts:69-84`, `:107-117`).
- **`Effect.runPromiseWith(context)` / `runSyncWith` / `runForkWith`** to escape
  into a callback the platform owns — an Electron event handler, a `net.Server`
  connection callback. The pattern is always: capture
  `const context = yield* Effect.context<Services>()` inside `make`, then run
  against it from the callback (`DesktopWindow.ts:297-299`,
  `symmetria/SttDelivery.ts:56-58`).

### 5.3 Is new code expected to be in Effect style

Yes, and it is enforced at typecheck rather than by review. `tsconfig.base.json:19-51`
loads `@effect/language-service` with these severities set to `error`:

`importFromBarrel`, `anyUnknownInErrorContext`, `unsafeEffectTypeAssertion`,
`instanceOfSchema`, `deterministicKeys`, `missingEffectServiceDependency`,
`leakingRequirements`, `globalErrorInEffectCatch`, `globalErrorInEffectFailure`,
`unknownInEffectCatch`, `preferSchemaOverJson`, `schemaSyncInEffect`,
`cryptoRandomUUID`, `cryptoRandomUUIDInEffect`, **`nodeBuiltinImport`**,
`globalDate`, `globalDateInEffect`, `globalConsole`, `globalConsoleInEffect`,
`globalRandom`, `globalRandomInEffect`, `globalTimers`, `globalTimersInEffect`,
`globalFetch`, `globalFetchInEffect`.

`nodeBuiltinImport: error` is the one a file manager hits first: **importing
`node:fs` is a typecheck failure** wherever an Effect service exists for the job
(`FileSystem.FileSystem`, `Path.Path`). An exemption is possible but must be
written down with its reason:

```ts
// apps/desktop/src/symmetria/socketFiles.ts:12-15
// @effect-diagnostics nodeBuiltinImport:off - `os.tmpdir()` has no Effect
// service, and the fallback below is precisely about which directory the
// operating system offers when the session manager gave us none.
import * as NodeOS from "node:os";
```

A `@effect/tsgo` patch is applied on `prepare` (`package.json:6`) so the
diagnostics also run in the CLI typechecker, not only in the editor.

---

## 6. `apps/desktop/src/symmetria/` — the existing bridge

This is the fork's own directory inside the upstream Electron app. It contains **26
files** and has never conflicted with upstream. It is the single best template for
adding a fork-owned feature to this app.

### 6.1 What it does

Two independent features, sharing a filesystem layer and a socket-binding layer.

**Feature one — dictation in.** Symmetria Shell's `stt-inject.sh` writes one JSON
line to a Unix socket and blocks on one line back. The main process forwards the
text to the renderer, waits for the renderer to confirm it landed in the composer,
and only then writes the receipt.

**Feature two — the thread list out.** The renderer pushes its projected thread and
project list to the main process; the main process republishes it on a second Unix
socket as a newline-delimited JSON stream that Symmetria Shell's bar reads.

### 6.2 The files

| File | Role |
|---|---|
| `socketFiles.ts` | The filesystem side of a socket this process owns: create the directory `0700`, clear a stale node, `chmod 0600` after bind, resolve `$XDG_RUNTIME_DIR` with a per-uid tmpdir fallback. Uses Effect `FileSystem`/`Path`, not `node:fs`. |
| `unixSocket.ts` | `listenOnPath(server, path)` and `closeServer(server)` as promises. Only `node:net`. |
| `sttSocketFiles.ts` | The dictation socket's **name**: `symmetria-mesura-<pid>.sock`. |
| `threadSocketFiles.ts` | The publisher socket's name: `symmetria-mesura-threads-<pid>.sock`. Deliberately not a parameterisation of the above. |
| `sttProtocol.ts` | Pure parse/format for the dictation wire shape and its receipt. No Electron, no Node. |
| `SttSocket.ts` | `createSttServer` — one line in, one line out, on the same connection. |
| `sttBridge.ts` | Correlates one dictation with the renderer's answer, by request id, in plain TypeScript. |
| `SttDelivery.ts` | The Effect layer: binds the socket, registers `RESOLVE_STT_DELIVER_CHANNEL`, applies a 5 s window deadline. |
| `threadProjection.ts` | Turns the fork's read model into the contract's snapshot, **field by field, by name**. |
| `threadFeed.ts` | Turns a series of read models into an ordered snapshot/delta stream. Pure and synchronous. |
| `threadStream.ts` | The push socket: opens with a snapshot, then broadcasts deltas, dropping a peer past a 1 MB backlog. |
| `ThreadPublisher.ts` | The Effect layer: binds the socket, registers `PUBLISH_THREADS_CHANNEL`. |

Renderer half: `apps/web/src/symmetria/` — `sttDelivery.ts`, `useSttDelivery.ts`,
`threadFeed.ts`, `useThreadFeed.ts`.

### 6.3 The protocol

**Transport:** Unix domain sockets under `$XDG_RUNTIME_DIR`, mode `0600`, named by
the main process's PID. `defaultRuntimeDir` falls back to
`${os.tmpdir()}/symmetria-mesura-${uid}` with a `0700` parent, and the comment
explains that the fallback is where a symlink race would otherwise live
(`socketFiles.ts:65-79`).

**Dictation wire format** (`sttProtocol.ts`): one JSON line in,
`{ type: "stt_inject", text: string, submit?: boolean }`; one JSON line out,
`{ ok, outcome, detail? }` where outcome is one of `placed`,
`placed-and-submitted`, `placed-not-submitted`, `no-conversation`, or an error
code. The ordering is the contract: the receipt is written only after the
delivery attempt resolves, because the shell keeps no clipboard copy in socket
mode (`SttSocket.ts:1-14`).

**Thread stream wire format** (`threadStream.ts:1-20`): newline-delimited JSON,
one item per line, **opening with a full snapshot** on every connection. NDJSON was
chosen because the consumer is QuickShell, whose `Socket` carries a `SplitParser`
and nothing else.

**Direction discipline** is documented in `channels.ts:8-17`. Dictation is
main→renderer with a round trip, because only the window can place the text.
Thread publishing is renderer→main, because the renderer already holds the read
model and a second subscription in the main process would be a duplicate with its
own auth.

### 6.4 What it already proves

1. **A Unix socket in the Electron main process works**, survives the process
   lifetime, and can be made owner-only. Two of them coexist.
2. **A synchronous external caller can block on a round trip through the
   renderer** and get a truthful receipt, with a 5 s deadline that abandons *one*
   request rather than all of them (`SttDelivery.ts:99-107`).
3. **A push stream out of the app to a non-TypeScript consumer works**, with
   snapshot-on-connect framing and a bounded per-peer backlog.
4. **Startup is never blocked by any of it.** Both layers catch a bind failure and
   log a warning, returning `Option.none()` for the socket path
   (`SttDelivery.ts:139-150`, `ThreadPublisher.ts:99-110`). Both install an
   `error` listener on the `net.Server` itself, because a `net.Server` emitting
   `error` with no listener **throws** and would take the whole main process down
   (`SttDelivery.ts:116-123`, `ThreadPublisher.ts:75-83`).
5. **A whole feature can be added with zero edits to upstream logic** — one line
   in `main.ts` to merge the layer, two lines in `channels.ts`, three members on
   `DesktopBridge` (the one cost, flagged as issue #16).

---

## 7. `packages/symmetria-broker-contract`

### 7.1 What it is

The wire contract between this fork and Symmetria Shell. **A description, not a
running thing** — no broker, no publisher, no consumer, no storage
(`README.md:3-6`). Contract version `1.1.0`, protocol major `1`, minor `1`
(`src/version.ts:34-40`).

It is fork-owned and it stays that way:

> Nothing under `packages/contracts` or anywhere else upstream may be edited to
> serve it, because a change inside an upstream file is a merge conflict at every
> weekly upstream synchronization.
> — `README.md:8-16`

Where upstream exports a schema *value*, this package composes it directly. Where
upstream exports only a *type*, `src/upstreamLock.ts` binds a local copy to that
type so the typecheck fails the moment the two diverge.

### 7.2 The surface

Nine documents, listed in `schema/index.json`:

| Root | Meaning |
|---|---|
| `SymmetriaThreadSummary` | The narrow read projection of one agent thread |
| `SymmetriaProjectSummary` | One project's identity |
| `SymmetriaSurfacePresence` | Which surfaces attend one thread, and how attentive |
| `SymmetriaCommandEnvelope` | Any of the four commands a consumer sends |
| `SymmetriaCommandReceipt` | The answer: applied, replayed, or refused |
| `SymmetriaDraft` | The versioned composer draft of one thread |
| `SymmetriaDraftUpdate` | A compare-and-set write, stating the version it expects |
| `SymmetriaDraftUpdateResult` | Applied, or refused as a conflict |
| `SymmetriaStreamItem` | One stream item: a full snapshot or a delta |

Package exports (`package.json:5-45`): a curated root barrel plus eleven subpaths
plus `"./schema/*"` for the raw JSON Schema files. The barrel deliberately omits
`checksum.ts` and `jsonSchema.ts` because they import `node:crypto` and the barrel
is what a web or mobile client imports (`src/index.ts:1-5`).

### 7.3 The three rules of the stream framing

From `src/stream.ts:19-33`:

- **A stream opens with a snapshot.** `openSymmetriaStream` is the only way to get
  a state and it refuses a delta.
- **A gap is reported, never repaired.** A sequence that skips ahead yields a
  `gap` that requires a resnapshot. No buffering, no reordering, no clock.
- **A duplicate is normal traffic.** A delta replayed after a reconnect is
  reported as `duplicate` and applied once.

There is **no removal member** in the delta union, deliberately: a thread that goes
away says so in its own summary through `archivedAt` and `deletedAt`, and a
presence row is valid only until its `expiresAt` (`stream.ts:60-67`).

### 7.4 Addressing

The single most transferable rule in the package:

> `threadId` is the whole of a command's target. No process id, no window handle,
> no pane slot and no route string: a slot number is reused as panes come and go,
> and a reused address is what delivers a dictation to the wrong thread.
> — `src/command.ts:41-48`

The idempotency key is `CommandId`, borrowed from upstream rather than invented,
because upstream already settled that the correlation key and the command key are
one thing (`command.ts:10-17`).

### 7.5 Version gating

`SymmetriaProtocolVersion` pins the major to a literal, so **decoding is itself the
gate** — an unsupported major never produces a value (`version.ts:41-63`). Any
minor is accepted, because a minor bump is additive by definition.

The minor promise runs in **one direction only**, and the file says so out loud: a
newer producer talking to an older consumer is handled; the reverse is not
promised, because `SymmetriaStreamSnapshot` gained a required `projects` array in
1.1 (`version.ts:10-27`). That was accepted because there is exactly one producer,
shipping in the same repository as its schema. *"If a second producer ever appears
… this is the decision to revisit FIRST."*

### 7.6 Generation and drift detection

`schema/` is emitted from the Effect schemas by `scripts/emit-json-schema.ts`; run
`vp run generate`. The suite rebuilds each document in memory and compares byte for
byte, so a hand edit fails `src/jsonSchema.test.ts` (`README.md:18-33`).

`schema/index.json` carries two hashes:

- **`checksum`** — SHA-256 over every emitted document, in ascending path order,
  each as `path` + NUL + bytes + NUL. A second repository pins this value; it is
  reproducible from the published bytes alone.
- **`sourceChecksum`** — hashes the Effect schemas instead. It exists because
  `checksum` cannot see a change JSON Schema cannot express: a check applied after
  a transformation is dropped on emission, so swapping a `TrimmedNonEmptyString`
  for a bare string emits identical documents (`README.md:35-50`).

Current values: `checksum 528b440a…`, `sourceChecksum 82ad0e34…`.

One rule that must not be tightened: **emitted object schemas set
`additionalProperties: true` at every depth**, deliberately, so a non-TypeScript
consumer does not reject a payload TypeScript accepts (`README.md:52-55`).

The formatter is configured to skip `packages/symmetria-broker-contract/schema/**`
and `test/fixtures/**` for exactly this reason (`vite.config.ts:66-78`).

Acceptance tests live outside the package, in the top-level `tests/` workspace
entry (`tests/unit/symmetria-phase-one.test.ts` … `-phase-six.test.ts`) — added to
`pnpm-workspace.yaml` with a comment explaining that a package's own test command
cannot collect tests that relaunch it (`pnpm-workspace.yaml:6-14`).

---

## 8. Native code

**There is no Node native addon (`.node`) written in this repository.** Three
distinct mechanisms ship native code, and each is a different template.

| | `resource-monitor` | `libghostty-vt` | `@ff-labs/fff-node` |
|---|---|---|---|
| Kind | Rust **bin**, sidecar process | Zig → WASM / `.so` / `.a` | Rust **cdylib**, C ABI, via FFI |
| In this repo | `Cargo.toml` + `src/main.rs` | headers + a `VERSION` pin only | nothing — an npm dependency |
| crate-type | default `bin` (no `[lib]`) | `wasm32-freestanding` lib | `cdylib`, **not** napi |
| Built by | `cargo build --locked --release --target …` | a manual shell script | not built — npm prebuilts |
| Node binding | **none** — child process, NDJSON on stdio | **none** — `WebAssembly.instantiate` in the renderer | `ffi-rs` → `dlopen` |
| electron-builder | `extraResources`, outside the ASAR | implicit, packed inside the ASAR | staged dependency, ASAR-**unpacked** |
| Checked-in binary | no | **yes** (wasm, jniLibs, xcframework) | no |

### 8.1 `native/resource-monitor` — a Rust **executable**, spawned as a subprocess

**What it is.** A Cargo binary crate, `t3-resource-monitor` v0.1.0, edition 2024,
MIT, `publish = false` (`native/resource-monitor/Cargo.toml:1-6`). Dependencies:
`sysinfo 0.39.3`, `serde`, `serde_json`. Release profile is tuned for size and
start-up: `codegen-units = 1`, `lto = "thin"`, `panic = "abort"`, `strip = true`
(`Cargo.toml:13-17`). The whole crate is one file, `src/main.rs` (1160 lines,
`fn main()` at `:665`). There is **no `[lib]` section, no `crate-type`, no
`build.rs`, no `package.json`** and no napi/neon dependency. `Cargo.lock` is
committed, and every invocation uses `--locked`.

The protocol is **newline-delimited JSON over stdin/stdout**, `PROTOCOL_VERSION = 2`
(`src/main.rs:11`). On the desktop it uses inherited file descriptors 4 and 5 for
the telemetry and demand-control channels
(`docs/internals/resource-telemetry.md:38-50`).

The choice was deliberate and is written down:

> The monitor is intentionally not a Node native addon… No N-API, `ffi-rs`, or
> dynamic-library ABI is loaded into the server process.
> — `docs/internals/resource-telemetry.md:20-33`

**Build command.** Root script (`package.json:36`):

```bash
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
```

The packaging build does the same per target triple and then stages the result
(`scripts/build-desktop-artifact.ts:1660-1719`). On macOS it builds both arches
and merges them with `lipo -create` into a universal binary (`:1707-1714`), then
`chmod 0755` on non-Windows (`:1717-1718`). A missing output is a hard,
tagged failure: `ResourceMonitorBuildOutputMissingError` (`:1688-1694`) and the
release preflight reason `"resource-monitor-missing"`
(`build-desktop-artifact.ts:563`, `:2587-2594`).

**Artifact location**, in the order the file travels:

| Stage | Path |
|---|---|
| Cargo output | `native/resource-monitor/target/<triple>/release/t3-resource-monitor[.exe]` |
| Desktop stage | `<stage>/apps/desktop/resources/resource-monitor/` (`:1700-1701`), `chmod 0755` on non-Windows (`:1721-1723`) |
| Second hop | `<stage>/apps/desktop/prod-resources/` (`:2846-2847`) — **required**, because electron-builder filters `resources/` out of the AppImage |
| Packaged app | `<app>/resources/resource-monitor/t3-resource-monitor[.exe]` via `extraResources` (`:836-841`, `:2053-2056`) |
| Published npm CLI | `apps/server/dist/resource-monitor/<platform>-<arch>/` (`release.yml:733-738`) |

`native/**/target/` is gitignored; no binary is checked in and nothing is
downloaded.

**How Node finds it.** It does not `require` it — it **spawns** it. There are two
independent resolvers.

*Server side* — `apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts` is a
`Context.Service` whose only member is
`resolve: Effect<string, ResourceMonitorBinaryError>` (`:58-63`). Resolution is an
ordered candidate list (`:149-184`):

1. `T3CODE_RESOURCE_MONITOR_PATH` env var, then `ServerConfig.resourceMonitorPath`.
2. `<dirname>/resource-monitor/<platform>-<arch>/<exe>` — the packaged layout.
3. `<dirname>/resource-monitor/<exe>` and `<dirname>/../resource-monitor/<exe>`.
4. `…/native/resource-monitor/target/<triple>/release/<exe>` — the **dev**
   layout, tried at two different relative depths.
5. `…/target/release/<exe>` then `…/target/debug/<exe>`.

The platform key is `${platform}-${arch}` restricted to darwin/linux/win32 ×
arm64/x64 (`:93-104`); the Rust triple is derived separately, and **Linux musl is
explicitly unsupported** (`:118-127`). libc is detected from
`process.report.getReport().header.glibcVersionRuntime` (`:71-84`). Existence and
the executable bit are both checked (`:198-214`).

*Electron side* — `apps/desktop/src/backend/DesktopBackendConfiguration.ts:149-180`
resolves the path itself and **hands the server an absolute path** in the backend
start config (`:391-394`, resolved as an `Option<string>` at `:679`), rather than
letting the server guess:

- development → `<rootDir>/native/resource-monitor/target/release/<exe>`, then
  `…/target/debug/<exe>` (`:155-166`)
- packaged → `path.join(environment.resourcesPath, "resource-monitor", <exe>)`,
  a single candidate (`:169`)

The actual spawn is `apps/server/src/resourceTelemetry/NativeTelemetryClient.ts:362-363`
(`ResourceMonitorBinary` + `ChildProcessSpawner`), spawning at `:549-550`.

**Dev versus packaged.** **Nothing in `pnpm dev` builds this crate** — there is no
`cargo` call in `scripts/dev-runner.ts` or any dev task. A developer runs
`pnpm build:resource-monitor` by hand, or does without: failure is a tagged error
(`ResourceMonitorBinaryUnsupported` / `NotFound` / `NotExecutable`), not a crash,
and resource telemetry degrades to `unavailable`. In the packaging build the crate
is compiled unconditionally, and a missing Windows binary is a hard release
failure.

**CI** builds and tests it in a job of its own (`.github/workflows/ci.yml:154-176`,
runner `blacksmith-4vcpu`, toolchain via `dtolnay/rust-toolchain@stable`):
`cargo fmt --manifest-path … -- --check` then `cargo test --locked --manifest-path …`.
It is split out because installing Rust cost 7–9 s on the critical path of every
pull request (`ci.yml:152-153`).

### 8.2 `native/libghostty-vt` — Zig compiled to **WASM**, artifact committed

`native/libghostty-vt/` contains only three things: a `LICENSE`, a `VERSION` file
holding the upstream Ghostty commit `9f62873bf195e4d8a762d768a1405a5f2f7b1697`,
and 34 upstream C headers under `include/ghostty/`. **No source, no build system,
no `Cargo.toml`, no `package.json`.** It is a version pin plus a header set. The
toolchain is **Zig**, not Rust and not node-gyp.

The build is `apps/web/scripts/build-libghostty-wasm.sh`, run via
`pnpm --dir apps/web build:ghostty-wasm` (`apps/web/package.json:7`). It reads the
pinned SHA from `VERSION` (`:11`), ensures **Zig 0.15.2** — using the host's `zig`
only if the version matches exactly, otherwise downloading into
`~/.cache/t3code/zig-0.15.2` (`:29-66`) — clones Ghostty at the pinned SHA into
`~/.cache/t3code/ghostty-<sha8>` (`:68-90`), and runs (`:104-110`):

```bash
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall \
          -Dstrip=true -Dlib-version-string="0.1.0-dev+<SHA>" -p <tmp>
```

The **outputs are committed to git**:

```
apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm         (631 KB, tracked)
apps/web/src/terminal/ghostty/vendor/ghostty-write-pty.wasm  (112 B, tracked)
```

So are the mobile artifacts:
`apps/mobile/modules/t3-terminal/android/src/main/jniLibs/<abi>/libghostty-vt.so`
and `.../Vendor/libghostty/GhosttyKit.xcframework/…/libghostty-fat.a`, each with
its own build script.

The build script is a *regeneration* tool, not part of any normal build. Nothing in
`pnpm build`, `pnpm build:desktop` or CI runs it.

**Runtime.** `apps/web/src/terminal/ghostty/runtime.ts:1-2` imports the `.wasm` with
Vite's `?url`, then `GhosttyRuntime.load()` (`:43-65`) does
`fetch(url)` → `WebAssembly.instantiate(buffer, { env: { log } })`. It runs **in the
renderer**, which is why the desktop CSP carries `'wasm-unsafe-eval'`
(`src/electron/ElectronProtocol.ts:73`). Dev and packaged differ only in how Vite
serves the asset. electron-builder needs no rule for it: it rides inside the ASAR
because it is fetched over HTTP, not `dlopen`ed.

**The drift guard is a test, not a build step** —
`apps/web/src/terminal/ghostty/runtimeAbi.test.ts:17-39` asserts a size budget
(`byteLength < 750_000`) and reads `ghostty_build_info` out of the binary to compare
its embedded SHA against `native/libghostty-vt/VERSION`. That is a pattern worth
copying for any committed binary artifact.

### 8.3 `@ff-labs/fff-node` — the Rust fuzzy finder, **already in this repo**

This is the most directly relevant precedent, because it is **the same `fff`
engine the Qt file manager already links** (`dmtrKovalenko/fff`), reached from
Node instead of from C++.

**Where it is used, and how much of it is already built.**
`apps/server/package.json:30` declares `"@ff-labs/fff-node": "0.9.4"`, adopted in
commit `d12da198a` *"Use fff for workspace search queries (#3099)"*. The consumer is
`apps/server/src/workspace/WorkspaceSearchIndex.ts`, and it is not a thin wrapper:

- `createFinder` (`:300-328`) builds a `FileFinder` with `basePath: cwd`,
  `disableMmapCache: true`, `enableFsRootScanning: true`,
  `enableHomeDirScanning: true`, and `disableContentIndexing` toggled per variant.
- **Two index variants per working directory** —
  `WORKSPACE_SEARCH_INDEX_VARIANTS = ["paths", "content"]` (`:527`) — keyed through
  an Effect `LayerMap.Service` (`WorkspaceSearchIndexMap`, `:560`) with a 15-minute
  idle TTL (`:32`), a 15 s scan timeout (`:30-31`), a 25 000-entry cap (`:28`) and a
  250 ms content-search time budget (`:33`). `waitForIndexReady(15_000)` at
  `:335-344`.
- It imports `FileFinder`, `DirItem`, `FileItem`, `MixedItem`, `GrepCursor`,
  `SearchResult`, `DirSearchResult`, `MixedSearchResult` (`:1-11`) — so **directory,
  file and mixed search all already exist**, which is exactly what the Qt finder
  needs (`fff_search_mixed`, not `fff_search`).
- Consumed by `apps/server/src/workspace/WorkspaceEntries.ts:144,157-184,247-269`,
  surfaced over the wire at `apps/server/src/ws.ts:186-198`, and already driving the
  file tree, the composer path search, the ⌘P file picker and the ⇧⌘F project
  content search (`WorkspaceSearchIndex.ts:308-311`).

**The load chain.**

```
@ff-labs/fff-node  (pure JS/TS, ESM)
        │ depends on
        ▼
ffi-rs  (a real N-API .node addon; platform bindings under @yuuang/ffi-rs-*)
        │ dlopens
        ▼
@ff-labs/fff-bin-<platform>-<arch>[-<libc>]   ← an npm package whose ENTIRE payload
        └── libfff_c.so   (5.6 MB Rust cdylib, C ABI)     is one shared library
```

`@ff-labs/fff-node` declares eight `optionalDependencies`, one per platform
(`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`,
`linux-x64-musl`, `linux-arm64-musl`, `win32-x64`, `win32-arm64`). npm/pnpm
installs only the matching one. On this machine that is
`node_modules/.pnpm/@ff-labs+fff-bin-linux-x64-gnu@0.9.4/…/libfff_c.so`, and the
binary package's `package.json` is just `{ "main": "libfff_c.so", "os": ["linux"],
"cpu": ["x64"], "libc": ["glibc"] }`.

`dist/src/ffi.js:91-100` is the load: `findBinary()`, then
`open({ library, path })` from `ffi-rs`. `dist/src/binary.js:122-144` resolves the
path — in a dev workspace (a `Cargo.toml` two levels up) it prefers
`<ws>/target/{release,debug}/<lib>`; in production it prefers the npm package, via
`createRequire(...)` + `require.resolve("<pkg>/package.json")` (`:73-90`).
`dist/src/platform.js:8-26` builds the Rust triple, and `detectLinuxLibc()`
(`:30-47`) shells out to **`execSync("ldd --version 2>&1")`** to choose gnu or musl.

**The fork's patch, and why it exists.** `pnpm-workspace.yaml:138` applies
`patches/@ff-labs__fff-node@0.9.4.patch`. It touches `dist/src/binary.js` only,
adding `resolveUnpackedAsarPath()` (`:49-58`) and calling it at `:82`:

```js
function resolveUnpackedAsarPath(binaryPath) {
  const pathSegments = binaryPath.split(sep);
  const asarIndex = pathSegments.findLastIndex((s) => s.endsWith(".asar"));
  if (asarIndex === -1) return binaryPath;
  pathSegments[asarIndex] = `${pathSegments[asarIndex]}.unpacked`;
  const unpackedPath = pathSegments.join(sep);
  return existsSync(unpackedPath) ? unpackedPath : binaryPath;
}
```

**This is the Electron fix.** `require.resolve` returns a path *inside*
`app.asar` / `server.asar`, but `dlopen` needs a real file, which lives in the
`.asar.unpacked` sibling. Upstream does not know about ASAR. **Anything added later
that `dlopen`s a Rust cdylib from inside a packaged Electron app needs the identical
trick.**

**How it stays loadable.** `scripts/lib/cli-external-packages.ts:28-50` is the
single source of truth for packages the server bundle must not inline:

```ts
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  "node-pty", "ffi-rs", "@yuuang/", "@ff-labs/", "@clerk/electron-passkeys",
  "@msgpackr-extract/", "msgpackr-extract", "node-gyp-build", "node-addon-api",
  "detect-libc", "bufferutil", "utf-8-validate",
] as const;
```

Two consumers derive from it and must never disagree: `apps/server/vite.config.ts`
(what stays external to the bundle) and `scripts/build-desktop-artifact.ts` (which
runtime dependency roots go into the Windows server sidecar). The header states the
rule that makes the list longer than it looks: *"An external package is loaded from
the real filesystem, so its own `require` also resolves from the real filesystem; a
dependency that was bundled away exists only inside the emitted bundle and is
unreachable there."* That closure is enforced by a test, not by inspection
(`scripts/lib/cli-external-packages.test.ts`).

**Platform prebuilt selection.** `resolveFffNativeDependencies(platform, arch, version)`
(`build-desktop-artifact.ts:1059-1084`) picks the optional packages to stage: mac →
`fff-bin-darwin-{arm64,x64}`, win → `fff-bin-win32-{arm64,x64}`, linux → **both**
`fff-bin-linux-<arch>-gnu` and `-musl`. `arch === "universal"` expands to both.

**Packaging, mac and linux.** The selected packages are merged into the staged
`package.json` dependencies (`:2884-2892`), then `vp install --prod` runs inside the
stage (`:2952-2959`). `createStageWorkspaceConfig` (`:1147-1194`) writes a stage
`pnpm-workspace.yaml` with explicit `supportedArchitectures` — on Linux it forces
`libc: ["glibc"]` (`:1168-1174`), because otherwise pnpm skips the optional platform
package. The `patches/` directory is copied along (`:2946-2948`) so the ASAR patch
survives. `app.asar` stays fully packed and electron-builder's default smart unpack
extracts the native libraries into `app.asar.unpacked` (`:2049-2052`).

**Packaging, Windows.** The whole server tree ships as a hand-packed
`resources/server.asar` sidecar (`stageWindowsServerSidecar`, `:2280-2360`; read side
at `DesktopEnvironment.ts:98-104`). Its dependency set is the runtime externals
**plus win32 fff bins plus linux fff bins** (`:2304-2309`), because the same tree
serves the Windows primary *and* the WSL Linux backend. `nodeLinker: "hoisted"` is
forced (`:1156-1160`) so the tree survives ASAR pack and extract without pnpm
symlinks. The unpack glob is (`:811-812`):

```
{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}
```

`extraResources` copies `server.asar` and `server.asar.unpacked/**/*` from **one**
FileSet (`:824-834`); the comment records that mapping `.unpacked` as an independent
FileSet silently dropped it.

**Three verification gates**, and they are the most transferable part:

1. **A real load probe.** `build-desktop-artifact.ts:2416-2490` runs the *actual
   packaged Electron binary* with `ELECTRON_RUN_AS_NODE=1`, `NODE_PATH=""` and
   `--no-global-search-paths`, evaluating a probe (`:418-433`) that dynamic-imports
   `<server.asar>/node_modules/@ff-labs/fff-node/dist/src/index.js` and performs a
   real `FileFinder.create({...})` + `destroy()`. That is the end-to-end proof the
   ASAR-unpacked patch works. Skipped on cross-arch builds (`:2431`).
2. **An emitted-bundle scan.** `findInlinedExternalPackages()`
   (`cli-external-packages.ts:124-152`) greps the rolldown `//#region` markers in
   the emitted chunk to catch a runtime-external package that got inlined anyway.
3. **A sidecar self-containment run.** `node --no-global-search-paths bin.mjs --version`
   in an isolated extracted copy with `NODE_PATH=""` (`:1587-1620`). The comment at
   `:1595-1600` notes this does *not* cover `fff`, because its import is lazy —
   which is precisely why gate 1 exists.

One special case is hand-handled: pnpm nests `@clerk/electron-passkeys`'s
architecture package in a way electron-builder cannot see, so the build stages that
`.node` binary itself (`:1091-1146`).

### 8.4 The template for a Rust fuzzy-finder module

Reading the three mechanisms together, the repository has already answered the
question — and for the fuzzy finder specifically, it has already done the work.

- **Do not write a napi/neon addon in this repo.** No precedent exists, and CI has
  no toolchain for one beyond `cargo`.
- **If the crate can be a subprocess, make it a subprocess** — `resource-monitor`
  is the pattern: one Cargo binary, NDJSON on stdio, a candidate-path resolver with
  a dev branch and a packaged branch, an env-var override, `extraResources` staging,
  tagged recoverable errors, and a `cargo fmt --check` + `cargo test` CI job.
- **If it must be in-process, publish a cdylib with a C ABI and load it through
  `ffi-rs`** — which is exactly what `fff` does, and `fff` is **already installed**.
  The Symmetria File Manager's C++ wrapper links the *same* `fff-c` ABI, so the
  Electron port can reuse the engine rather than reimplement it.
- **The paved road for that second option is complete**, and it is five parts:
  `CLI_RUNTIME_EXTERNAL_PREFIXES` for the bundle boundary,
  `resolveFffNativeDependencies` for per-platform prebuilts,
  `createStageWorkspaceConfig` for pnpm's `supportedArchitectures`, the
  `.asar.unpacked` patch for `dlopen`, and the packaged load probe as the gate.
- **The most likely outcome is that no new native work is needed at all.**
  `WorkspaceSearchIndex.ts` already exposes path indexing, content grep,
  directory/file/mixed search and frecency and history databases through Effect
  services. The open question is not *how to link `fff`* but *whether the file
  manager should call it through the server's RPC or open a second engine handle in
  the Electron main process* — and the Qt implementation's own constraint applies to
  that choice: LMDB refuses to open the same frecency environment twice in one
  process, and two processes on one database is a separate question that needs
  testing.

---

## 9. Build, test and quality gates

### 9.1 The runner

The monorepo is driven by **`vite-plus` (`vp`) 0.2.2**, VoidZero's unified web
toolchain: package manager, task runner, bundler, formatter, linter and test runner
in one. `vite` itself is aliased in the catalog to
`npm:@voidzero-dev/vite-plus-core@0.2.2` (`pnpm-workspace.yaml:54-55`). It ships
four binaries: **`vp`**, **`vpr`** (shorthand for `vp run`), **`oxlint`** and
**`oxfmt`**.

**There is no `.oxlintrc.json`, no `.prettierrc`, no `vitest.config.ts`, no
`vp.config.*`.** All of it lives in one file — the root `vite.config.ts`, which
exports five blocks: `resolve`, `test`, `staged`, `fmt`, `lint`. Per-package
`vite.config.ts` files add a `run.tasks` graph and a `pack` block.

One correction worth carrying: upstream's `vp check` means format + lint +
typecheck, but **in this repository `vp check` is format + lint only**, because
`lint.options` sets `typeAware: false` and `typeCheck: false`
(`vite.config.ts:158-160`) pending oxlint's tsgolint path integrating with the
`@effect/tsgo` diagnostics. Typecheck is therefore a separate `vpr typecheck`, and
CI runs both.

`t3.json` at the root is Mesura Code's own project descriptor, not build config: it
carries one worktree-create script that runs `vp i` and symlinks `.env`.

### 9.2 Dev

| Command | Effect |
|---|---|
| `pnpm dev` | `node scripts/dev-runner.ts dev` — server + web |
| `pnpm dev:desktop` | `node scripts/dev-runner.ts dev:desktop` |
| `pnpm dev:share` | as `dev`, plus a tailnet share; wait for the `pairingUrl:` line |

`scripts/dev-runner.ts` (~930 lines) is itself an Effect CLI program
(`Command.make` at `:857`, `NodeRuntime.runMain` at `:928`). It starts no server
itself. It resolves ports and environment deterministically, then spawns exactly one
child: `vp` with mode-specific `run` arguments (`:74-86`). For `dev:desktop` that is

```
vp run --filter=@t3tools/desktop --filter=@t3tools/web dev
```

**Ports.** Bases are `13773` (server) and `5733` (web) (`:27-28`). An offset comes
from `T3CODE_PORT_OFFSET` / `T3CODE_DEV_INSTANCE`, or is **hashed from the git
worktree path** (`:224-226`), so parallel worktrees never collide. Availability is
probed on `127.0.0.1` and `::1`, and WHATWG bad ports are skipped
(`:36-42`, `:105-107`).

**Environment** (`createDevRunnerEnv`, `:307-430`). Always written: `PORT`,
`VITE_DEV_SERVER_URL`, `T3CODE_PORT`. Always deleted:
`T3_SERVICE_LAUNCHER_CONTEXT` and `T3_BOOT_SERVICE_UNIT` (`:348-349`). For
**`dev:desktop`** everything is pinned to loopback — `VITE_HTTP_URL` and
`VITE_WS_URL` on `127.0.0.1`, `HOST=127.0.0.1` — and `T3CODE_SINGLE_ORIGIN_DEV`,
`T3CODE_MODE`, `T3CODE_NO_BROWSER` are deleted (`:381-391`, `:423-426`). A `--host`
override is ignored in desktop mode. Consequently **`--share` is refused for
`dev:desktop`** with a warning (`:723-733`): the renderer dials its own loopback, so
a tailnet visitor would load the UI and watch it fail.

`AGENTS.md:139-147` adds the operating rules: in a worktree, state defaults to that
worktree's gitignored `.t3`, which **outranks an ambient `T3CODE_HOME`**; the real
ports must be read from the `[dev-runner]` line; stop only what you started, by the
PID you tracked.

The desktop dev loop is `apps/desktop/vite.config.ts:21-35`: `vp pack --watch` on
the four CJS entries, with `onSuccess: node scripts/dev-electron.mjs` when
`T3CODE_DESKTOP_DEV=1`. **Electron is launched by the bundler's `onSuccess` hook,
not by the dev runner.** `dev-electron.mjs` waits for `dist-electron/main.cjs`,
`dist-electron/preload.cjs`, `../server/dist/bin.mjs` **and** the Vite dev port to
be reachable, then spawns Electron and restarts it (120 ms debounce) whenever those
files change.

`MESURA_DEV_TOOLS=1` opts into detached DevTools; upstream opened them on every dev
launch, and the fork turned that off because development is the daily driver
(`DesktopWindow.ts:760-766`).

### 9.3 Build

- `pnpm build` — `vp run` `build` across `apps/*`, `packages/*`,
  `oxlint-plugin-t3code`, `scripts`.
- `pnpm build:desktop` — `vp run --filter @t3tools/desktop --filter t3 build`.
  Vite+ resolves the task graph in three steps:
  1. `@t3tools/web#build` → `apps/web/dist`.
  2. `t3#build` (`dependsOn` the above) → `vp pack` the server, then **copy
     `apps/web/dist` into `apps/server/dist/client`**
     (`apps/server/scripts/cli.ts:165-171`). The server bundle inverts the usual
     policy: it inlines everything **except** the explicit exemption list, because
     the desktop build used to unpack 13 875 loose `node_modules` files.
  3. `@t3tools/desktop#build` (`dependsOn: ["t3#build"]`) →
     `node scripts/build-preview-annotation-css.mjs && vp pack` → the four CJS
     artifacts in `dist-electron/`.
- `pnpm dist:desktop:artifact` — `node scripts/build-desktop-artifact.ts`, a 116 KB
  Effect CLI (~3170 lines). Every flag has an env twin
  (`T3CODE_DESKTOP_PLATFORM`, `_TARGET`, `_ARCH`, `_VERSION`, `_OUTPUT_DIR`,
  `_SKIP_BUILD`, `_KEEP_STAGE`, `_SIGNED`, `_VERBOSE`, `_MOCK_UPDATES`, …). Its
  phases, in order:
  1. Create a temp stage root, scoped so it is deleted unless `--keep-stage`.
  2. `vp run build:desktop`, unless `--skip-build`.
  3. Assert the build inputs exist — including `apps/server/dist/client/index.html`
     — failing with `MissingDesktopBuildInputError` that names the fix command.
  4. Rebrand the bundled web client for the channel and validate its assets.
  5. Stage `dist-electron`, `resources`, the server dist, plus a synthesized
     `pnpm-workspace.yaml` and the `patches/` directory.
  6. Native pieces: `cargo build` per Rust target (`lipo` for universal), Clerk
     passkey `.node` relocation, and on Windows a prebuilt Linux `pty.node` for the
     WSL backend.
  7. Icons: `sips` + `iconutil` on macOS, a resized PNG set on Linux, `.ico` on
     Windows.
  8. `vp install --prod` inside the stage, then execute the packed server
     (`node bin.mjs --version`) as a self-containment proof.
  9. **electron-builder**, invoked as
     `vp exec --filter @t3tools/desktop -- electron-builder --projectDir <stage> --<platform> --<arch> --publish never`.
     There is **no `electron-builder.yml`** anywhere: the config is generated
     in-memory and written as the `build` key of the staged `package.json`.
  10. On Windows, load the packaged tree the way the WSL backend does.
  11. Copy artifacts to `--output-dir`; producing none is an error.

Per-platform aliases exist for dmg, AppImage and nsis. The release matrix that
actually calls this is macOS arm64 dmg, macOS x64 dmg, Linux x64 AppImage and
Windows x64 nsis (`.github/workflows/release.yml:341-367`).

Packages are **not built**. Every `packages/*` entry exports `./src/*.ts` source
directly with `types` and `import` both pointing at the `.ts` file; consumers
compile it.

### 9.4 Typecheck

`tsgo` — the Go-native TypeScript compiler, `@typescript/native-preview 7.0.0-dev.20260604.1`,
**patched** by `@effect/tsgo 0.13.2`. Every package runs `tsgo --noEmit`; the root
runs `vp run -r --concurrency-limit 2 typecheck` (aliased `pnpm tc`).

The patch is applied by `pnpm prepare`
(`node scripts/clean-tsgo-backups.mjs && effect-tsgo patch && vp config --no-agent`,
`package.json:6`). The cleanup step exists because `effect-tsgo patch` writes
`tsgo.original`, `.1`, `.2`… without ever removing them, and on a cache-restoring CI
runner it hard-fails at 101 backups (`scripts/clean-tsgo-backups.mjs:1-11`).

`tsconfig.base.json` is strict and then some: `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions` +
`rewriteRelativeImportExtensions` (which is why every relative import in this repo
ends in `.ts`). Plus the `@effect/language-service` diagnostic block described in
§5.3.

### 9.5 Lint

`vp lint` runs **oxlint** with plugins `eslint`, `oxc`, `react`, `unicorn`,
`typescript`, categories `correctness`/`suspicious`/`perf` at `warn`, and one
custom JS plugin (`vite.config.ts:89-160`):

```ts
jsPlugins: ["./oxlint-plugin-t3code/index.ts"],
```

The plugin is a workspace package of its own
(`oxlint-plugin-t3code/`, registered under the plugin name `t3code`), with a rule
per file and a colocated test per rule. All five rules will fire on file-manager
code:

| Rule | Severity | What it enforces |
|---|---|---|
| **`t3code/namespace-node-imports`** | error | Every `node:*` import must be a single namespace import with a canonical PascalCase alias — `import * as NodeFS from "node:fs"`. Special aliases: `node:os`→`NodeOS`, `node:url`→`NodeURL`, `node:vm`→`NodeVM`, `node:fs/promises`→`NodeFSP`, `node:assert/strict`→`NodeAssert`. Named and default imports from a builtin are reported. |
| **`t3code/no-global-process-runtime`** | error | Bans reading the host platform directly: `process.platform`, `process.arch`, `globalThis.process.*`, and `os.platform()` / `os.arch()` in any import form. Use `HostProcessPlatform` / `HostProcessArchitecture`. Exactly one file is exempt: `packages/shared/src/hostProcess.ts`. |
| **`t3code/no-inline-schema-compile`** | warn | Bans calling an Effect `Schema` **compiler** (28 methods: `Schema.is`, `asserts`, `decodeSync`, `decodeUnknownSync`, `decodeEffect`, `encodeSync`, `encodeUnknownEffect`, …) inside a function body. Hoist it to a module-level `const`. |
| **`t3code/no-manual-effect-runtime-in-tests`** | error | In `*.test.ts` only: bans 12 `Effect.run*` methods and `ManagedRuntime.make`. Use `@effect/vitest`'s `it.effect(...)` with test layers. **It carries a hard-coded debt baseline** of 26 files with a fixed permitted count each (for example `ProviderCommandReactor.test.ts` → 70), so existing debt is frozen and net-new occurrences fail. Every unlisted test file must be at zero — **a new file-manager test file gets no allowance**. |
| **`t3code/no-native-title-tooltip`** | error | Bans `title=` on intrinsic JSX elements; use `Tooltip` + `TooltipTrigger` + `TooltipPopup` from `components/ui/tooltip`. Exempts `embed`, `frame`, `iframe`, `math`, `object`. |

Two `no-restricted-imports` entries also matter: importing `@t3tools/client-runtime`
at the root is an **error** ("The package has no root export"), and
`CodeView` from `@pierre/diffs/react` is banned in favour of
`StyledDiffCodeView`.

Type-aware linting is **off** (`typeAware: false`, `typeCheck: false`) pending
oxlint's tsgolint path integrating with the `@effect/tsgo` diagnostics
(`vite.config.ts:158-160`). The Effect rules in §5.3 are enforced by tsgo instead.

A separate, non-oxlint lint exists for mobile native sources: `pnpm lint:mobile`
drives SwiftLint and detekt.

### 9.6 Format and git hooks

The formatter is **oxfmt**, run as `vp fmt` / `vp fmt --check`, with
`sortPackageJson` enabled. No Prettier, no Biome, no dprint.

**Hooks are managed by Vite+, not husky.** `core.hooksPath` is `.vite-hooks/_`,
installed by `vp config` in `prepare`, suppressible with `VITE_GIT_HOOKS=0`. There
is exactly one hook, `.vite-hooks/pre-commit`, whose entire contents are
`vp staged`. There is **no lint-staged**; `vp staged` reads the `staged` block:

```ts
// vite.config.ts:47-50
staged: {
  // Formatter only for now — no lint or typecheck on commit.
  "*": "vp fmt",
},
```

So **the only mechanically-enforced pre-commit gate is formatting.** There is no
commit-msg hook and no commitlint: Conventional Commits are a documented convention
only (`AGENTS.md:177-179`, which also asks for a body stating the problem then the
fix, ending with the model and harness that did the work). `AGENTS.md:176`: never
open a pull request unless explicitly asked.

Two ignore entries in the `fmt` block are load-bearing and must not be removed:
`packages/symmetria-broker-contract/schema/**` and `test/fixtures/**`. Both hold
bytes pinned by a checksum another repository reads, and the formatter collapsing a
short array onto one line would move that checksum with no schema having changed
(`vite.config.ts:66-78`).

### 9.7 Test

Vitest 4 through `vp test run`, with `@effect/vitest 4.0.0-beta.103` (patched) for
Effect suites, in eleven packages. Tests sit **beside** their source as `*.test.ts`,
not in a `__tests__` directory.

The root `test.maxWorkers` is **6**, and the 20-line comment above it is the
measurement that set it (`vite.config.ts:22-44`): on 2026-08-20 an unbounded run
reached load average 61 on 16 cores, 29 node processes at 827 % aggregate CPU, 27
of 30 GiB RAM and 14 of 15 GiB swap, each worker holding 480–660 MB; the host
thrashed for about 70 minutes and the suite was aborted mid-run at exit −1, with no
failing assertion. The comment also records that `maxWorkers` is the **vitest 4**
spelling and that the vitest 3 shape `poolOptions.forks.maxForks` now fails as
TS2769, cascading into every package that imports the root config.

**The critical caveat is that the root limit only reaches `apps/server`**, because
that is the one package composing the root config (`AGENTS.md:170`). `apps/web`,
`apps/mobile`, `apps/desktop` and `infra/relay` each open their own default-sized
pool. So `AGENTS.md` says twice (`:37`, `:170`): **never run bare `pnpm test`**; run
per package with an explicit bound — `vp test run --max-workers=3` from inside each
package — and never two in parallel. Tracked as issue #3.

`apps/server` additionally sets **`fileParallelism: false`** and 120 s timeouts,
because its suite exercises SQLite, git, temporary worktrees and orchestration
runtimes, and parallel files introduce load-sensitive flakes.

`AGENTS.md:169` forbids repo-wide checks in normal work: no `vp check`, no
`vp run -r test`, no `vp run -r typecheck` unless asked. CI owns the full suite.

### 9.8 CI — what a contribution must pass

`.github/workflows/ci.yml` runs on **every pull request** and on push to `main`,
with a per-PR concurrency group that cancels in progress. Every JS job bootstraps
with `voidzero-dev/setup-vp@v1` and a sparse checkout that excludes `/.repos/`.
Seven jobs, none of them `continue-on-error`:

| Job | Runner | Steps |
|---|---|---|
| **`check`** | `blacksmith-8vcpu-ubuntu-2404` | `vp run --filter @t3tools/desktop ensure:electron` → **`vp check`** (fmt + lint) → **`vpr typecheck`** → **`vp run build:desktop`** → verify the preload bundle |
| **`test`** | 8 vcpu ubuntu | `vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' test` — everything except `apps/server` |
| **`test_server`** | 8 vcpu ubuntu, **matrix shard 1/2/3**, `fail-fast: false` | `vp run --filter t3 test --shard N/3`, plus a thread-transfer-budget report artifact |
| **`rust`** | 4 vcpu ubuntu | `cargo fmt --check` and `cargo test --locked` on `native/resource-monitor` |
| **`mobile_native_changes`** | 2 vcpu ubuntu | API-only path detection, **fails open** |
| **`mobile_native_static_analysis`** | `blacksmith-6vcpu-macos-26`, gated | `brew bundle` then `vp run lint:mobile` |
| **`release_smoke`** | 8 vcpu ubuntu | `node scripts/release-smoke.ts` |

The server suite is sharded because `fileParallelism: false` means its 239 files run
one at a time; shards put them on separate machines instead of separate workers. The
macOS job is gated because macOS minutes bill about 6.7× Linux.

**The preload verification step is worth knowing about**, because a file-manager
bridge would want the same guard. It asserts `dist-electron/preload.cjs` exists and
contains the literal strings `desktopBridge`, `getLocalEnvironmentBootstrap`,
`PICK_FOLDER_CHANNEL`, `wsUrl` and `__clerk_internal_electron_passkeys`.

So a contribution must pass:

1. `vp check` — oxfmt clean and oxlint clean, including all five `t3code/*` rules.
2. `vpr typecheck` — `tsgo --noEmit` green in every package, including the
   `@effect/language-service` error-level diagnostics.
3. `vp run build:desktop` — the full web → server → desktop chain, with the preload
   symbol check.
4. The non-server suite in one job, and `apps/server` across three shards.
5. If it touches Rust: `cargo fmt --check` and `cargo test --locked`.
6. `scripts/release-smoke.ts`.
7. If it moves mobile native sources: SwiftLint and detekt on macOS.

There is one extra desktop gate available locally,
`pnpm test:desktop-smoke` → `apps/desktop/scripts/smoke-test.mjs`: it launches the
packed Electron main for 8 s with an empty `VITE_DEV_SERVER_URL` and fails if the
output contains `Cannot find module`, `MODULE_NOT_FOUND`, `Refused to execute`, or
any `Uncaught …`. That is the gate that catches an externalisation mistake of the
kind §8.3 describes.

Two other workflows label rather than gate: `pr-size.yml` stamps a `size:*` label,
and `pr-vouch.yml` stamps `vouch:*` from `.github/VOUCHED.td`.

`release.yml` (44 KB) runs on a `v*.*.*` tag, on **cron `0 */3 * * *`** for
nightlies, and on dispatch. Its build matrix is the four platform artifacts named in
§9.3, followed by `publish_cli` (npm), the GitHub Release, `publish_aur`,
`deploy_web` and a Discord announcement.

### 9.9 Packaging beyond electron-builder

`packaging/aur/` maintains two AUR packages, `t3code-bin` (stable) and
`t3code-nightly-bin`, both repackaging the official x86_64 AppImage from GitHub
Releases. Points worth noting if a standalone file manager ever ships the same way:

- `PKGBUILD` extracts the AppImage in `prepare()` and **hard-fails if `AppRun` or
  `chrome-sandbox` is missing**. `package()` installs to `/opt/t3code-bin`, sets
  `chmod 4755` on `chrome-sandbox` (setuid, required for the Chromium sandbox on
  Arch), writes a `/usr/bin/t3code` shim, and installs a `.desktop` entry carrying
  `MimeType=x-scheme-handler/t3code;`.
- `packaging/aur/scripts/release.sh` takes the AppImage SHA-256 straight from the
  GitHub release asset's `digest` field rather than re-downloading to hash it, then
  runs `namcap` → `makepkg --printsrcinfo` → a **full `makepkg` build** → `namcap`
  on the result, all as an unprivileged `builder` user. It publishes only if
  `AUR_SSH_PRIVATE_KEY` is present, so it doubles as a local validation script, and
  it exits 0 silently for a tag it does not recognise.

`docs/mesura/ci.md` holds the fork's own CI notes.

---

## 10. Where a file manager would live

### 10.1 The two goals pull in opposite directions

Goal one wants a **standalone resident file manager**. Goal two wants it **inside
Mesura's single window**. Any single location satisfies one and betrays the other,
so the recommendation is a **split across four places**, following the precedent
this repository has already set twice.

### 10.2 Recommendation

**(a) `packages/file-manager-core/` — a new workspace package. The centre of
gravity.**

Everything decidable and framework-free: the directory model, sorting, filtering,
preview-type classification, the keybinding registry, path utilities, the fuzzy
finder wrapper, the git-status model. Effect-based. **No Electron import, no React
import, no `node:*` import that has an Effect service.**

Follow `packages/shared` exactly — it is the pattern to copy, and it is the
majority pattern: of the eight existing packages, **five have no root export and no
barrel at all** (`shared`, `client-runtime`, `ssh`, `effect-acp`,
`effect-codex-app-server`), and the three that do have one document why.
`packages/shared` has no `src/index.ts` and no `"."` key — about sixty subpaths, one
per file, each in this exact two-key shape:

```json
{
  "name": "@symmetria/file-manager-core",
  "private": true,
  "type": "module",
  "exports": {
    "./directoryModel": { "types": "./src/directoryModel.ts", "import": "./src/directoryModel.ts" }
  },
  "scripts": { "typecheck": "tsgo --noEmit", "test": "vp test run" }
}
```

One `./name` key per source file, both conditions pointing at `./src/<name>.ts`, no
root `"."` key, no barrel, no build step. Add the package to
`pnpm-workspace.yaml` (`packages/*` already globs it).

**(b) `apps/desktop/src/fileManager/` — a new fork-owned directory in the main
process.**

The privileged half: directory scanning, watching, thumbnailing, the `fff` engine
handle, trash and copy operations. One `Context.Service` per concern, one
`export const layer` per module, all merged into `desktopApplicationLayer` with
**one line in `src/main.ts`**.

Register IPC channels the way `ThreadPublisher` does — inline in the layer's `make`
— so `DesktopIpcHandlers.ts` and `methods/` are never touched.

**(c) `packages/file-manager-ui/` — the React surface, as a package, not as a
feature folder.**

Miller columns, the tree, the preview pane, the finder popup. It must be
importable by *two* hosts, so it cannot live in `apps/web/src`. Keep it host-blind:
it receives a transport adapter as a prop or a context value, and does no
`window.desktopBridge` lookup of its own. Reuse `@legendapp/list` for
virtualisation and Tailwind v4 utilities for styling, so it looks native in Mesura
without a second design system.

Mesura's mount point is then a small `apps/web/src/fileManager/` directory — the
route, the adapter, and nothing else. That mirrors `apps/web/src/symmetria/`
exactly.

**(d) `apps/file-manager/` — a new `apps/` entry for the standalone product.**

Its own Electron main process, its own resident daemon (Unix socket, §6), its own
windows, consuming (a) and (c). **Not a fork of `apps/desktop`.** A sibling under
`apps/` conflicts with upstream never, since upstream has no such directory.

### 10.3 Why not each single-location alternative

| Option | Why it fails alone |
|---|---|
| **Feature folder in `apps/desktop` only** | Cheapest to build and zero upstream conflict, but it can never run standalone. That is goal one, and goal one is listed first in `00-index.md`. |
| **A single new `apps/` entry only** | Gives standalone immediately, but the Mesura integration then either duplicates the whole UI or embeds a second Electron app inside the first. ADR-002 forbids the second window on measured grounds. |
| **A single new `packages/` entry only** | A package cannot own a process or a window. It is necessary, not sufficient. |

### 10.4 The costs, stated so they are accepted rather than overlooked

- **One indirection.** The core package cannot import Electron, so anything
  needing a `BrowserWindow` or `dialog` must be injected. That is the same
  discipline `symmetria/socketFiles.ts` already keeps against `node:fs`, and the
  `@effect/language-service` diagnostics enforce most of it for free.
- **Two hosts, two lifecycles.** Every capability must be reachable from both, so
  a shared interface has to exist before either implementation. Budget one
  `Context.Service` interface per capability, two layers per interface.
- **The `DesktopBridge` question is unresolved and is on the critical path.**
  Adding file-manager members to `packages/contracts/src/ipc.ts` (39 commits in
  three months) is explicitly forbidden by the comment at `ipc.ts:1146-1157`
  without first reading issue #16. Either resolve #16 with declaration merging, or
  expose a **separate** `window.mesuraFileManager` bridge. The second still needs
  a line in `apps/desktop/src/preload.ts` (22 commits); Electron 41's
  `session.registerPreloadScript` is a possible way to avoid even that, but nothing
  in this repository uses it and it is unverified here.
- **ADR-002's unpaid bill comes due.** The ADR names the File Manager as the thing
  that turns the flat per-project memory line into a slope of unmeasured gradient,
  and names **eviction** as the work that must then be built (`adr-002:117-125`).
  A file manager holding a watcher, a thumbnail cache and a directory model per
  project is precisely that load. Measure with two projects loaded before deciding
  whether eviction is urgent or eventual — the ADR lists that measurement as open
  question 2.
- **The `t3` server is the other candidate host and it may be the better one for
  half the capabilities.** `apps/server/src/workspace/` already lists directories,
  walks paths, greps content and drives `fff` through an Effect `LayerMap.Service`
  with TTLs and caps (§8.3) — and it already works for remote, SSH and WSL
  environments, which the Electron main process does not. A capability that must
  work against a *remote* project belongs there. A capability that must work on the
  *local* machine with no server running belongs in the main process. Decide per
  capability, not once, and write the decision down per capability.
- **The fuzzy finder may need no native work at all.** `fff` is already installed,
  already indexed per working directory, and already exposed over the WebSocket RPC.
  Re-linking it in the Electron main process would open a second LMDB frecency
  environment against the same database — a case the Qt implementation's own notes
  say fails *within* one process and which has not been tested *across* two.
  Prefer routing through the server first, and treat a second engine handle as a
  measured decision rather than a default.

### 10.5 What to copy, verbatim, on day one

1. The directory layout and module split of `apps/desktop/src/symmetria/` — pure
   protocol module, pure logic module, thin Effect layer, shared filesystem
   helper.
2. The "never fail startup" posture: bind best-effort, catch, log a warning, return
   `Option.none()`, and always install an `error` listener on any `net.Server`.
3. `packages/shared`'s manifest shape for the new packages.
4. `packages/symmetria-broker-contract`'s generation-plus-checksum discipline, if
   the file manager gains a wire format of its own.
5. `resource-monitor`'s candidate-path resolver, tagged errors and CI job, for any
   Rust that ships as a binary.
6. The `@ff-labs/fff-node` chain — `ffi-rs` plus a per-platform cdylib package plus
   the `.asar.unpacked` patch plus an entry in `CLI_RUNTIME_EXTERNAL_PREFIXES` —
   for any Rust that must run in-process. `fff` is already installed and is the
   same engine the Qt file manager links.
7. `runtimeAbi.test.ts`'s drift guard — a size budget plus a build-identifier
   comparison against the pinned `VERSION` — for any binary artifact that gets
   committed rather than built.

### 10.6 The three questions that must be answered before any code is written

1. **How does the file manager reach the main process?** Resolve issue #16, or
   design a second bridge. Everything else waits on this, and it is one decision
   with a lasting merge-cost consequence.
2. **Server RPC or main-process service, per capability?** Draw the line explicitly
   before implementing, because moving a capability across it later means rewriting
   its transport.
3. **What does one loaded project cost?** ADR-002's open question 2. Measure it
   with two projects before the surface grows, so that eviction is scheduled rather
   than discovered.
