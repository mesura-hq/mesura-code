import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The desktop integration: the entry, the unit, and the fragment.
 *
 * Acceptance criteria 1 to 4, 6 and 7 of phase 2.
 *
 * **This phase is declared non-exercisable and this file is why the
 * declaration is narrow.** A Hyprland window rule cannot be driven from outside
 * without reloading the operator's live compositor, so nothing here launches
 * anything. What CAN be checked is checked: three identifier strings that must
 * agree, a unit file systemd itself will parse, and the shape of the fragment.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string) => readFileSync(`${repoRoot}${relative}`, "utf8");

/**
 * The one identifier, written once.
 *
 * It was four independent string literals, which satisfied the criterion only
 * because all four happened to agree — the point of the criterion is that they
 * cannot drift, and four literals is exactly the shape that drifts.
 */
const IDENTIFIER = "symmetria-fm-electron";
const ENTRY = `${IDENTIFIER}.desktop`;
const UNIT = `${IDENTIFIER}.service`;

/** One `Key=value` from a desktop entry or a unit file. */
function iniValue(source: string, key: string): string | null {
  const line = source.split("\n").find((l) => l.trimStart().startsWith(`${key}=`));
  return line === undefined ? null : line.slice(line.indexOf("=") + 1).trim();
}

describe("the desktop entry", () => {
  it("exists", () => {
    expect(existsSync(`${repoRoot}${ENTRY}`)).toBe(true);
  });

  it("has the basename the application manifest declares", () => {
    // Electron 41 has no `app.setDesktopName()`. It reads the Linux
    // desktop-entry name from `desktopName` in package.json, so THAT field and
    // this filename are the same fact written twice — and drift between them
    // breaks the portal's app-info lookup with an error nobody reads.
    const manifest = JSON.parse(read("app/package.json"));

    expect(manifest.desktopName).toBe(ENTRY);
  });

  it("declares the same identifier as its window class hint", () => {
    const entry = read(ENTRY);

    expect(iniValue(entry, "StartupWMClass")).toBe(IDENTIFIER);
  });

  it("is NOT the Qt build's identifier", () => {
    // The two applications run side by side until the rewrite reaches parity,
    // and the operator uses the Qt one every day. Sharing an identifier would
    // make a compositor rule for one of them match the other.
    const entry = read(ENTRY);

    expect(iniValue(entry, "StartupWMClass")).not.toBe("symmetria-fm");
    expect(existsSync(`${repoRoot}symmetria-fm.desktop`)).toBe(true);
  });

  it("names a command-line tool the shell can actually run", () => {
    // The entry's `Exec` runs the tool by name, so the executable bit is part
    // of the contract rather than a detail. It was NOT set: the file was
    // created by a tool that does not set it, every test invoked it as an
    // argument to `node`, and the gap only appeared when the install linked it
    // onto PATH and the shell refused it. Nothing before that point could have
    // noticed.
    const cli = `${repoRoot}app/bin/symmetria-fm-electron-cli.mjs`;

    expect(lstatSync(cli).mode & 0o111).not.toBe(0);
    expect(readFileSync(cli, "utf8").startsWith("#!")).toBe(true);
  });

  it("launches through the command-line tool, so it reaches the running daemon", () => {
    // Launching the binary directly would start a second process that exits
    // immediately, because the socket is already claimed. The point of a
    // resident daemon is that opening a folder reaches the one already running.
    const entry = read(ENTRY);

    expect(iniValue(entry, "Exec")).toContain("symmetria-fm-electron-cli");
    expect(iniValue(entry, "MimeType")).toContain("inode/directory");
  });
});

describe("the systemd user unit", () => {
  it("exists in this repository", () => {
    expect(existsSync(`${repoRoot}${UNIT}`)).toBe(true);
  });

  it("strips the stale Hyprland workspace token before exec", () => {
    // NOT boilerplate. Hyprland reads this token from /proc/<pid>/environ, so
    // an in-process unset is too late: the daemon's first window after login
    // lands on whatever workspace was active at login instead of its own. The
    // Qt unit carries the same line for the same measured reason.
    const unit = read(UNIT);

    expect(iniValue(unit, "UnsetEnvironment")).toBe("HL_INITIAL_WORKSPACE_TOKEN");
  });

  it("waits for a graphical session, because the daemon paints at start", () => {
    // The Qt daemon can use `default.target` safely: it opens no window until
    // asked. This one shows a window as soon as it starts, so it needs the
    // Wayland socket immediately — and a unit that starts before the session
    // either dies in a restart loop or serves windows nobody can see.
    const unit = read(UNIT);

    expect(iniValue(unit, "After")).toContain("graphical-session.target");
    expect(iniValue(unit, "PartOf")).toContain("graphical-session.target");
    expect(iniValue(unit, "WantedBy")).toContain("graphical-session.target");
  });

  it("parses as a unit file, according to systemd itself", () => {
    // Reading keys back proves the strings are there; only systemd can say the
    // file is a unit. A typo in a directive name is silently ignored at boot.
    const out = execFileSync("systemd-analyze", ["verify", "--user", `${repoRoot}${UNIT}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(out).not.toMatch(/Unknown (key|section)/i);
  });

  it("refuses to retry only the failures retrying cannot fix", () => {
    // Both directives exist because of one live incident, and neither had a
    // test until review pointed that out. The first version said `1`, which was
    // WORSE than the loop it fixed: Node exits 1 for an uncaught exception and
    // the launcher exits 1 on a failed build, so it also told systemd to stop
    // restarting after a real crash. The codes here must stay specific.
    const unit = read(UNIT);
    const prevented = (iniValue(unit, "RestartPreventExitStatus") ?? "").split(/\s+/);

    expect(prevented).toContain("69"); // another daemon holds the socket
    expect(prevented).toContain("78"); // the application directory is gone
    expect(prevented).not.toContain("1"); // a crash, and a failed build, must retry
    expect(iniValue(unit, "Restart")).toBe("always");
  });

  it("uses those codes, rather than only declaring them", () => {
    // A code the unit names and the program never produces protects nothing.
    const daemon = read("app/src/main/index.ts");
    const launcher = read(`bin/${IDENTIFIER}`);

    expect(daemon).toMatch(/const ALREADY_RUNNING = 69/);
    expect(daemon).toMatch(/app\.exit\(ALREADY_RUNNING\)/);
    expect(launcher).toMatch(/exit 78/);
    // The build failure keeps 1 on purpose: it can succeed on the next try.
    expect(launcher).toMatch(/exit 1\b/);
  });

  it("cleans up the process Chromium moved out of the service cgroup", () => {
    // Chromium relocates its browser process into a transient scope of its own,
    // so `systemctl stop` reaches the wrapper and the zygotes but not the
    // process holding the socket. Without this the next start refuses forever.
    const unit = read(UNIT);
    const post = iniValue(unit, "ExecStopPost") ?? "";

    expect(post).toContain(`app-${IDENTIFIER}-*.scope`);
    // The `-` prefix: on a clean stop the scope is already gone, and a stop
    // that failed because there was nothing to clean up is not a failure.
    expect(post.startsWith("-")).toBe(true);
  });

  it("is the only copy of itself", () => {
    // Memory records the Qt unit existing in two unsynced copies, one here and
    // one in the operator's dotfiles, which then drifted. One real file and an
    // install step is the answer; a second copy anywhere is the defect.
    const dotfiles = `${process.env.HOME}/.dotfiles/.config/systemd/user/${UNIT}`;
    if (!existsSync(dotfiles)) return;

    // A symlink is not a copy. A regular file is.
    expect(lstatSync(dotfiles).isSymbolicLink()).toBe(true);
  });
});

describe("the launcher the unit runs", () => {
  it("lives in this repository", () => {
    // Review found the unit's ExecStart naming a hand-written file in
    // ~/.local/bin that this repository neither owned nor installed — with
    // `Restart=always` behind it, so losing that file would restart-loop the
    // daemon at every login with nothing pointing at the cause.
    const launcher = `${repoRoot}bin/${IDENTIFIER}`;

    expect(existsSync(launcher)).toBe(true);
    expect(lstatSync(launcher).mode & 0o111).not.toBe(0);
  });

  it("is what the unit actually starts", () => {
    const unit = read(UNIT);

    expect(iniValue(unit, "ExecStart")).toContain(IDENTIFIER);
  });

  it("finds its own directory rather than hardcoding a worktree path", () => {
    // The out-of-repo original baked in the worktree path and carried a note
    // to edit that line when the branch merged. A launcher that resolves
    // through its own symlink needs no edit on a merge and none on a fresh
    // machine — and cannot silently point at a tree that has moved.
    const launcher = read(`bin/${IDENTIFIER}`);

    expect(launcher).toMatch(/readlink -f "\$0"/);
    expect(launcher).not.toMatch(/\.t3\/worktrees/);
  });

  it("is installed alongside the command-line tool", () => {
    const script = read("install-desktop-integration.sh");

    expect(script).toMatch(new RegExp(`link "\\$repo/bin/${IDENTIFIER}"`));
  });

  it("refuses to enable a unit whose binary is missing", () => {
    const script = read("install-desktop-integration.sh");

    expect(script).toMatch(/if \[ ! -x "\$bindir\/symmetria-fm-electron" \]/);
    expect(script.indexOf('-x "$bindir/symmetria-fm-electron"')).toBeLessThan(
      script.indexOf("systemctl --user enable"),
    );
  });
});

describe("the install script", () => {
  it("exists and is executable", () => {
    const path = `${repoRoot}install-desktop-integration.sh`;

    expect(existsSync(path)).toBe(true);
    expect(lstatSync(path).mode & 0o111).not.toBe(0);
  });

  it("places the unit where systemd reads user units", () => {
    const script = read("install-desktop-integration.sh");

    // `systemd/user` rather than `.config/systemd/user`: the script honours
    // XDG_CONFIG_HOME, so the literal path is only the fallback half of a
    // parameter expansion. This accepts BOTH forms rather than only the one
    // the first draft of this assertion happened to imagine.
    expect(script).toMatch(/systemd\/user/);
    expect(script).toContain("symmetria-fm-electron.service");
  });

  it("enables the unit but never starts it", () => {
    // Starting it mid-install would map a window onto whatever workspace the
    // operator is on, because the compositor rules are written and not applied
    // until they reload. Enabling starts nothing; it takes effect at next login.
    const script = read("install-desktop-integration.sh");

    expect(script).toMatch(/systemctl --user enable/);

    // The compositor is never touched. Asserted per LINE rather than over the
    // whole file, because the script's header says out loud that it runs no
    // `hyprctl` — and a test that forbade the word would have forced the fix
    // into deleting the sentence that tells a reader the omission is
    // deliberate. Every occurrence must be a comment; one that is not fails.
    const executable = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/hyprctl/);

    // The `start` verb appears exactly once, and only inside the closing
    // instructions where it is text for the operator to run themselves.
    //
    // The first draft of this assertion forbade the string outright and failed
    // on that help text — which would have pushed the fix into removing a
    // command the user needs. Counting and locating keeps every bit of the
    // original coverage: a second occurrence, or one before the heredoc, still
    // fails.
    const starts = [...script.matchAll(/systemctl --user (?:start|restart)\b/g)];
    expect(starts).toHaveLength(1);
    expect(starts[0]?.index ?? -1).toBeGreaterThan(script.indexOf("cat <<'NEXT'"));
  });
});

describe("the Hyprland fragment", () => {
  const fragment = () => read("docs/electron-transition/22-desktop-integration.md");

  it("declares a workspace of its own", () => {
    expect(fragment()).toMatch(/workspace\s*=\s*name:files/);
  });

  it("routes the window there silently", () => {
    // `silent` is not optional, and the operator's own comments on the Zen and
    // Mesura Code rules say why: without it every relaunch yanks them off
    // whatever workspace they were working on.
    expect(fragment()).toMatch(/windowrule\s*=\s*workspace name:files silent/);
    expect(fragment()).toMatch(/match:class \^\(symmetria-fm-electron\)\$/);
  });

  it("excludes a picker window from that routing, by title", () => {
    // Chromium sets the Wayland app id ONCE PER PROCESS from the desktop name,
    // so a save dialog cannot have an id of its own. Without a title exclusion
    // every "attach a file" dialog would be dragged to the file manager's
    // workspace instead of appearing over the application that asked for it.
    // The precedent is the operator's own Zen rule, which excludes
    // Picture-in-Picture exactly this way.
    expect(fragment()).toMatch(/match:title negative:/);
  });

  it("keeps the Qt build's binding", () => {
    // Super+E belongs to the Qt file manager, which is still the daily driver.
    // The Electron one stays on Super+Shift+E until the operator moves it.
    expect(fragment()).toMatch(/Super\+Shift, E/);
    expect(fragment()).not.toMatch(/^bind = Super, E/m);
  });
});
