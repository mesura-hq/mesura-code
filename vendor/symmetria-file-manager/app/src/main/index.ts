import { fileURLToPath, pathToFileURL } from "node:url";
import { BRIDGE_KEY } from "@symmetria/fm-core/bridge";
import {
  decodePickerAnswer,
  decodePickerDismissal,
  PICKER_FIFO_PREFIX,
} from "@symmetria/fm-core/command";
import { failure, isFailure } from "@symmetria/fm-core/contract";
import { homeQuery, pickerQuery } from "@symmetria/fm-core/windowUrl";
import { PUSH_CHANNELS, REQUEST_CHANNELS } from "@symmetria/fm-main/ipc/channels";
import type { ElectronTransport } from "@symmetria/fm-main/ipc/electronSurface";
import { electronIpcSurface } from "@symmetria/fm-main/ipc/electronSurface";
import { createRegistry, type Registry } from "@symmetria/fm-main/ipc/register";
import { closeAllSearchIndices } from "@symmetria/fm-main/search";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { writeToFifo } from "./fifo.ts";
import { refuseDocumentRequestsOffScheme, refuseNavigationAwayFromApp } from "./frameNavigation.ts";
import { createResidency } from "./lifecycle.ts";
import {
  createPickerHost,
  type OpenPickerWindow,
  type PickerHost,
  type PickerHostOptions,
  pickerWindowOptions,
} from "./picker.ts";
import { APP_ENTRY_URL, handleAppScheme, previewUrlFor, registerAppScheme } from "./protocol.ts";
import { type CommandHandler, claimSocket, daemonSocketPath, sendCommand } from "./socket.ts";
import { buildWindowOptions } from "./window.ts";

// Must happen before the app is ready. See `protocol.ts` for why the renderer
// is not served over `file://`.
registerAppScheme();

/**
 * Set by the smoke test. Never set in normal use.
 */
const SMOKE = process.env.SYMMETRIA_FM_SMOKE === "1";

/**
 * "Another daemon already holds the socket." NOT exit 1.
 *
 * The unit tells systemd not to restart on this code, because retrying it can
 * never succeed — and the value has to be one nothing else produces. Exit 1 was
 * used here first and was wrong: Node exits 1 for an uncaught exception, and the
 * launcher script exits 1 on three of its own failures, so
 * `RestartPreventExitStatus=1` also told systemd to stop restarting after a real
 * crash. That is the opposite of what `Restart=always` is for, and it turned a
 * loop into a silent death.
 *
 * 69 is `EX_UNAVAILABLE` from sysexits.h — the service is unavailable to this
 * process because another is providing it, which is exactly the situation.
 */
const ALREADY_RUNNING = 69;

/**
 * There is no `app.setDesktopName()` in Electron 41 — an earlier draft of the
 * plan said there was, and it is wrong. Electron reads the Linux desktop-entry
 * name from the `desktopName` field of `package.json`, which is where
 * `symmetria-fm-electron.desktop` is declared.
 *
 * That identifier is deliberately distinct from the Qt build's `symmetria-fm`
 * so the two applications can run side by side while the rewrite is built. Qt's
 * three-way desktop-entry contract is documented in CLAUDE.md under Service &
 * Portal; the Electron equivalent is four-way, and `desktopName` is one corner.
 */
app.setName("Symmetria File Manager");

/**
 * Whether a close destroys the window, and it never does until a real quit.
 *
 * This is the residency half of decision D3, which shipped without it: the
 * previous version quit the process when the last window closed, under a
 * comment citing the very decision that says one window should stay resident.
 */
const residency = createResidency();

let shownOnReadyToShow = false;

/**
 * The window, and a promise that it has painted.
 *
 * Named rather than returned as an anonymous object type: the two are handed
 * around together and a caller reading `{ window, painted }` has to guess what
 * the second one means.
 */
interface StartedWindow {
  readonly window: BrowserWindow;
  /** Resolves once `ready-to-show` has fired, never before. */
  readonly painted: Promise<void>;
}

function createWindow(): StartedWindow {
  const window = new BrowserWindow(buildWindowOptions());

  // A previewed page may be loaded and may not go anywhere afterwards. The
  // preview frame's own permission list stops a form submit and a popup and
  // does NOT stop the frame navigating itself — a link click inside a previewed
  // page fetched a remote site. See `frameNavigation.ts`.
  refuseNavigationAwayFromApp(window.webContents);

  // Show only once the renderer has something to paint. Paired with the
  // background colour in `buildWindowOptions`, this is what removes the white
  // flash on open.
  //
  // The promise is what the smoke report waits on. `did-finish-load` and
  // `ready-to-show` are independent events with no guaranteed order, and a
  // report written on the first one sampled this flag before the second had
  // fired — which made the assertion about it fail intermittently, in the
  // harness rather than in the product.
  const painted = new Promise<void>((resolve) => {
    window.once("ready-to-show", () => {
      shownOnReadyToShow = true;
      window.show();
      resolve();
    });
  });

  // Hide, never destroy. The tab set, the cursor and the scroll position live
  // in the renderer, so a destroyed window loses all three and coming back is a
  // fresh start — which is the opposite of the "one place I return to" this
  // application is for.
  //
  // The guard is not defensive habit. Without it the process is unkillable by
  // the ordinary route: `systemctl --user stop` would hang and only a SIGKILL
  // would end it, which is a worse defect than the one being fixed.
  window.on("close", (event) => {
    if (!residency.shouldHideOnClose()) return;
    event.preventDefault();
    window.hide();
  });

  // Two facts, carried separately on purpose: the fragment is where this window
  // OPENS, the query is where HOME is. Neither reaches the scheme handler —
  // `protocol.ts` reads only the hostname and the pathname — so both add a
  // parameter without widening the surface it has to validate. See
  // `windowUrl.ts` for why they must not be conflated.
  const home = app.getPath("home");
  void window.loadURL(`${APP_ENTRY_URL}${homeQuery(home)}#${encodeURIComponent(home)}`);
  return { window, painted };
}

/** The built page's own `file://` URL, used as the probe target. */
function ownPageFileUrl(): string {
  return pathToFileURL(
    fileURLToPath(new URL("../renderer/index.html", import.meta.url)),
  ).toString();
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the smoke report says about the window surviving a close.
 *
 * Declared here rather than inferred, because the smoke test declares the same
 * shape on its side and the two have to be readable against each other. A field
 * added here without one there is a field nothing asserts.
 */
interface ResidencyReport {
  readonly windowsBeforeClose: number;
  readonly destroyedAfterClose: boolean;
  readonly visibleAfterClose: boolean;
  readonly windowsAfterClose: number;
  readonly tabPathsBeforeClose: readonly string[];
  readonly tabPathsAfterShow: readonly string[];
  readonly cursorBeforeClose: number;
  readonly cursorAfterShow: number;
  /**
   * The listing's scroll offset, which the acceptance criterion names and the
   * first version of this probe did not measure.
   *
   * Verification said so plainly: tabs and cursor were measured, scroll was
   * not, and nothing in the phase demonstrated it survived. A criterion nobody
   * measured is a criterion nobody met.
   */
  readonly scrollBeforeClose: number;
  readonly scrollAfterShow: number;
  /** Proof the offset was not simply zero at both ends, which would prove nothing. */
  readonly scrollWasNonZero: boolean;
  readonly quitRanAfterRequest: boolean;
  /** True when a close driven from PAGE code also hid rather than destroyed. */
  readonly survivedRendererClose: boolean;
}

/**
 * Give the window a second tab, through the real socket.
 *
 * `/usr/bin` rather than `/usr`, and the difference is load-bearing: a column
 * only scrolls when its content overflows, and `/usr` holds about ten entries on
 * this system. The first version used it and could not move the scroll offset
 * off zero, which would have made "the scroll position survived" true and empty.
 *
 * Driven over the socket rather than by calling the handler directly, so what is
 * exercised is the path a user's command actually takes: it arrives from
 * outside, is decoded, reaches the renderer and becomes a tab.
 */
async function openSecondTab(window: BrowserWindow, socketPath: string): Promise<void> {
  await sendCommand(socketPath, { cmd: "open", path: "/usr/bin" });

  for (let i = 0; i < 100; i++) {
    // SAFETY: `NodeList.length` is a number by the DOM specification, and the
    // expression is a literal here rather than anything a caller supplies.
    const count = (await window.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="tab"]').length`,
    )) as number;
    if (count >= 2) return;
    await delay(50);
  }
}

/**
 * Put the listing somewhere other than the top.
 *
 * Retried rather than set once: the listing arrives asynchronously and the
 * virtualiser sizes the scroll area only after the rows exist, so an offset
 * written too early is silently clamped straight back to zero.
 */
async function scrollTheListing(window: BrowserWindow): Promise<void> {
  for (let i = 0; i < 40; i++) {
    // SAFETY: the literal below returns a number on every path.
    const offset = (await window.webContents.executeJavaScript(`(() => {
      const column = document.querySelector('[data-testid="column-current"]');
      if (column === null) return -1;
      column.scrollTop = 120;
      return column.scrollTop;
    })()`)) as number;
    if (offset > 0) {
      // Settle before anything reads it back: the virtualiser re-renders rows
      // on scroll and the offset is only stable once that has run.
      await delay(150);
      return;
    }
    await delay(100);
  }
}

/**
 * What the window and its state do across a close.
 *
 * Split into three because the whole thing scored a CRAP of 72 against a bound
 * of 30 — cyclomatic 8 with no coverage data, which is what an uncovered probe
 * in the main process looks like to the gate. The split is along the seam it
 * already had: set the state up, put it somewhere non-default, then measure.
 */
async function measureResidency(
  window: BrowserWindow,
  socketPath: string,
): Promise<ResidencyReport> {
  const read = () =>
    // SAFETY: the expression evaluated below is a literal in this file and
    // returns exactly this shape on every path — there is no branch that omits
    // a field. `executeJavaScript` is typed `Promise<any>` because it cannot
    // know that, so the assertion states what the literal above guarantees.
    window.webContents.executeJavaScript(`(() => {
      const column = document.querySelector('[data-testid="column-current"]');
      return {
        tabPaths: Array.from(document.querySelectorAll('[data-testid="tab"]')).map((t) => t.textContent),
        cursor: (() => {
          const rows = Array.from(document.querySelectorAll('[data-testid="column-current"] [data-testid="row"]'));
          return rows.findIndex((r) => r.getAttribute("data-cursor") === "true");
        })(),
        scroll: column === null ? -1 : column.scrollTop,
      };
    })()`) as Promise<{ tabPaths: string[]; cursor: number; scroll: number }>;

  await openSecondTab(window, socketPath);
  await scrollTheListing(window);

  const before = await read();
  const windowsBeforeClose = BrowserWindow.getAllWindows().length;

  // The route page code takes, exercised FIRST because it is the one that was
  // broken: the renderer used to call `window.close()` here, which destroys the
  // window without raising its `close` event at all.
  await window.webContents.executeJavaScript(
    `window[${JSON.stringify(BRIDGE_KEY)}].hideWindow({})`,
  );
  await delay(300);
  const survivedRendererClose = !window.isDestroyed() && !window.isVisible();
  if (!window.isDestroyed()) window.show();
  await delay(200);

  window.close();
  await delay(300);

  const destroyedAfterClose = window.isDestroyed();
  const windowsAfterClose = BrowserWindow.getAllWindows().length;
  if (destroyedAfterClose) {
    // Reading anything else would throw on a destroyed window. Reporting the
    // fields that were reachable is what lets the failing assertion name the
    // real defect instead of an exception inside the probe.
    return {
      windowsBeforeClose,
      destroyedAfterClose,
      visibleAfterClose: true,
      windowsAfterClose,
      tabPathsBeforeClose: before.tabPaths,
      tabPathsAfterShow: [],
      cursorBeforeClose: before.cursor,
      cursorAfterShow: -1,
      scrollBeforeClose: before.scroll,
      scrollAfterShow: -1,
      scrollWasNonZero: before.scroll > 0,
      quitRanAfterRequest: false,
      survivedRendererClose,
    };
  }

  const visibleAfterClose = window.isVisible();
  window.show();
  await delay(300);
  const after = await read();

  return {
    windowsBeforeClose,
    destroyedAfterClose,
    visibleAfterClose,
    windowsAfterClose,
    tabPathsBeforeClose: before.tabPaths,
    tabPathsAfterShow: after.tabPaths,
    cursorBeforeClose: before.cursor,
    cursorAfterShow: after.cursor,
    scrollBeforeClose: before.scroll,
    scrollAfterShow: after.scroll,
    scrollWasNonZero: before.scroll > 0,
    quitRanAfterRequest: await canStillQuit(),
    survivedRendererClose,
  };
}

/**
 * What a picker does when it is really driven over the socket.
 *
 * The one-at-a-time logic and the title rule are unit-tested against an
 * injected window factory. What only a launched process can show is the part
 * the desktop cares about: that a real second window appears, that it carries
 * the routing title when it maps AND after the page has had its chance to
 * replace it, and that closing it leaves the resident daemon serving.
 */
/** Whichever window is not the resident one, or none. */
function dialogBeside(browse: BrowserWindow): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((each) => each !== browse) ?? null;
}

/**
 * The title the window ends up with once its page has had its chance.
 *
 * Split out of `measurePicker`, which the complexity gate scored at a CRAP of
 * 42 against a bound of 30 — the same thing that happened to `measureResidency`
 * and the same seam: waiting for a page and reading one value off it is its own
 * step.
 *
 * The wait is raced against a timer deliberately. A load that never finished
 * would park the probe forever and arrive as the harness's own 45-second
 * timeout — a probe bug wearing the disguise of a hang, which is the hardest
 * shape of failure to read. This one did exactly that once already.
 */
async function titleAfterLoading(dialog: BrowserWindow | null): Promise<string> {
  if (dialog === null) return "";

  await Promise.race([
    new Promise<void>((resolve) => {
      if (!dialog.webContents.isLoading()) return resolve();
      dialog.webContents.once("did-finish-load", () => resolve());
    }),
    delay(5_000),
  ]);
  await delay(200);

  return dialog.isDestroyed() ? "" : dialog.getTitle();
}

async function measurePicker(
  browse: BrowserWindow,
  socketPath: string,
): Promise<Record<string, unknown>> {
  const fifo = `${PICKER_FIFO_PREFIX}smoke.fifo`;
  const windowsBefore = BrowserWindow.getAllWindows().length;

  const created = await sendCommand(socketPath, {
    cmd: "createPicker",
    fifo,
    title: "Save your download",
    saveMode: true,
  });

  const dialog = dialogBeside(browse);
  // Sampled BEFORE the page has loaded, which is the only moment that answers
  // the question the compositor asks: the rule is evaluated when the window
  // maps, not when the document finishes.
  const titleAtMap = dialog === null ? "" : dialog.getTitle();
  const windowsAfterCreate = BrowserWindow.getAllWindows().length;
  const titleAfterLoad = await titleAfterLoading(dialog);

  const second = await sendCommand(socketPath, {
    cmd: "createPicker",
    fifo: `${PICKER_FIFO_PREFIX}second.fifo`,
  });
  const windowsAfterSecondCreate = BrowserWindow.getAllWindows().length;

  // A close naming a DIFFERENT request must not touch this one — the failing
  // path, and the one a blind implementation gets wrong.
  await sendCommand(socketPath, { cmd: "closePicker", fifo: `${PICKER_FIFO_PREFIX}other.fifo` });
  await delay(200);
  const windowsAfterForeignClose = BrowserWindow.getAllWindows().length;

  await sendCommand(socketPath, { cmd: "closePicker", fifo });
  await delay(400);

  // Not "did this line run" — that would be true whatever happened. The daemon
  // is asked to do something after the picker has gone, so a process that had
  // quit, or a socket that had stopped being served, shows up as a refusal.
  const afterClose = await sendCommand(socketPath, { cmd: "open", path: "/usr" });

  return {
    windowsBefore,
    createAccepted: created.ok,
    windowsAfterCreate,
    titleAtMap,
    titleAfterLoad,
    secondCreateRejected: second.ok === false,
    windowsAfterSecondCreate,
    windowsAfterForeignClose,
    windowsAfterClose: BrowserWindow.getAllWindows().length,
    browseWindowAliveAfterClose: !browse.isDestroyed(),
    daemonStillAnswersAfterClose: afterClose.ok,
  };
}

/**
 * Does a deliberate quit still get through the close interception?
 *
 * `will-quit` is prevented so the report can still be written; what matters is
 * that it fired at all. A blocked quit resolves false on the timer instead of
 * hanging the launch until the harness's own timeout, which would arrive as a
 * mysterious 45-second failure rather than as a named one.
 */
function canStillQuit(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_000);
    app.once("will-quit", (event) => {
      event.preventDefault();
      clearTimeout(timer);
      resolve(true);
    });
    app.quit();
  });
}

/**
 * Launch, report on the running application, and exit.
 *
 * This exists so the smoke test can assert facts that only hold in a real
 * process — above all that the sandboxed renderer cannot reach the filesystem.
 * The probes run in the renderer's main world, which is the world page code
 * sees, so a pass here means page code genuinely has no way through.
 */
async function reportAndQuit(window: BrowserWindow, socketPath: string): Promise<void> {
  const probe = await window.webContents.executeJavaScript(`(async () => ({
    rendererCanRequireFs: (() => {
      try { return typeof require === "function" && !!require("node:fs"); }
      catch { return false; }
    })(),
    rendererHasNodeProcess: typeof process !== "undefined",
    rendererBridgePresent: typeof window[${JSON.stringify(BRIDGE_KEY)}] === "object",
    // The route verification found open: a page on a file:// origin may fetch
    // any other file:// resource. Probed here so it can never reopen silently.
    //
    // The target is the application's OWN page, by absolute file path. It is
    // certain to exist and to be readable, so a negative result means the
    // origin has no file:// privilege — and cannot mean "that file happened to
    // be missing", which is what a probe against a system path would allow.
    rendererCanFetchLocalFile: await fetch(${JSON.stringify(ownPageFileUrl())})
      .then((r) => r.ok)
      .catch(() => false),
    rendererOrigin: window.location.protocol,
    // The bridge, exercised from page code. This is the criterion the phase is
    // for: the renderer has no filesystem, so a listing it can name proves the
    // only route to the disk works, and works from the sandbox.
    bridgeList: await (async () => {
      try {
        const reply = await window[${JSON.stringify(BRIDGE_KEY)}].list({ path: "/usr", showHidden: false });
        return reply.ok ? reply.value.entries.length : "err:" + reply.error.code;
      } catch (e) { return "threw:" + String(e); }
    })(),
    bridgeRejectsBadInput: await (async () => {
      try {
        const reply = await window[${JSON.stringify(BRIDGE_KEY)}].list({ path: 7 });
        return reply.ok === false && reply.error.code === "invalid_request";
      } catch { return false; }
    })(),
    bridgeKeys: Object.keys(window[${JSON.stringify(BRIDGE_KEY)}]).sort().join(","),
    // How a row lays out when its name is too wide for its column.
    //
    // Measured here because it cannot be measured anywhere else. The renderer
    // suite runs under happy-dom, which has no layout engine and computes no
    // cascade: it reports a flex-shrink no algorithm ever ran and a bounding
    // rect of zeros. Only a real Chromium can tell an aligned row from a
    // misaligned one.
    //
    // It measures the COMPONENT'S OWN row rather than markup of its own,
    // lengthening the name in place to force the overflow. A probe that built
    // its own row would be measuring its own styles and would pass whatever the
    // stylesheet said.
    rowLayout: await (async () => {
      const findRow = async () => {
        // The listing is asynchronous, and this runs at did-finish-load — the
        // page is up well before the first directory answers.
        for (let i = 0; i < 100; i++) {
          const found =
            document.querySelector('[data-testid="column-current"] [data-testid="row"]') ??
            document.querySelector('[data-testid="row"]');
          if (found !== null) return found;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      };

      const row = await findRow();
      if (row === null) return "no-row";

      const mark = row.querySelector(".row__mark");
      const name = row.querySelector(".row__name");
      const icon = row.querySelector(".file-icon");
      if (mark === null || name === null || icon === null) return "row-missing-parts";

      const original = name.textContent;
      const fittingIconLeft = icon.getBoundingClientRect().left;

      // The trailing symlink arrow is drawn only for a symlink, and the home
      // directory need not contain one. Added to the real row so it inherits
      // the real cascade.
      const link = document.createElement("span");
      link.className = "row__link";
      link.textContent = "→";

      // The restore is in a finally, and that is not defensive habit. Without
      // it, a measurement that throws escapes this function, app.exit(0) is
      // never reached, and the launch hangs until the harness's 45-second
      // timeout kills it — a probe bug arriving disguised as a timeout, which
      // is the hardest shape of failure to read.
      let measured;
      try {
        name.textContent = "overflow".repeat(60);
        row.appendChild(link);

        measured = {
          fittingIconLeft,
          overflowingIconLeft: icon.getBoundingClientRect().left,
          overflowingMarkWidth: mark.getBoundingClientRect().width,
          overflowingLinkWidth: link.getBoundingClientRect().width,
          // Reported so a mis-escaped literal cannot pass as an arrow. This
          // string crosses two levels of escaping to reach the page, and a
          // width alone would be satisfied by the six characters of a broken
          // escape as readily as by the glyph.
          overflowingLinkText: link.textContent,
          // Clipping is what an ellipsis needs. With no overflow rule the item
          // never shrinks, so its content box equals its content and the two
          // are identical.
          nameClipped: name.clientWidth < name.scrollWidth,
        };
      } finally {
        link.remove();
        name.textContent = original;
      }

      // Measured AFTER the finally, so it reports on the restoration itself.
      // The containment test asks about this probe's OWN node rather than about
      // any row__link element, which a genuinely symlinked row would carry too.
      //
      // NOTE: no backticks anywhere inside this probe. The whole thing is one
      // template literal, so a backtick even in a comment ends the string and
      // everything after it is parsed as TypeScript.
      return { ...measured, rowRestored: name.textContent === original && !row.contains(link) };
    })(),
  }))()`);

  // Sampled BEFORE the residency probe, and that ordering is load-bearing.
  //
  // `measureResidency` ends by proving a deliberate quit still gets through the
  // close interception, and a quit destroys the window. Reading these two
  // afterwards reported zero windows and an empty title — a real regression in
  // the report, from a probe rather than from the product. Sampling at boot is
  // also what these two assertions are actually about.
  const windowCount = BrowserWindow.getAllWindows().length;
  const title = window.getTitle();

  // Before the residency probe and after the window count, and both matter:
  // it opens a second window, so a count taken afterwards would be 2, and the
  // residency probe ends by quitting.
  const pickerReport = await measurePicker(window, socketPath);

  // Last, because it closes the window and then quits. Everything above needs a
  // live page.
  const residencyReport = await measureResidency(window, socketPath);

  process.stdout.write(
    `SMOKE_REPORT ${JSON.stringify({
      ...probe,
      picker: pickerReport,
      residency: residencyReport,
      windowCount,
      title,
      shownOnReadyToShow,
    })}\n`,
  );

  app.exit(0);
}

/**
 * A real `BrowserWindow`, presented as the five things the picker host uses.
 *
 * Lifted out of `whenReady` because the complexity gate scored that function at
 * a CRAP of 42 against a bound of 30 once the adapter had grown — the same
 * thing that happened to `measureResidency` and `measurePicker`, and the same
 * seam: adapting one object to one interface is its own step.
 *
 * The adapter lives here rather than in `picker.ts` for the reason `window.ts`
 * gives: that module must stay free of a runtime Electron import so its
 * decisions are testable without a display.
 */
function pickerWindowFactory(transport: ElectronTransport, registry: Registry): OpenPickerWindow {
  return (command, title) => {
    const dialog = new BrowserWindow(pickerWindowOptions(title));
    // The same rule as the browse window: a dialog previews files too.
    refuseNavigationAwayFromApp(dialog.webContents);

    // Minted NOW, while the window is alive, and not inside the `closed`
    // handler where it is needed. Reading `dialog.webContents` after Electron
    // has destroyed the window THROWS, and a throw inside an event listener in
    // the main process takes the whole application down — which is exactly what
    // it did: the smoke launch hung and died with `Failed to shutdown`, having
    // written no report at all.
    const handle = transport.handleFor(dialog.webContents);

    // Registered before the load, so a page that sets its own `<title>` while
    // loading cannot win the race.
    //
    // It reads a MUTABLE `wanted` rather than closing over the constructor's
    // `title`. `enforceTitle` promises to keep the window called whatever it was
    // last told, and with the constructor value baked in here a later call would
    // be silently reverted by the next page title change — an interface
    // promising more than its implementation delivered. Review found it.
    let wanted = title;
    dialog.on("page-title-updated", (event) => {
      event.preventDefault();
      dialog.setTitle(wanted);
    });

    // Destroyed, not hidden. The residency interception in `createWindow`
    // deliberately does NOT apply here: a dialog that hid itself would keep a
    // caller blocked on a FIFO forever with nothing on screen to answer it.
    dialog.once("ready-to-show", () => dialog.show());

    // A renderer that dies takes its window with it, and Electron will not
    // close the window on its own — it raises this and leaves a live
    // `BrowserWindow` wrapped around a dead process. Destroying it here is what
    // turns a crash into an ordinary `closed`, which clears the picker slot and
    // returns the window's streams and watches.
    //
    // This is the realistic half of the "window dies without saying so" class.
    // The other half — the X window destroyed from outside — is NOT detectable:
    // measured, `isDestroyed()` stays false, because it reports Electron's own
    // state and Electron has not been told. No compositor does that (a close
    // button sends `xdg_toplevel.close` or `WM_DELETE_WINDOW`, both of which
    // raise `close` here), and the real bound on a picker nobody answers is the
    // FIFO write timeout in the next phase, not this listener.
    dialog.webContents.on("render-process-gone", () => {
      if (!dialog.isDestroyed()) dialog.destroy();
    });

    // The picker's own window URL, carrying the request itself.
    //
    // Three facts ride here and they are deliberately separate: the FRAGMENT is
    // where this window opens, the `home` query is where the tilde goes, and
    // the `picker` query is what kind of dialog this is. The renderer needs the
    // last one at FIRST RENDER — a window that painted as an ordinary browse
    // view and then turned into a dialog would be a visible flicker, and a
    // request across the bridge arrives a frame or two late by construction.
    const home = app.getPath("home");
    const opensAt = command.options.currentFolder === "" ? home : command.options.currentFolder;
    const request = { fifo: command.fifo, options: command.options };
    void dialog.loadURL(
      `${APP_ENTRY_URL}${homeQuery(home)}&${pickerQuery(request).slice(1)}#${encodeURIComponent(opensAt)}`,
    );

    /**
     * Give back what this window was holding, at most once.
     *
     * The registry is shared between windows now, so a window that has gone must
     * return its streams and its file watches. The browse window never reaches
     * this — it hides rather than closing — so the picker is the first thing
     * that ever needed it.
     *
     * **Called from two places on purpose**, and that is the fix for a confirmed
     * defect: it used to run only from the `closed` event, and when a window
     * dies WITHOUT that event — instrumented and observed: neither `close`, nor
     * `webContents` `destroyed`, nor `closed` fires after an `XDestroyWindow`,
     * and a renderer crash is the same class — the entry stayed in the
     * registry's strongly-keyed map with live watches in it, for the rest of the
     * daemon's life. The other caller is the stale-slot path in
     * `createPickerHost`.
     */
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      registry.disposeSender(handle);
    };

    return {
      enforceTitle: (next) => {
        wanted = next;
        dialog.setTitle(next);
      },
      onClosed: (listener) => {
        dialog.once("closed", () => {
          release();
          listener();
        });
      },
      // `destroy` and NOT `close`, because this is the host deciding rather than
      // asking. `close` runs the page's own unload lifecycle first, so a
      // `beforeunload` handler could delay or veto dismissing a dialog that a
      // calling application has already withdrawn — and it takes the same
      // `close` → `closed` route that is proven not to fire in every case.
      // `destroy` skips both and still raises `closed`. Review found it.
      close: () => {
        if (!dialog.isDestroyed()) dialog.destroy();
      },
      isGone: () => dialog.isDestroyed(),
      release,
    };
  };
}

/**
 * How long a picker may hold the slot, honouring the test override.
 *
 * Its own function because `whenReady` is measured by the complexity gate as
 * one unit, and four branches spent parsing an environment variable are four
 * branches the parts that matter cannot use.
 *
 * The override exists so the expiry can be exercised from outside without
 * waiting out the portal's five minutes — the same reason `SYMMETRIA_FM_SOCKET`
 * exists. That expiry IS the guarantee that a picker whose window vanished
 * undetectably still answers its caller, and a guarantee nobody can observe is
 * one nobody can check. Unset in normal use.
 */
function pickerLifetimeOptions(): PickerHostOptions {
  const overrideMs = Number.parseInt(process.env.SYMMETRIA_FM_PICKER_LIFETIME_MS ?? "", 10);
  return Number.isFinite(overrideMs) && overrideMs > 0 ? { lifetimeMs: overrideMs } : {};
}

/**
 * What the daemon does with a line that arrived on its socket.
 *
 * Three verbs, named rather than defaulted. The `open` arm reports the TRUTH
 * about delivery, which the first version did not: it answered `{ok:true}`
 * unconditionally and only sent the message when a window existed, so a caller
 * branching on the exit code — the portal backend does exactly this — was told
 * the path had opened when nothing had. Verification caught it.
 */
function socketCommandHandler(window: BrowserWindow, pickers: PickerHost): CommandHandler {
  return async (command) => {
    if (command.cmd === "createPicker") return pickers.create(command);
    if (command.cmd === "closePicker") return pickers.close(command);

    if (window.isDestroyed()) {
      return failure("write_failed", "the file manager has no window to open it in");
    }
    window.webContents.send(PUSH_CHANNELS.openPath, { path: command.path });
    return { ok: true, value: null };
  };
}

app.whenReady().then(async () => {
  handleAppScheme();

  // Once per session, and it must stay once: Electron allows a single
  // `onBeforeRequest` listener per session and a second call replaces the
  // first, so a duplicate here would silently discard this rule. It is the
  // load-bearing half of the navigation guard — the contents-level handler in
  // `createWindow` may never fire on a sandboxed renderer. See
  // `frameNavigation.ts`.
  refuseDocumentRequestsOffScheme(session.defaultSession);
  const { window, painted } = createWindow();

  // The renderer has no filesystem of its own, so this registry is the only
  // way it reaches one.
  //
  // The transport supplies BOTH halves now, and that replaced a real defect:
  // the sender used to be built here around this one window, so every push —
  // a listing batch, a directory change, transfer progress — went to it
  // whatever window had asked. With one window that was invisible. The picker
  // is the second window, and it would have watched its rows arrive on another
  // workspace.
  const transport = electronIpcSurface(ipcMain);
  const registry = createRegistry(
    transport.surface,
    // The host owns its own origin, so it is the host that turns a preview
    // token into a URL. The registry used to import this and that import was
    // the last line tying the privileged half to one particular application.
    { previewUrlFor },
  );

  // `dispose` was written and never called, which meant every filesystem watch
  // a session opened lived until the process exited. For an application whose
  // whole point is to stay resident, an uninvoked cleanup path is a leak with a
  // delay on it.
  //
  // Hung off `will-quit` alone. It used to also hang off the window's `closed`
  // event, which now never fires — the window is hidden rather than destroyed —
  // so leaving it there would have looked like cleanup that no longer ran.
  app.on("will-quit", () => {
    registry.dispose();
    // Every search worker dies with the application. A utility process that
    // outlives its owner is the failure that takes the resident daemon with
    // it, and nothing else in the tree would notice it had happened.
    closeAllSearchIndices();
  });
  app.on("before-quit", () => residency.beginQuit());

  // The socket is the authority on who is the daemon, and taking it is what
  // makes a second launch exit instead of opening a rival window.
  // Hiding the window is a HOST concern, so its handler is registered here
  // rather than in the IPC registry. The registry is the privileged filesystem
  // half and becomes an importable package; a window method in it would be the
  // one thing an embedding host could not satisfy.
  ipcMain.handle(REQUEST_CHANNELS.hideWindow, () => {
    if (!window.isDestroyed()) window.hide();
    return { ok: true, value: null };
  });

  const openPickerWindow = pickerWindowFactory(transport, registry);

  // The real writer. Every way out of a dialog ends in this call, because the
  // application that asked for a file is blocked reading that pipe.
  const pickers = createPickerHost(
    openPickerWindow,
    (fifo, payload) => writeToFifo(fifo, payload),
    pickerLifetimeOptions(),
  );

  /**
   * What the dialog's page says the user did.
   *
   * Decoded here rather than trusted. The picker window's renderer is sandboxed
   * and this is still a boundary: a payload that failed to decode must not
   * reach the FIFO writer, and `answer` itself refuses a FIFO that is not the
   * open one, so a page cannot answer somebody else's dialog either.
   */
  ipcMain.handle(REQUEST_CHANNELS.pickerConfirm, async (_event, payload: unknown) => {
    const request = decodePickerAnswer(payload);
    if (isFailure(request)) return request;
    return pickers.answer(request.value.fifo, request.value.paths);
  });

  ipcMain.handle(REQUEST_CHANNELS.pickerCancel, async (_event, payload: unknown) => {
    const request = decodePickerDismissal(payload);
    if (isFailure(request)) return request;
    return pickers.cancel(request.value.fifo);
  });

  const socketPath = daemonSocketPath();
  const claimed = await claimSocket(socketPath, socketCommandHandler(window, pickers));

  if (!claimed.ok) {
    // Another daemon already owns the path, so this process has nothing to do.
    // Exiting is the whole point of the check: two daemons would answer the
    // same socket and the user would get whichever won the race.
    process.stderr.write(`${claimed.error.message}\n`);
    app.exit(ALREADY_RUNNING);
    return;
  }
  app.on("will-quit", () => void claimed.value.close());

  if (SMOKE) {
    window.webContents.once("did-finish-load", () => {
      // Both events, not just the one that happens to fire first. See the
      // comment on `painted` in `createWindow`.
      void painted.then(() => reportAndQuit(window, socketPath));
    });
  }
});

// Deliberately empty, and NOT `app.quit()`.
//
// This is the residency half of D3. It is also nearly unreachable now: the
// window hides rather than closing, so nothing gets here except during a real
// quit, by which point `before-quit` has already run. Kept as a stated no-op so
// a future reader does not reinstate the quit on the grounds that nothing uses
// it — that line is exactly what made the daemon non-resident for three runs.
app.on("window-all-closed", () => {});
