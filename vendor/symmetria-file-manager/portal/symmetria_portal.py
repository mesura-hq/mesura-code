#!/usr/bin/env python3
# NOTE: This script is invoked by systemd using the virtualenv Python at
# ~/.local/share/symmetria/portal-venv/bin/python3 (see install-portal.sh).
# The venv contains dbus-fast; the system Python is never modified.
"""Symmetria XDG Desktop Portal FileChooser backend.

Implements org.freedesktop.impl.portal.FileChooser by delegating to
the Symmetria File Manager daemon via the symmetria-fm-cli CLI. The
CLI opens a QLocalSocket to the running symmetria-fm daemon at
$XDG_RUNTIME_DIR/symmetria-fm.sock and writes a single JSON line
({"method": "createPicker", "args": {...}}). Communication back from
the picker still uses a FIFO (named pipe) — same protocol as before.
"""

import asyncio
import json
import logging
import os
import stat as stat_module
import subprocess
import threading
import uuid

from dbus_fast import Variant
from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, method

logging.basicConfig(
    level=logging.INFO,
    format="[symmetria-portal] %(levelname)s: %(message)s",
)
log = logging.getLogger(__name__)

HOME_DIR = os.path.normpath(os.path.expanduser("~"))
_downloads_candidate = os.path.join(HOME_DIR, "Downloads")
# Use ~/Downloads as save-dialog default only if the directory actually exists.
DOWNLOADS_DIR = _downloads_candidate if os.path.isdir(_downloads_candidate) else HOME_DIR
FIFO_PREFIX = "/tmp/symmetria-picker-"
FIFO_TIMEOUT_SECONDS = 300  # 5 minutes max wait for user interaction
CANCELLED_SENTINEL = "__PICKER_CANCELLED__"

# ── Which file manager this backend drives, and what it calls itself ─────────
#
# TWO backends, ONE script. The Qt build and the Electron build differ in
# exactly two values, so those two come from the environment rather than from a
# second copy of this file. A copy would drift, and the looser of two copies is
# the one that matters — this script validates nothing about the FIFO path it
# creates beyond its own prefix, so a stale copy is a real hazard rather than a
# tidiness argument.
#
# The DEFAULTS are the Qt build's, so its registration behaves exactly as it did
# before this was parameterised. The Electron registration sets both in its
# systemd unit; see `xdg-desktop-portal-symmetria-electron.service`.
FM_CLI = os.environ.get("SYMMETRIA_PORTAL_FM_CLI", "symmetria-fm-cli")
BUS_NAME = os.environ.get(
    "SYMMETRIA_PORTAL_BUS_NAME", "org.freedesktop.impl.portal.desktop.symmetria"
)


def decode_byte_array_path(variant_value) -> str:
    """Decode a portal current_folder (ay, null-terminated bytes) to a string."""
    if variant_value is None:
        return ""
    raw_bytes = bytes(variant_value)
    # Strip trailing null byte(s)
    raw_bytes = raw_bytes.rstrip(b"\x00")
    if not raw_bytes:
        return ""
    return raw_bytes.decode("utf-8", errors="replace")


def get_option(options: dict, key: str, default=None):
    """Extract a value from a D-Bus options dict (a{sv})."""
    if key in options:
        return options[key].value
    return default


async def read_fifo(fifo_path: str, timeout: float) -> str:
    """Read from a FIFO with a timeout. Returns the content or raises TimeoutError.

    Uses os.open() + os.fstat() to atomically verify the opened fd is a real
    FIFO, preventing symlink-substitution attacks (where an attacker replaces
    the expected FIFO with a symlink to a sensitive file like /etc/shadow).
    """
    loop = asyncio.get_running_loop()  # get_event_loop() is deprecated in Python 3.10+

    def _blocking_read():
        # Blocking open — waits until the picker writes to the FIFO.
        # This runs in an executor thread with an asyncio timeout, so
        # the event loop stays responsive.
        fd = os.open(fifo_path, os.O_RDONLY)
        try:
            mode = os.fstat(fd).st_mode
            if not stat_module.S_ISFIFO(mode):
                raise OSError(
                    f"Security: expected FIFO at {fifo_path}, "
                    f"got mode {oct(mode)}"
                )
            with os.fdopen(fd, "r") as f:
                return f.read()
        except:
            os.close(fd)
            raise

    return await asyncio.wait_for(
        loop.run_in_executor(None, _blocking_read),
        timeout=timeout,
    )


def create_fifo() -> str:
    """Create a secure FIFO and return its path.

    Uses uuid4 to generate a unique name and os.mkfifo for atomic creation,
    avoiding the TOCTOU race inherent in tempfile.mktemp.
    """
    path = f"/tmp/symmetria-picker-{uuid.uuid4().hex}"
    os.mkfifo(path, mode=0o600)
    return path


def launch_fm_ipc(method_name: str, args_json: str) -> None:
    """Fire-and-forget IPC call to the symmetria-fm daemon.

    Uses Popen + communicate() in a daemon thread so the process is fully
    reaped and no zombie is left behind, without blocking the event loop.
    The CLI exits within milliseconds (one socket write + reply read), so
    the daemon thread is short-lived.
    """
    cmd = [FM_CLI, method_name, args_json]
    log.info("Launching %s: %s", method_name, " ".join(cmd))

    def _run():
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        proc.communicate()  # Reap the process so no zombie is created

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()


class PortalRequest(ServiceInterface):
    """org.freedesktop.impl.portal.Request, exported at the handle path.

    The portal router calls Close when the requesting app cancels the dialog
    or exits. Backends MUST export this object — without it the router gets
    a D-Bus error and our picker window leaks open, blocking all subsequent
    dialog requests (single-picker lock in the daemon's main.qml).
    """

    def __init__(self, fifo_path: str):
        super().__init__("org.freedesktop.impl.portal.Request")
        self._fifo_path = fifo_path

    @method(name="Close")
    def close(self):
        log.info("Request.Close received — dismissing picker for %s", self._fifo_path)
        # Intentionally fire-and-forget: Close returns to the router immediately
        # while the daemon asynchronously closes the picker window and writes
        # the cancellation sentinel to the FIFO, which resolves the pending
        # read_fifo() in the FileChooser method as a normal cancel. Do NOT make
        # this await the dismissal — read_fifo() runs on this same event loop,
        # so blocking here would deadlock against the response it waits for.
        launch_fm_ipc("closePicker", json.dumps({"fifo": self._fifo_path}))


class FileChooserBackend(ServiceInterface):
    """Implements org.freedesktop.impl.portal.FileChooser."""

    def __init__(self, bus: MessageBus):
        super().__init__("org.freedesktop.impl.portal.FileChooser")
        self._bus = bus

    async def _run_picker_request(self, handle: str, picker_options: dict):
        """Shared picker round-trip: FIFO + Request export + IPC + response.

        Creates the response FIFO, exports the Request object at the router's
        handle path, asks the daemon to spawn the picker, and waits for the
        user's answer. Returns the raw FIFO payload string, or None if the
        picker was cancelled. Raises asyncio.TimeoutError on user inaction.
        """
        fifo_path = create_fifo()
        log.info("Created FIFO: %s", fifo_path)

        # `handle` is a per-request object path the router allocates uniquely
        # (…/request/<sender>/<token>), so concurrent requests never collide on
        # the same export path — each gets its own Request object.
        request = PortalRequest(fifo_path)
        try:
            self._bus.export(handle, request)
        except Exception as exc:
            # Non-fatal: the dialog still works, only app-initiated Close is lost.
            log.warning("Could not export Request at %s: %s", handle, exc)
            request = None

        try:
            launch_fm_ipc("createPicker",
                          json.dumps({**picker_options, "fifo": fifo_path}))

            result = await read_fifo(fifo_path, FIFO_TIMEOUT_SECONDS)
            result = result.strip()
            if not result or result == CANCELLED_SENTINEL:
                return None
            return result
        finally:
            if request is not None:
                try:
                    self._bus.unexport(handle, request)
                except Exception as exc:
                    # A leaked export is the exact failure this whole change
                    # defends against, so surface it rather than swallow.
                    log.warning("Failed to unexport Request at %s: %s", handle, exc)
            try:
                os.unlink(fifo_path)
            except OSError as exc:
                log.debug("Could not unlink FIFO %s: %s", fifo_path, exc)

    @method(name="OpenFile")
    async def open_file(
        self,
        handle: "o",
        app_id: "s",
        parent_window: "s",
        title: "s",
        options: "a{sv}",
    ) -> "ua{sv}":
        log.info("OpenFile request: title=%r, app_id=%r, parent_window=%r",
                 title, app_id, parent_window)

        multiple = get_option(options, "multiple", False)
        directory = get_option(options, "directory", False)
        accept_label = get_option(options, "accept_label", "")
        current_folder_raw = get_option(options, "current_folder", None)
        current_folder = decode_byte_array_path(current_folder_raw)
        # Open-file dialogs intentionally do not default to ~/Downloads — the
        # calling app's folder hint is meaningful (e.g. "open an image from where
        # you last looked"), so we honour it or fall back to empty (home dir).

        try:
            result = await self._run_picker_request(handle, {
                "title": title or "Select a File",
                "multiple": multiple,
                "directory": directory,
                "acceptLabel": accept_label,
                "currentFolder": current_folder,
                "parentWindow": parent_window,
            })

            if result is None:
                log.info("Picker cancelled")
                return [1, {}]

            # Parse newline-separated paths into file:// URIs
            paths = [line for line in result.split("\n") if line]
            uris = [f"file://{p}" for p in paths]
            log.info("Picker completed: %s", uris)

            return [0, {"uris": Variant("as", uris)}]

        except asyncio.TimeoutError:
            log.warning("Picker timed out after %ds", FIFO_TIMEOUT_SECONDS)
            return [1, {}]
        except Exception as exc:
            log.error("Picker error: %s", exc)
            return [2, {}]

    @method(name="SaveFile")
    async def save_file(
        self,
        handle: "o",
        app_id: "s",
        parent_window: "s",
        title: "s",
        options: "a{sv}",
    ) -> "ua{sv}":
        log.info("SaveFile request: title=%r, app_id=%r, parent_window=%r",
                 title, app_id, parent_window)

        current_name = get_option(options, "current_name", "")
        accept_label = get_option(options, "accept_label", "")
        current_folder_raw = get_option(options, "current_folder", None)
        current_folder = decode_byte_array_path(current_folder_raw)
        current_file_raw = get_option(options, "current_file", None)
        current_file = decode_byte_array_path(current_file_raw)

        # If current_file is set, extract folder and filename from it
        if current_file and not current_folder:
            current_folder = os.path.dirname(current_file)
        if current_file and not current_name:
            current_name = os.path.basename(current_file)

        # Default to ~/Downloads for save dialogs when the app doesn't
        # provide a specific folder (empty or just home directory).
        if not current_folder or os.path.normpath(current_folder) == HOME_DIR:
            current_folder = DOWNLOADS_DIR

        log.info("SaveFile: name=%r, folder=%r", current_name, current_folder)

        try:
            result = await self._run_picker_request(handle, {
                "title": title or "Save File",
                "multiple": False,
                "directory": False,
                "saveMode": True,
                "suggestedName": current_name,
                "acceptLabel": accept_label or "Save",
                "currentFolder": current_folder,
                "parentWindow": parent_window,
            })

            if result is None:
                log.info("Save picker cancelled")
                return [1, {}]

            # Result is a single directory path or full file path
            paths = [line for line in result.split("\n") if line]
            save_path = paths[0]

            # If user selected a directory, append the suggested filename
            if os.path.isdir(save_path) and current_name:
                save_path = os.path.join(save_path, current_name)

            uri = f"file://{save_path}"
            log.info("Save completed: %s", uri)

            return [0, {"uris": Variant("as", [uri])}]

        except asyncio.TimeoutError:
            log.warning("Save picker timed out after %ds", FIFO_TIMEOUT_SECONDS)
            return [1, {}]
        except Exception as exc:
            log.error("Save picker error: %s", exc)
            return [2, {}]

    @method(name="SaveFiles")
    async def save_files(
        self,
        handle: "o",
        app_id: "s",
        parent_window: "s",
        title: "s",
        options: "a{sv}",
    ) -> "ua{sv}":
        log.info("SaveFiles request: title=%r, app_id=%r, parent_window=%r",
                 title, app_id, parent_window)

        accept_label = get_option(options, "accept_label", "")
        current_folder_raw = get_option(options, "current_folder", None)
        current_folder = decode_byte_array_path(current_folder_raw)

        # Default to ~/Downloads (same rationale as save_file).
        if not current_folder or os.path.normpath(current_folder) == HOME_DIR:
            current_folder = DOWNLOADS_DIR

        try:
            result = await self._run_picker_request(handle, {
                "title": title or "Save Files",
                "multiple": False,
                "directory": True,
                "saveMode": True,
                "acceptLabel": accept_label or "Save Here",
                "currentFolder": current_folder,
                "parentWindow": parent_window,
            })

            if result is None:
                log.info("SaveFiles picker cancelled")
                return [1, {}]

            save_dir = result.split("\n")[0]
            uri = f"file://{save_dir}"
            log.info("SaveFiles completed: %s", uri)

            return [0, {"uris": Variant("as", [uri])}]

        except asyncio.TimeoutError:
            log.warning("SaveFiles picker timed out after %ds", FIFO_TIMEOUT_SECONDS)
            return [1, {}]
        except Exception as exc:
            log.error("SaveFiles error: %s", exc)
            return [2, {}]


async def main():
    bus = await MessageBus().connect()
    backend = FileChooserBackend(bus)
    bus.export("/org/freedesktop/portal/desktop", backend)

    bus_name = BUS_NAME
    await bus.request_name(bus_name)
    log.info("Portal backend running as %s", bus_name)

    # Run until terminated
    await bus.wait_for_disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    finally:
        log.info("Portal backend stopped")
