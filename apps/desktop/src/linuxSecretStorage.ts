export type LinuxPasswordStorePreference =
  | "auto"
  | "gnome-libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6";
export type LinuxPasswordStoreSwitch = Exclude<LinuxPasswordStorePreference, "auto">;

export const DEFAULT_LINUX_PASSWORD_STORE: LinuxPasswordStorePreference = "auto";

// Chromium matches desktop names case-sensitively and stops at the first recognized value.
const ELECTRON_LIBSECRET_DESKTOPS = new Set([
  "Deepin",
  "GNOME",
  "Pantheon",
  "UKUI",
  "Unity",
  "X-Cinnamon",
  "XFCE",
]);
// Chromium selects a KWallet generation for KDE from KDE_SESSION_VERSION, so it needs no help.
const ELECTRON_KDE_DESKTOP = "KDE";
// Chromium recognizes LXQt and still selects basic text for it, so it does need a forced backend.
const ELECTRON_UNPROTECTED_DESKTOPS = new Set(["LXQt"]);

const KDE_NAME_PREFIXES = ["kde", "plasma"];
const NEGATIVE_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

export function normalizeLinuxPasswordStorePreference(
  value: unknown,
): LinuxPasswordStorePreference {
  return value === "gnome-libsecret" ||
    value === "kwallet" ||
    value === "kwallet5" ||
    value === "kwallet6"
    ? value
    : DEFAULT_LINUX_PASSWORD_STORE;
}

export function resolveLinuxPasswordStoreSwitch(input: {
  readonly preference: LinuxPasswordStorePreference;
  readonly env: NodeJS.ProcessEnv;
}): LinuxPasswordStoreSwitch | null {
  if (input.preference !== "auto") {
    return input.preference;
  }

  return electronSelectsProtectedBackend(input.env) ? null : "gnome-libsecret";
}

// DESKTOP_SESSION and legacy KDE markers can be stale, so only trust exact XDG_CURRENT_DESKTOP values.

function electronSelectsProtectedBackend(env: NodeJS.ProcessEnv): boolean {
  for (const name of splitDesktopNameList(env.XDG_CURRENT_DESKTOP)) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed === ELECTRON_KDE_DESKTOP || ELECTRON_LIBSECRET_DESKTOPS.has(trimmed)) {
      return true;
    }
    if (ELECTRON_UNPROTECTED_DESKTOPS.has(trimmed)) {
      return false;
    }
  }

  return false;
}

export function resolveLinuxSecretStorageUnavailableMessage(input: {
  readonly configuredPreference: LinuxPasswordStorePreference;
  readonly selectedBackend: string | null;
  readonly env: NodeJS.ProcessEnv;
}): string {
  if (input.configuredPreference === "gnome-libsecret") {
    return getGnomeKeyringRemediationMessage();
  }

  if (
    input.configuredPreference === "kwallet" ||
    input.configuredPreference === "kwallet5" ||
    input.configuredPreference === "kwallet6"
  ) {
    return getKWalletRemediationMessage();
  }

  const backend = normalizeSelectedStorageBackend(input.selectedBackend);
  if (backend === "gnome-libsecret") {
    return getGnomeKeyringRemediationMessage();
  }

  if (
    backend === "kwallet" ||
    backend === "kwallet5" ||
    backend === "kwallet6" ||
    looksLikeKdeSession(input.env)
  ) {
    return getKWalletRemediationMessage();
  }

  return getGnomeKeyringRemediationMessage();
}

function getGnomeKeyringRemediationMessage(): string {
  return "Mesura Code could not access GNOME Keyring to save this environment credential. Install and start GNOME Keyring, then restart Mesura Code.";
}

function getKWalletRemediationMessage(): string {
  return "Mesura Code could not access KWallet to save this environment credential. Enable the KDE wallet subsystem in System Settings, then restart Mesura Code.";
}

// Advisory only: this picks between the GNOME Keyring and KWallet wording in the failure notice. It
// never decides which backend to select, so a loose match costs a user slightly wrong instructions
// rather than an unprotected credential store.
function looksLikeKdeSession(env: NodeJS.ProcessEnv): boolean {
  const currentDesktopNames = nonEmptyDesktopNames(env.XDG_CURRENT_DESKTOP);
  if (currentDesktopNames.length > 0) {
    return currentDesktopNames.some(isKdeDesktopName);
  }

  const legacyNames = legacyDesktopNames(env);
  if (legacyNames.length > 0) {
    return legacyNames.some(isKdeDesktopName);
  }

  return isSet(env.KDE_SESSION_VERSION) || isAffirmativeFlag(env.KDE_FULL_SESSION);
}

function isKdeDesktopName(name: string): boolean {
  return KDE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function legacyDesktopNames(env: NodeJS.ProcessEnv): string[] {
  return [env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION, env.GDMSESSION].flatMap((entry) => {
    const normalized = normalizeDesktopName(entry);
    return normalized ? [normalized] : [];
  });
}

function nonEmptyDesktopNames(value: string | undefined): string[] {
  return splitDesktopNameList(value).flatMap((entry) => {
    const normalized = normalizeDesktopName(entry);
    return normalized ? [normalized] : [];
  });
}

function isSet(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function isAffirmativeFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized ? !NEGATIVE_FLAG_VALUES.has(normalized) : false;
}

function normalizeDesktopName(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeSelectedStorageBackend(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
  return normalized && normalized.length > 0 ? normalized : null;
}

function splitDesktopNameList(value: string | undefined): string[] {
  return value?.split(":") ?? [];
}
