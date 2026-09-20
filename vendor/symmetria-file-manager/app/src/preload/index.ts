import { BRIDGE_KEY, type Bridge, type Unsubscribe } from "@symmetria/fm-core/bridge";

import { PUSH_CHANNELS, REQUEST_CHANNELS } from "@symmetria/fm-main/ipc/channels";
import { contextBridge, ipcRenderer } from "electron";

/**
 * The preload runs with Node available, inside the renderer process. Anything
 * attached to `window` here becomes reachable from sandboxed page code, so this
 * file exposes exactly one object holding plain functions — never a module,
 * never `ipcRenderer` itself, and never a function that takes a channel name
 * from the caller. A bridge that lets page code choose the channel is not a
 * bridge, it is a hole with a railing.
 *
 * There is one `exposeInMainWorld` call in this file and a test asserts that
 * count, because "exactly one" is the property worth pinning.
 */

function listen(channel: string, listener: (payload: unknown) => void): Unsubscribe {
  const wrapped = (_event: unknown, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: Bridge = {
  version: process.versions.electron ?? "unknown",
  overview: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.overview, request),
  list: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.list, request),
  watch: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.watch, request),
  unwatch: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.unwatch, request),
  readText: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.readText, request),
  cancel: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.cancel, request),
  searchStart: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.searchStart, request),
  searchQuery: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.searchQuery, request),
  searchRecord: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.searchRecord, request),
  searchRelease: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.searchRelease, request),
  describe: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.describe, request),
  previewUrl: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.previewUrl, request),
  previewDirectoryUrl: (request) =>
    ipcRenderer.invoke(REQUEST_CHANNELS.previewDirectoryUrl, request),
  transfer: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.transfer, request),
  cancelTransfer: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.cancelTransfer, request),
  create: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.create, request),
  rename: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.rename, request),
  trash: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.trash, request),
  open: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.open, request),
  clipboard: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.clipboard, request),
  frecent: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.frecent, request),
  bookmarksRead: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.bookmarksRead, request),
  bookmarksWrite: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.bookmarksWrite, request),
  listingRead: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.listingRead, request),
  listingWrite: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.listingWrite, request),
  hideWindow: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.hideWindow, request),
  pickerConfirm: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.pickerConfirm, request),
  pickerCancel: (request) => ipcRenderer.invoke(REQUEST_CHANNELS.pickerCancel, request),
  onListBatch: (listener) => listen(PUSH_CHANNELS.listBatch, listener),
  onChanged: (listener) => listen(PUSH_CHANNELS.changed, listener),
  onTransferProgress: (listener) => listen(PUSH_CHANNELS.transferProgress, listener),
  onOpenPath: (listener) => listen(PUSH_CHANNELS.openPath, listener),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
