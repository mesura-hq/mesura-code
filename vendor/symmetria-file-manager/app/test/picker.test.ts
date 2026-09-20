import { CANCELLED_SENTINEL, selectionPayload } from "@symmetria/fm-core/command";
import { describe, expect, it } from "vitest";
import {
  createPickerHost,
  DEFAULT_PICKER_LIFETIME_MS,
  type OpenPickerWindow,
  PICKER_TITLE_PREFIX,
  type PickerWindow,
  pickerWindowTitle,
} from "../src/main/picker.ts";

/**
 * One picker at a time, and a title the compositor can route by.
 *
 * The window itself is injected rather than constructed here, for the same
 * reason `buildWindowOptions` is a pure function: the decisions worth testing —
 * how many windows open, which request owns the open one, what the window is
 * called — must not need a display to check. The real window is exercised by
 * the smoke test, which launches Electron under a virtual display.
 */

const FIFO_A = "/tmp/symmetria-picker-aaaa.fifo";
const FIFO_B = "/tmp/symmetria-picker-bbbb.fifo";

const OPTIONS = {
  title: "Select a File",
  acceptLabel: "",
  multiple: false,
  directory: false,
  saveMode: false,
  suggestedName: "",
  currentFolder: "",
} as const;

function request(fifo: string, title = "Select a File") {
  return { cmd: "createPicker", fifo, options: { ...OPTIONS, title } } as const;
}

/** A window that records what was asked of it and can pretend the user closed it. */
function fakeWindow() {
  const enforced: string[] = [];
  let closedListener: (() => void) | null = null;
  let closeCalls = 0;
  let releases = 0;
  let gone = false;

  const window: PickerWindow = {
    enforceTitle: (title) => {
      enforced.push(title);
    },
    onClosed: (listener) => {
      closedListener = listener;
    },
    close: () => {
      closeCalls += 1;
    },
    isGone: () => gone,
    release: () => {
      releases += 1;
    },
  };

  return {
    window,
    enforced,
    closeCalls: () => closeCalls,
    releases: () => releases,
    /** What the real window does when it has really gone AND says so. */
    fireClosed: () => closedListener?.(),
    /**
     * What a window looks like once it is gone but its close event has not
     * arrived — a crashed renderer the host has just destroyed, or the gap
     * between a forced destroy and the `closed` that follows it.
     */
    dieSilently: () => {
      gone = true;
    },
  };
}

/**
 * A writer for the cases that are not about writing.
 *
 * The tests above the answer suite assert which windows open and which slot is
 * held; they need a writer only because a picker host without one could not
 * answer its caller, which is not optional. `writerSpy` is what the answer
 * suite uses when the payload is the point.
 */
const silentWriter = () => Promise.resolve({ ok: true as const, value: null });

/** A factory that hands out fresh fake windows and remembers every call. */
function factory() {
  const opened: { title: string; window: ReturnType<typeof fakeWindow> }[] = [];
  const open: OpenPickerWindow = (_command, title) => {
    const made = fakeWindow();
    opened.push({ title, window: made });
    return made.window;
  };
  return { open, opened };
}

describe("the picker window's title is a compositor contract", () => {
  it("always begins with the routing prefix, whatever the caller asked to call it", () => {
    // `~/.dotfiles/.config/hypr/windowrules.conf` routes this application to the
    // `files` workspace and EXCLUDES the picker by title, because Chromium sets
    // the Wayland app id once per process — every window of this daemon carries
    // the same class, so the title is the only discriminator there is. A picker
    // whose title misses the prefix is dragged onto the file manager's own
    // workspace, away from the application that asked for it.
    for (const asked of ["Save your download", "", "Choose a file", "Открыть файл"]) {
      expect(pickerWindowTitle(asked).startsWith(PICKER_TITLE_PREFIX), asked).toBe(true);
    }
  });

  it("still shows what the calling application asked to call it", () => {
    expect(pickerWindowTitle("Save your download")).toContain("Save your download");
  });

  it("does not repeat the prefix when the caller already used it", () => {
    expect(pickerWindowTitle("Choose a file")).toBe(PICKER_TITLE_PREFIX);
  });
});

describe("one picker at a time", () => {
  it("opens exactly one window for a create", () => {
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);

    const outcome = host.create(request(FIFO_A));

    expect(outcome.ok).toBe(true);
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]?.title.startsWith(PICKER_TITLE_PREFIX)).toBe(true);
  });

  it("gives the window its title at construction and re-asserts it afterwards", () => {
    // Two separate needs. The compositor reads the title when the window MAPS,
    // so it has to be in the constructor options; and Electron lets the page's
    // own `<title>` replace it later, which would break the rule after the fact.
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);

    host.create(request(FIFO_A));

    const made = f.opened[0];
    expect(made).toBeDefined();
    if (!made) return;
    expect(made.title.startsWith(PICKER_TITLE_PREFIX)).toBe(true);
    expect(made.window.enforced).toEqual([made.title]);
  });

  it("refuses a second create while one is open, and opens no window for it", () => {
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    const outcome = host.create(request(FIFO_B));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Distinguishable, because the portal backend branches on it: a busy
    // rejection has to be answerable on the new request's own FIFO, which a
    // generic failure could not be told apart from a broken daemon.
    expect(outcome.error.code).toBe("conflict");
    expect(f.opened).toHaveLength(1);
  });

  it("keeps the first picker open when it refuses the second", () => {
    // The rejection must not disturb the request that is legitimately in
    // progress — a user is looking at that window.
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    host.create(request(FIFO_B));

    expect(f.opened[0]?.window.closeCalls()).toBe(0);
    expect(host.openFifo()).toBe(FIFO_A);
  });

  it("accepts a new create once the open one has gone", () => {
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    f.opened[0]?.window.fireClosed();
    const outcome = host.create(request(FIFO_B));

    expect(outcome.ok).toBe(true);
    expect(f.opened).toHaveLength(2);
    expect(host.openFifo()).toBe(FIFO_B);
  });

  it("reports no open picker before the first create", () => {
    expect(createPickerHost(factory().open, silentWriter).openFifo()).toBe(null);
  });
});

describe("a picker window that is gone before its close event arrives", () => {
  /**
   * The defect verification found and instrumentation confirmed.
   *
   * The slot used to be cleared only by the window's close event, and that
   * event is not guaranteed to have arrived — a crashed renderer leaves a live
   * window around a dead process, and a forced destroy raises `closed`
   * asynchronously. The daemon then refused every later `createPicker` for the
   * rest of the process: on a machine where it runs for days, a file dialog
   * dead until the next login.
   */
  it("does not hold the slot forever", () => {
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    f.opened[0]?.window.dieSilently();
    const outcome = host.create(request(FIFO_B));

    expect(outcome.ok).toBe(true);
    expect(f.opened).toHaveLength(2);
    expect(host.openFifo()).toBe(FIFO_B);
  });

  it("gives back what that window was holding", () => {
    // The other half, and it is not cosmetic: the window's streams and file
    // watches live in the IPC registry under a STRONG key, so a slot cleared
    // without releasing trades one permanent leak for another. Review found
    // that the first version of this fix would have done exactly that.
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    f.opened[0]?.window.dieSilently();
    host.create(request(FIFO_B));

    expect(f.opened[0]?.window.releases()).toBe(1);
  });

  it("reports the slot as empty rather than naming a window nobody can see", () => {
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    f.opened[0]?.window.dieSilently();

    expect(host.openFifo()).toBe(null);
  });

  it("stops a close from reaching a window that has already gone", () => {
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    f.opened[0]?.window.dieSilently();
    host.close({ cmd: "closePicker", fifo: FIFO_A });

    expect(f.opened[0]?.window.closeCalls()).toBe(0);
  });
});

describe("closing a picker", () => {
  it("closes the window when the fifo names the open picker", () => {
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    const outcome = host.close({ cmd: "closePicker", fifo: FIFO_A });

    expect(outcome.ok).toBe(true);
    expect(f.opened[0]?.window.closeCalls()).toBe(1);
  });

  it("does nothing when the fifo names a different request", () => {
    // The portal sends this when the CALLING application withdraws or dies, and
    // by then the picker it meant may already have been answered and replaced.
    // Honouring it blindly would close a dialog a different application is
    // waiting on. The Qt daemon compares the fifo for exactly this reason.
    const f = factory();
    const host = createPickerHost(f.open, silentWriter);
    host.create(request(FIFO_A));

    const outcome = host.close({ cmd: "closePicker", fifo: FIFO_B });

    expect(outcome.ok).toBe(true);
    expect(f.opened[0]?.window.closeCalls()).toBe(0);
    expect(host.openFifo()).toBe(FIFO_A);
  });

  it("is harmless when no picker is open", () => {
    const host = createPickerHost(factory().open, silentWriter);

    expect(host.close({ cmd: "closePicker", fifo: FIFO_A }).ok).toBe(true);
  });
});

/**
 * Answering the caller, and the guarantee that SOMETHING always does.
 *
 * A picker exists because an application is blocked on a named pipe. Every way
 * out of the dialog therefore has to write to it: the user choosing, the user
 * cancelling, the window closing, a `closePicker` arriving, and a request being
 * turned away because another dialog is already up. A path that returns without
 * writing leaves the calling application frozen until the portal's five-minute
 * timeout.
 *
 * The writer is injected for the same reason the window is: what belongs here is
 * WHICH payload goes to WHICH pipe and whether it goes exactly once. Whether the
 * bytes reach a real FIFO is `fifo.test.ts`'s question.
 */
function writerSpy() {
  const writes: { fifo: string; payload: string }[] = [];
  return {
    writes,
    write: (fifo: string, payload: string) => {
      writes.push({ fifo, payload });
      return Promise.resolve({ ok: true as const, value: null });
    },
    /** Only what was written to this pipe. */
    to: (fifo: string) => writes.filter((each) => each.fifo === fifo).map((each) => each.payload),
  };
}

describe("every way out of a picker answers its caller", () => {
  it("writes the chosen paths and dismisses the dialog", async () => {
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    const outcome = await host.answer(FIFO_A, ["/home/jc/one.txt", "/home/jc/two.txt"]);

    expect(outcome.ok).toBe(true);
    expect(w.to(FIFO_A)).toEqual(["/home/jc/one.txt\n/home/jc/two.txt"]);
    expect(f.opened[0]?.window.closeCalls()).toBe(1);
  });

  it("writes the sentinel when the user cancels", async () => {
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    await host.cancel(FIFO_A);

    expect(w.to(FIFO_A)).toEqual([CANCELLED_SENTINEL]);
    expect(f.opened[0]?.window.closeCalls()).toBe(1);
  });

  it("writes the sentinel when the window closes with nothing chosen", async () => {
    // The compositor's close button, or the user pressing Escape. Nothing has
    // been chosen and the caller is still waiting, so silence here is the worst
    // outcome available.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    f.opened[0]?.window.fireClosed();
    await Promise.resolve();

    expect(w.to(FIFO_A)).toEqual([CANCELLED_SENTINEL]);
  });

  it("does not answer twice when the window closes after an answer", async () => {
    // Answering dismisses the dialog, so the close arrives immediately behind
    // the write. The reader takes the FIRST thing it gets, so a sentinel
    // chasing a real answer would turn a chosen file into a cancellation.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    await host.answer(FIFO_A, ["/home/jc/one.txt"]);
    f.opened[0]?.window.fireClosed();
    await Promise.resolve();

    expect(w.to(FIFO_A)).toEqual(["/home/jc/one.txt"]);
  });

  it("answers a request it turns away, on that request's own pipe", async () => {
    // The busy rejection. Without it the second caller waits five minutes for a
    // dialog that was never going to open — and the refusal reply on the socket
    // does not reach it, because it is blocked on the pipe rather than reading
    // an exit code.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    const outcome = host.create(request(FIFO_B));
    await Promise.resolve();

    expect(outcome.ok).toBe(false);
    expect(w.to(FIFO_B)).toEqual([CANCELLED_SENTINEL]);
  });

  it("leaves the open dialog untouched when it turns a request away", async () => {
    // The Qt build needed a SEPARATE writer for this, because its cancel writer
    // closed the active window when it finished — which is exactly what a busy
    // rejection must not do. A user is looking at that window.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    host.create(request(FIFO_B));
    await Promise.resolve();

    expect(w.to(FIFO_A)).toEqual([]);
    expect(f.opened[0]?.window.closeCalls()).toBe(0);
    expect(host.openFifo()).toBe(FIFO_A);
  });

  it("answers the caller when a closePicker dismisses the dialog", async () => {
    // The portal sends this when the calling application dies. It is still
    // waiting on the pipe until something writes, and unlinking the FIFO is the
    // portal's job rather than ours.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    host.close({ cmd: "closePicker", fifo: FIFO_A });
    await Promise.resolve();

    expect(w.to(FIFO_A)).toEqual([CANCELLED_SENTINEL]);
  });

  it("dismisses the dialog even when the write fails", async () => {
    // A pipe nobody is reading, or one that has gone. The answer cannot be
    // delivered, and leaving the dialog on screen would strand a window with no
    // caller behind it — on a resident daemon, for good.
    const f = factory();
    const host = createPickerHost(f.open, () =>
      Promise.resolve({
        ok: false as const,
        error: { code: "write_failed" as const, message: "gone" },
      }),
    );
    host.create(request(FIFO_A));

    const outcome = await host.answer(FIFO_A, ["/home/jc/one.txt"]);

    expect(outcome.ok).toBe(false);
    expect(f.opened[0]?.window.closeCalls()).toBe(1);
  });

  it("ignores an answer naming a pipe that is not the open one", async () => {
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    const outcome = await host.answer(FIFO_B, ["/home/jc/one.txt"]);

    expect(outcome.ok).toBe(false);
    expect(w.writes).toEqual([]);
    expect(f.opened[0]?.window.closeCalls()).toBe(0);
  });
});

/**
 * The guarantee, for the routes nothing else can see.
 *
 * Verification found that a window whose X surface is destroyed from outside
 * the process raises NOTHING that Electron can observe — `isDestroyed()` stays
 * false — so the caller was never answered and the daemon refused every later
 * dialog for the rest of its life. The comment in the source claimed the FIFO
 * write timeout bounded that; it did not, because on that path no write is ever
 * attempted. This timer is what makes the claim true.
 *
 * The bound is the PORTAL's own patience, not an opinion about how long a user
 * may take: once the caller has given up reading, the dialog on screen can no
 * longer deliver anything to anyone, so dismissing it costs nothing.
 */
describe("a picker that outlives the caller waiting for it", () => {
  /** A schedule that fires nothing until the test says so. */
  function manualSchedule() {
    const armed: { run: () => void; afterMs: number; cancelled: boolean }[] = [];
    const schedule = (run: () => void, afterMs: number) => {
      const entry = { run, afterMs, cancelled: false };
      armed.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    return {
      schedule,
      armed,
      fireAll: () => {
        for (const entry of armed) if (!entry.cancelled) entry.run();
      },
    };
  }

  it("arms an expiry longer than the portal's own timeout", () => {
    // The portal gives up at 300 s (`FIFO_TIMEOUT_SECONDS`). Expiring sooner
    // would dismiss a dialog whose answer the caller would still have accepted.
    const f = factory();
    const s = manualSchedule();
    createPickerHost(f.open, silentWriter, { schedule: s.schedule }).create(request(FIFO_A));

    expect(s.armed).toHaveLength(1);
    expect(s.armed[0]?.afterMs).toBeGreaterThan(300_000);
  });

  it("answers the caller and frees the slot when it expires", () => {
    const f = factory();
    const w = writerSpy();
    const s = manualSchedule();
    const host = createPickerHost(f.open, w.write, { schedule: s.schedule });
    host.create(request(FIFO_A));

    s.fireAll();

    expect(w.to(FIFO_A)).toEqual([CANCELLED_SENTINEL]);
    expect(f.opened[0]?.window.closeCalls()).toBe(1);
    expect(f.opened[0]?.window.releases()).toBe(1);
    expect(host.openFifo()).toBe(null);
  });

  it("lets the next request through afterwards", () => {
    // The whole point. Before this, a window that vanished silently left the
    // daemon unable to open any dialog until the next login.
    const f = factory();
    const s = manualSchedule();
    const host = createPickerHost(f.open, silentWriter, { schedule: s.schedule });
    host.create(request(FIFO_A));

    s.fireAll();

    expect(host.create(request(FIFO_B)).ok).toBe(true);
  });

  it("calls the expiry off once the caller has been answered", () => {
    // Otherwise the timer fires minutes later against a slot a newer request
    // owns, and closes a dialog somebody is looking at.
    const f = factory();
    const s = manualSchedule();
    const host = createPickerHost(f.open, silentWriter, { schedule: s.schedule });
    host.create(request(FIFO_A));

    host.close({ cmd: "closePicker", fifo: FIFO_A });

    expect(s.armed[0]?.cancelled).toBe(true);
  });

  it("does not answer twice when it expires after an answer", async () => {
    const f = factory();
    const w = writerSpy();
    const s = manualSchedule();
    const host = createPickerHost(f.open, w.write, { schedule: s.schedule });
    host.create(request(FIFO_A));

    await host.answer(FIFO_A, ["/home/jc/one.txt"]);
    s.fireAll();

    // The reader takes the first thing it gets, so a sentinel arriving behind a
    // real answer would turn a chosen file into a cancellation.
    expect(w.to(FIFO_A)).toEqual(["/home/jc/one.txt"]);
  });
});

describe("a window that goes without saying so still answers its caller", () => {
  it("writes the sentinel when the slot is dropped as stale", async () => {
    // The half the first fix missed: clearing the slot solved the daemon's
    // problem and left the other application blocked on a pipe nobody would
    // ever write to.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    f.opened[0]?.window.dieSilently();
    host.create(request(FIFO_B));
    await Promise.resolve();

    expect(w.to(FIFO_A)).toEqual([CANCELLED_SENTINEL]);
  });
});

describe("a request that names the open picker's own pipe", () => {
  it("is refused without writing anything to it", async () => {
    // The injection review found. `/tmp` is world-writable and any local
    // process may send a `createPicker` for any path under the picker prefix,
    // so a request naming the LIVE dialog's FIFO would have had the busy
    // rejection write a cancellation into the very pipe the user was about to
    // answer — racing the real answer on the same stream, and cancelling
    // somebody's save dialog from outside the application.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    const outcome = host.create(request(FIFO_A));
    await Promise.resolve();

    expect(outcome.ok).toBe(false);
    expect(w.to(FIFO_A)).toEqual([]);
    expect(host.openFifo()).toBe(FIFO_A);
    expect(f.opened).toHaveLength(1);
  });

  it("still answers a request naming a different pipe", async () => {
    // The narrowing must not cost the busy rejection its whole reason for
    // existing: an unrelated second caller is blocked and still needs telling.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    host.create(request(FIFO_B));
    await Promise.resolve();

    expect(w.to(FIFO_B)).toEqual([CANCELLED_SENTINEL]);
  });
});

describe("a path the wire format cannot carry", () => {
  it("is refused rather than silently split in two", async () => {
    // A Linux filename may contain a newline, and the payload is
    // newline-delimited — the same format the Qt build writes and the same one
    // the portal parses, so it cannot change. Such a path would arrive as two
    // bogus paths: a silent corruption of the one thing this phase delivers.
    const f = factory();
    const w = writerSpy();
    const host = createPickerHost(f.open, w.write);
    host.create(request(FIFO_A));

    const outcome = await host.answer(FIFO_A, ["/home/jc/two\nlines.txt"]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_request");
    expect(w.writes).toEqual([]);
  });

  it("lets an ordinary path through unchanged", () => {
    expect(selectionPayload(["/home/jc/one.txt", "/home/jc/two.txt"])).toBe(
      "/home/jc/one.txt\n/home/jc/two.txt",
    );
  });
});

describe("the default picker lifetime", () => {
  it("is the one used when the host is built with no options", () => {
    // Every other expiry test supplies its own lifetime, so nothing pinned the
    // real constant — a change of magnitude or of unit, seconds for
    // milliseconds, would have gone unnoticed. It is the sole guarantee against
    // a permanently stuck slot on a daemon that runs for days.
    const f = factory();
    const armed: number[] = [];
    createPickerHost(f.open, silentWriter, {
      // Observed rather than fired: substituting the schedule is the only way
      // to read the default, and firing it would test the expiry rather than
      // the number.
      schedule: (_run, afterMs) => {
        armed.push(afterMs);
        return () => undefined;
      },
    }).create(request(FIFO_A));

    expect(armed).toEqual([DEFAULT_PICKER_LIFETIME_MS]);
    // Past the portal's own 300 s, which is the whole justification for the
    // value: expiring sooner would dismiss a dialog whose answer the caller
    // would still have taken.
    expect(DEFAULT_PICKER_LIFETIME_MS).toBeGreaterThan(300_000);
  });
});
