import {
  CANCELLED_SENTINEL,
  type ClosePickerCommand,
  type CreatePickerCommand,
  selectionPayload,
} from "@symmetria/fm-core/command";
import { failure, type Result, success } from "@symmetria/fm-core/contract";
import type { BrowserWindowConstructorOptions } from "electron";

import { buildWindowOptions } from "./window.ts";

/**
 * One picker window at a time, and a title the compositor can route by.
 *
 * **No runtime Electron import**, on purpose and following `window.ts`: the
 * decisions worth testing — how many windows open, which request owns the open
 * one, what the window is called — must be checkable without a display. The
 * real `BrowserWindow` is adapted to `PickerWindow` in `index.ts`, and the smoke
 * test exercises that adapter in a launched process.
 */

/**
 * What every picker window's title must begin with.
 *
 * **This is a contract with the operator's compositor, not a label.** The rule
 * in `~/.dotfiles/.config/hypr/windowrules.conf` sends this application's
 * windows to the `files` workspace and excludes the picker BY TITLE:
 *
 *   windowrule = workspace name:files silent,
 *                match:class ^(symmetria-fm-electron)$,
 *                match:title negative:^(Choose a file.*)$
 *
 * It has to be the title because Chromium sets the Wayland app id once per
 * PROCESS, from the desktop name, so a dialog cannot have an id of its own —
 * every window of this daemon carries the same class. Change this string and
 * every save dialog is dragged onto the file manager's workspace, away from the
 * application that asked for it. Change it in the dotfiles at the same time or
 * not at all.
 */
export const PICKER_TITLE_PREFIX = "Choose a file";

/**
 * The window title for a request, keeping the caller's own words after the
 * prefix so the window list still says which dialog this is.
 */
export function pickerWindowTitle(requested: string): string {
  const asked = requested.trim();
  if (asked === "") return PICKER_TITLE_PREFIX;
  if (asked.startsWith(PICKER_TITLE_PREFIX)) return asked;
  return `${PICKER_TITLE_PREFIX} — ${asked}`;
}

/**
 * A picker window, as the host must present one.
 *
 * Deliberately three methods and no more. Anything else this file could ask for
 * would be something a test double has to imitate for no gain.
 */
export interface PickerWindow {
  /**
   * Keep the window called this, whatever the page does.
   *
   * Electron lets a page's `<title>` element replace the window title after the
   * fact. The compositor reads the title when the window MAPS — which is why it
   * is also in the constructor options — but a human reading a window list
   * always sees the later one, and a compositor that re-evaluates on a title
   * change would too.
   */
  enforceTitle(title: string): void;
  /** Called when the window has really gone, however it went. */
  onClosed(listener: () => void): void;
  close(): void;
  /**
   * Has the underlying window already gone?
   *
   * Asked rather than only waited for, because the close event can arrive after
   * the next request does: between a forced destroy and the `closed` that
   * follows it, a `createPicker` would otherwise be refused on behalf of a
   * window that no longer exists.
   *
   * **It does not catch every death, and the limit is worth stating.** Measured
   * twice: when a window's X surface is destroyed from outside the process,
   * Electron raises nothing and `isDestroyed()` stays false, because it reports
   * Electron's own state rather than the compositor's.
   *
   * Two things narrow that in practice. A real close button sends
   * `xdg_toplevel.close` or `WM_DELETE_WINDOW` — verified to raise the close
   * event and deliver the sentinel — and a crashed renderer is turned into an
   * ordinary close by the host's `render-process-gone` handler.
   *
   * The GUARANTEE, though, is neither of those and it is not this method: it is
   * the per-picker expiry armed in `createPickerHost`. An earlier version of
   * this comment named the FIFO write timeout instead, and verification found
   * that false — on the undetectable path no write is ever attempted, so
   * nothing bounded it at all.
   */
  isGone(): boolean;
  /**
   * Give back whatever the window was holding. Must be idempotent: the close
   * event and the stale-slot path both call it, and either may come first.
   */
  release(): void;
}

export type OpenPickerWindow = (command: CreatePickerCommand, title: string) => PickerWindow;

/**
 * Put one answer on one pipe.
 *
 * Injected for the same reason the window is. What belongs in this file is
 * WHICH payload goes to WHICH pipe and whether it goes exactly once; whether
 * the bytes reach a real FIFO is `fifo.ts`'s question, and it needs `node:fs`
 * to answer it.
 */
export type WriteAnswer = (fifo: string, payload: string) => Promise<Result<null>>;

/**
 * Run something later, and hand back a way to call it off.
 *
 * Not exported: a caller supplying a `schedule` writes an inline function and
 * TypeScript infers this from `PickerHostOptions`. Exporting it made it dead
 * public surface, which `knip` reported.
 */
type Schedule = (run: () => void, afterMs: number) => () => void;

/**
 * How long a picker may hold the slot before it is answered and dismissed.
 *
 * Slightly longer than the portal's own `FIFO_TIMEOUT_SECONDS`, which is 300.
 * That number is the whole justification: once the caller has given up, the
 * dialog on screen can no longer deliver anything to anybody, so closing it
 * costs the user nothing and frees the slot for the next request.
 *
 * **This is the guarantee the rest of the file leans on.** A window can go away
 * without Electron raising a close event, and one route — an X surface
 * destroyed from outside the process — is not detectable at all: measured, and
 * measured twice. Without this timer that leaves a caller unanswered forever AND
 * the daemon refusing every later dialog. An earlier version of the comment on
 * `isGone` claimed the FIFO write timeout was that bound; verification found the
 * claim false, because on that path no write is ever attempted. This is what
 * makes the claim true.
 */
export const DEFAULT_PICKER_LIFETIME_MS = 305_000;

export interface PickerHostOptions {
  readonly lifetimeMs?: number;
  readonly schedule?: Schedule;
}

/**
 * The real timer, unreferenced so an open dialog cannot by itself keep the
 * process alive at shutdown.
 */
const realSchedule: Schedule = (run, afterMs) => {
  const timer = setTimeout(run, afterMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface PickerHost {
  /** Open a picker, or refuse because one is already up. */
  create(command: CreatePickerCommand): Result<null>;
  /** Dismiss the picker answering this FIFO, if it is the one that is open. */
  close(command: ClosePickerCommand): Result<null>;
  /** The user chose. Answer the caller, then dismiss the dialog. */
  answer(fifo: string, paths: readonly string[]): Promise<Result<null>>;
  /** The user cancelled. Answer the caller with the sentinel, then dismiss. */
  cancel(fifo: string): Promise<Result<null>>;
  /**
   * The FIFO the open picker is answering, or null when none is open.
   *
   * The slot has no other observable, and that is what this is for: whether a
   * stale slot was cleared is otherwise indistinguishable from a slot that was
   * never taken. The same reasoning put `trackedWindows` on the IPC registry.
   */
  openFifo(): string | null;
}

/**
 * The options a picker window is constructed with.
 *
 * Built ON `buildWindowOptions` rather than beside it, so the sandbox posture
 * cannot drift between the two windows this application opens. Only the size
 * and the title differ — a dialog is smaller than a file manager, and the title
 * has to be present at construction because that is when the compositor reads
 * it.
 */
export function pickerWindowOptions(title: string): BrowserWindowConstructorOptions {
  return { ...buildWindowOptions(), width: 900, height: 600, title };
}

/** The open picker, and whether its caller has already been told something. */
interface OpenPicker {
  readonly fifo: string;
  readonly window: PickerWindow;
  answered: boolean;
  /** Call off this picker's expiry. */
  readonly cancelExpiry: () => void;
}

export function createPickerHost(
  open: OpenPickerWindow,
  write: WriteAnswer,
  options: PickerHostOptions = {},
): PickerHost {
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_PICKER_LIFETIME_MS;
  const schedule = options.schedule ?? realSchedule;

  let current: OpenPicker | null = null;

  /**
   * Say something to this picker's caller, at most once.
   *
   * **Exactly once is the whole contract.** The reader takes the first thing it
   * gets, so a sentinel chasing a real answer turns a chosen file into a
   * cancellation — and answering dismisses the dialog, so the window's close
   * event arrives immediately behind every successful answer. Nothing arriving
   * at all is the other failure, and it is worse: the calling application stays
   * frozen until the portal's five-minute timeout.
   */
  function deliver(slot: OpenPicker, payload: string): Promise<Result<null>> {
    if (slot.answered) return Promise.resolve(success(null));
    slot.answered = true;
    slot.cancelExpiry();
    return write(slot.fifo, payload);
  }

  /**
   * The picker has outlived the caller that was waiting for it.
   *
   * Answering here is very nearly a no-op by design — the portal gave up
   * already, so nothing is reading — and that is fine. What this exists for is
   * the slot and the window: a dialog nobody can answer must not sit there
   * holding the daemon's only picker slot for the rest of a process that runs
   * for days.
   */
  function expire(slot: OpenPicker): void {
    if (current?.window === slot.window) current = null;
    void deliver(slot, CANCELLED_SENTINEL);
    slot.window.close();
    slot.window.release();
  }

  /**
   * Answer and dismiss, for the two things a user can do.
   *
   * The dialog is closed even when the write FAILED — a pipe nobody is reading,
   * or one that has gone. The answer cannot be delivered either way, and leaving
   * the window up would strand it with no caller behind it, which on a resident
   * daemon means for good.
   */
  async function settle(fifo: string, payload: string): Promise<Result<null>> {
    dropIfGone();
    if (current === null || current.fifo !== fifo) {
      return failure("invalid_request", `no picker is answering ${fifo}`);
    }

    const slot = current;
    // Started, then the window goes, then the outcome is awaited. Closing
    // BEHIND the write meant a stalled reader kept the dialog on screen for the
    // writer's full ten seconds after the user had clicked — while `expire`
    // closed immediately, so the two dismissal paths disagreed. `deliver` marks
    // the slot answered synchronously, so the close cannot race it into a
    // second answer.
    const writing = deliver(slot, payload);
    slot.window.close();
    return await writing;
  }

  /**
   * Drop the slot when the window in it has already gone.
   *
   * **Not defensive habit.** The slot used to be cleared only by the window's
   * close event, and that event is not guaranteed: a renderer that crashes
   * leaves a live `BrowserWindow` around a dead process until the host destroys
   * it, and between a forced destroy and its `closed` there is a window in which
   * the slot names something that no longer exists. Either way the daemon would
   * refuse every later `createPicker` for the rest of the process — on a machine
   * where this runs for days, a file dialog dead until the next login.
   *
   * The release matters as much as the slot: the window's streams and file
   * watches are held in the IPC registry under a strong key, so a slot cleared
   * without releasing would trade one permanent leak for another. Review found
   * that the first version of this did exactly that.
   *
   * It is a safety net and not a guarantee — see `isGone` for what it cannot
   * see. The guarantee is the per-picker EXPIRY armed in `createPickerHost`.
   * This comment used to name the FIFO write timeout instead; verification
   * found that false, because on the undetectable path no write is attempted.
   */
  function dropIfGone(): void {
    if (current === null || !current.window.isGone()) return;
    const slot = current;
    current = null;
    // The window went, but the CALLER did not: it is still blocked reading. An
    // earlier version cleared the slot and said nothing, which fixed the
    // daemon's own problem and left the other application's.
    void deliver(slot, CANCELLED_SENTINEL);
    slot.window.release();
  }

  return {
    create(command) {
      dropIfGone();

      if (current !== null) {
        // **A request naming the OPEN picker's own pipe is refused in silence,
        // and this is a security fix rather than a tidy-up.** `/tmp` is
        // world-writable and any local process may send a `createPicker` for any
        // path under the picker prefix, so without this check one could name the
        // live dialog's FIFO and have the busy rejection below write a
        // cancellation into the very pipe the user is about to answer — racing
        // the real answer on the same stream, and cancelling somebody's save
        // dialog from outside. There is no legitimate caller for this: a process
        // that already owns that pipe is the one being answered on it.
        if (command.fifo === current.fifo) {
          return failure("conflict", `a picker is already open for ${current.fifo}`);
        }

        // ANSWERED, not merely refused. The rejected caller is blocked reading
        // its own pipe and is not looking at an exit code, so the socket reply
        // reaches nobody — without this write it waits out the portal's five
        // minutes for a dialog that was never going to open.
        //
        // It goes to the NEW request's pipe and touches nothing else. The Qt
        // build needed a whole separate writer to get this right, because its
        // cancel writer closed the active window when it finished, which is
        // exactly what a busy rejection must not do: a user is looking at that
        // window.
        void write(command.fifo, CANCELLED_SENTINEL);
        return failure("conflict", `a picker is already open for ${current.fifo}`);
      }

      const title = pickerWindowTitle(command.options.title);
      const window = open(command, title);
      const slot: OpenPicker = {
        fifo: command.fifo,
        window,
        answered: false,
        cancelExpiry: () => cancel(),
      };
      // Armed before anything can go wrong with the window, so a picker is
      // bounded from the moment it exists rather than from the moment it
      // finishes opening.
      const cancel = schedule(() => expire(slot), lifetimeMs);
      current = slot;

      window.enforceTitle(title);
      // Whatever closes it — the user, the compositor's close button, a
      // `closePicker`, or the answer being written — one path clears the slot
      // AND makes sure the caller was told something. The identity check
      // matters because a slow close could otherwise clear a slot a later
      // request has already taken.
      window.onClosed(() => {
        if (current?.window !== window) return;
        const slot = current;
        current = null;
        // The window went with nothing chosen: the compositor's close button,
        // or Escape. Silence here is the worst outcome available, so the
        // sentinel goes out. After a real answer `deliver` makes this a no-op.
        void deliver(slot, CANCELLED_SENTINEL);
      });

      return success(null);
    },

    close(command) {
      dropIfGone();
      if (current !== null && current.fifo === command.fifo) {
        const slot = current;
        // The portal sends this when the CALLING application dies — but a
        // reader may still be blocked on the pipe, and unlinking it is the
        // portal's job rather than ours. Answering costs nothing when nobody
        // is listening and prevents a hang when somebody is.
        void deliver(slot, CANCELLED_SENTINEL);
        slot.window.close();
      }
      // Success either way. A close for a picker that has already gone is the
      // ordinary case — the portal sends it when the calling application dies,
      // which often happens after the user has already answered — and reporting
      // it as a failure would make a normal sequence look broken.
      return success(null);
    },

    answer: (fifo, paths) => {
      // The wire format is newline-delimited, and a Linux filename may contain
      // a newline. Such a path would reach the portal as two bogus paths — a
      // silent corruption of the one thing this whole phase exists to deliver
      // — so it is refused loudly instead. The format itself cannot change:
      // the same portal backend serves the Qt build, which writes it too.
      const untransmittable = paths.find((path) => path.includes("\n"));
      if (untransmittable !== undefined) {
        return Promise.resolve(
          failure(
            "invalid_request",
            `a path containing a newline cannot be returned: ${untransmittable}`,
          ),
        );
      }
      return settle(fifo, selectionPayload(paths));
    },

    cancel: (fifo) => settle(fifo, CANCELLED_SENTINEL),

    openFifo: () => {
      dropIfGone();
      return current?.fifo ?? null;
    },
  };
}
