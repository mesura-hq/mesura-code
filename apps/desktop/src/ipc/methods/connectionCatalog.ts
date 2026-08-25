import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import { resolveLinuxSecretStorageUnavailableMessage } from "../../linuxSecretStorage.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Said when the platform has no keyring story worth naming, or none is known. */
const GENERIC_SECURE_STORAGE_UNAVAILABLE_MESSAGE =
  "Mesura Code could not reach this system's secure storage to save the credential.";

export const getConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.connectionCatalog.get")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return Option.getOrNull(yield* store.get);
  }),
});

export const setConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.connectionCatalog.set")(function* (catalog) {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return yield* store.set(catalog);
  }),
});

/**
 * Turns "secure storage is unavailable" into an instruction.
 *
 * `resolveLinuxSecretStorageUnavailableMessage` existed for exactly this and
 * had no production caller — only its own test — so every user who hit the
 * failure read the renderer's generic sentence and had no idea that the fix was
 * to install a keyring. Hyprland reaches this path by default: Chromium
 * recognizes a fixed list of XDG_CURRENT_DESKTOP values, Hyprland is not on it,
 * so the app forces gnome-libsecret and then finds no org.freedesktop.secrets
 * on the session bus.
 */
export const getSecureStorageUnavailableReason = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_SECURE_STORAGE_UNAVAILABLE_REASON_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.connectionCatalog.secureStorageUnavailableReason")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "linux") {
      return GENERIC_SECURE_STORAGE_UNAVAILABLE_MESSAGE;
    }
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const configuredPreference = (yield* settings.get).linuxPasswordStore;
    const selectedBackend = yield* safeStorage.selectedStorageBackend;
    return resolveLinuxSecretStorageUnavailableMessage({
      configuredPreference,
      selectedBackend: Option.getOrNull(selectedBackend),
      env: process.env,
    });
  }),
});

export const clearConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.connectionCatalog.clear")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    yield* store.clear;
  }),
});
