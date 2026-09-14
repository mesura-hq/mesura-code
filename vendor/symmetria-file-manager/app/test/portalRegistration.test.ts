import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A second portal backend, installable and switched off.
 *
 * The Electron file manager can answer a file dialog, but the DESKTOP still has
 * to be told to ask it — and only one backend may own
 * `org.freedesktop.impl.portal.FileChooser` at a time. The Qt build owns it and
 * the operator uses it daily, so this phase ships the registration and does not
 * activate it. Throwing the switch is one line in a configuration file, and it
 * stays theirs to throw.
 *
 * Everything here is a static consistency check. What it cannot check — that
 * `xdg-desktop-portal` actually selects the backend — is the one line this
 * phase deliberately does not write.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** The Qt build's name. Nothing here may collide with it. */
const QT_BUS_NAME = "org.freedesktop.impl.portal.desktop.symmetria";
const ELECTRON_BUS_NAME = "org.freedesktop.impl.portal.desktop.symmetria-electron";

describe("one script, two registrations", () => {
  it("reads the command-line tool it launches from the environment", () => {
    // A second COPY of the 392-line backend would drift, and the looser of two
    // copies is the one that matters. The two backends differ in exactly two
    // values, so those two are what the environment supplies.
    const script = read("/portal/symmetria_portal.py");

    expect(script).toContain("SYMMETRIA_PORTAL_FM_CLI");
    expect(script).toContain("SYMMETRIA_PORTAL_BUS_NAME");
  });

  it("keeps the Qt values as the defaults, so its registration is unchanged", () => {
    // The operator's daily file dialogs go through this script. Parameterising
    // it must not alter what it does when nothing sets the variables.
    const script = read("/portal/symmetria_portal.py");

    expect(script).toContain('"symmetria-fm-cli"');
    expect(script).toContain(`"${QT_BUS_NAME}"`);
  });
});

describe("the Electron registration", () => {
  it("claims a D-Bus name of its own", () => {
    // Two backends on one bus name is not a configuration, it is a race.
    const portal = read("/portal/symmetria-electron.portal");
    const service = read("/portal/org.freedesktop.impl.portal.desktop.symmetria-electron.service");

    expect(portal).toContain(`DBusName=${ELECTRON_BUS_NAME}`);
    expect(service).toContain(`Name=${ELECTRON_BUS_NAME}`);
  });

  it("declares the same interface the Qt backend implements", () => {
    // The interface is what makes them alternatives. A backend registering a
    // different one would install cleanly and answer nothing.
    const portal = read("/portal/symmetria-electron.portal");

    expect(portal).toContain("Interfaces=org.freedesktop.impl.portal.FileChooser");
  });

  it("points its service and its unit at the same executable and the same name", () => {
    // Three files have to agree or the bus activates something that never
    // claims the name it was activated for, and every dialog hangs.
    const service = read("/portal/org.freedesktop.impl.portal.desktop.symmetria-electron.service");
    const unit = read("/portal/xdg-desktop-portal-symmetria-electron.service");

    expect(service).toContain("SystemdService=xdg-desktop-portal-symmetria-electron.service");
    expect(unit).toContain(`BusName=${ELECTRON_BUS_NAME}`);
    expect(unit).toContain("symmetria_portal.py");
  });

  it("tells its copy of the script to drive the Electron command-line tool", () => {
    // The whole difference between the two backends, stated where the reader
    // will look for it.
    const unit = read("/portal/xdg-desktop-portal-symmetria-electron.service");

    expect(unit).toContain("SYMMETRIA_PORTAL_FM_CLI=symmetria-fm-electron-cli");
    expect(unit).toContain(`SYMMETRIA_PORTAL_BUS_NAME=${ELECTRON_BUS_NAME}`);
  });
});

describe("the installer activates nothing", () => {
  it("never writes the file that chooses a backend", () => {
    // `portals.conf` is what decides which backend answers a dialog. The Qt
    // build's own installer edits it; this one must not, because the operator
    // is using those dialogs while this is being built.
    //
    // The check is on WRITING rather than on mentioning, because the installer
    // has to name the file to tell somebody what to add to it. An earlier
    // version of this assertion forbade the string outright and would have
    // failed the only helpful thing the installer prints.
    const installer = read("/portal/install-portal-electron.sh");
    const writesTo = installer
      .split("\n")
      .filter((line) => line.includes("portals.conf"))
      .filter((line) => /(^|\s)(cp|mv|tee|install)\s|>>?\s|sed\s+-i/.test(line));

    expect(writesTo, `these lines write to portals.conf:\n${writesTo.join("\n")}`).toEqual([]);
  });

  it("says what the operator would add to switch over", () => {
    // Shipping a backend nobody can find is not shipping it. The line goes in
    // the output, where somebody deciding will read it.
    const installer = read("/portal/install-portal-electron.sh");

    expect(installer).toContain("org.freedesktop.impl.portal.desktop.symmetria-electron");
    expect(installer.toLowerCase()).toContain("filechooser");
  });

  it("does not touch anything the Qt backend owns", () => {
    // Same directory, adjacent filenames, one letter of difference in places.
    // An installer that overwrote the Qt registration would take the
    // operator's working file dialogs down.
    const installer = read("/portal/install-portal-electron.sh");
    // The SCRIPT is deliberately absent from this list: both backends run the
    // same file, which is the whole point of parameterising it, and both
    // installers write the same bytes to the same shared path. What must not be
    // touched is the Qt backend's own REGISTRATION — the three files that say
    // which name it claims and when it starts.
    const qtOwned = [
      "/portal/symmetria.portal",
      "org.freedesktop.impl.portal.desktop.symmetria.service",
      "xdg-desktop-portal-symmetria.service",
    ];

    for (const path of qtOwned) {
      expect(installer.includes(` ${path}`), path).toBe(false);
    }
  });
});
