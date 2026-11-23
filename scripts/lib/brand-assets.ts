import { DEFAULT_STATE_HOME_DIR_NAME } from "@t3tools/shared/stateHome";

export const BRAND_ASSET_PATHS = {
  monochromeSourceSvg: "assets/mesura-code/monochrome.svg",
  desktopMasterPng: "assets/mesura-code/desktop-master.png",
  // The boot splash draws the cube alone, with no channel container behind it,
  // so one mark serves every channel. The stage label is rendered as text next
  // to it rather than baked into the artwork.
  splashMarkSourcePng: "assets/mesura-code/splash-mark.png",
  webSplashMarkPng: "apps/web/public/splash-mark.png",
  developmentMasterPng: "assets/mesura-code/development-master.png",
  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",

  productionMasterPng: "assets/mesura-code/production-master.png",
  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-linux-1024.png",
  productionUniversalIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",
  // Mesura: the 192 and 512 pixel icons the web app manifest and push notifications use.
  productionWebIcon192Png: "assets/prod/t3-black-web-icon-192.png",
  productionWebIcon512Png: "assets/prod/t3-black-web-icon-512.png",

  nightlyMasterPng: "assets/mesura-code/nightly-master.png",
  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png",
  nightlyWebIcon192Png: "assets/nightly/nightly-web-icon-192.png",
  nightlyWebIcon512Png: "assets/nightly/nightly-web-icon-512.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
  developmentWebIcon192Png: "assets/dev/blueprint-web-icon-192.png",
  developmentWebIcon512Png: "assets/dev/blueprint-web-icon-512.png",
} as const;

/** Side of the square channel masters in `assets/mesura-code/`. */
export const MASTER_RASTER_SIZE = 1254;

/**
 * First row a channel master may own: above it the development and nightly masters must equal the
 * production artwork; below it they carry the channel wordmark. `brand-icon-source.test.ts` reads it.
 * Android adaptive launchers clip this band; that is expected, not a regression.
 */
export const CHANNEL_WORDMARK_BAND_TOP = 1097;

export const DESKTOP_LINUX_IDENTITY = {
  development: {
    desktopEntryName: "mesura-code-dev.desktop",
    executableName: "mesura-code-dev",
    wmClass: "mesura-code-dev",
  },
  production: {
    desktopEntryName: "mesura-code.desktop",
    executableName: "mesura-code",
    wmClass: "mesura-code",
  },
} as const;

export function resolveDesktopLinuxIdentity(
  isDevelopment: boolean,
  channel: MesuraDesktopChannel = "stable",
) {
  if (isDevelopment) return DESKTOP_LINUX_IDENTITY.development;
  return channel === "stable"
    ? DESKTOP_LINUX_IDENTITY.production
    : MESURA_DESKTOP_CHANNEL_IDENTITY[channel];
}

/**
 * Electron scopes its single-instance lock to the userData directory; sharing upstream's `t3code`
 * with the installed T3 Code made the second app to start quit silently. `legacyUserDataDirName`
 * repeats `userDataDirName` on purpose: pointing it at `t3code` or `T3 Code (Alpha)` would make
 * `resolveUserDataPath` adopt T3 Code's directory and restore that collision.
 */
export const DESKTOP_USER_DATA_IDENTITY = {
  development: {
    userDataDirName: "mesura-code-dev",
    legacyUserDataDirName: "mesura-code-dev",
  },
  production: {
    userDataDirName: "mesura-code",
    legacyUserDataDirName: "mesura-code",
  },
} as const;

export function resolveDesktopUserDataIdentity(
  isDevelopment: boolean,
  channel: MesuraDesktopChannel = "stable",
) {
  if (isDevelopment) return DESKTOP_USER_DATA_IDENTITY.development;
  return channel === "stable"
    ? DESKTOP_USER_DATA_IDENTITY.production
    : MESURA_DESKTOP_CHANNEL_IDENTITY[channel];
}

/**
 * Packaged desktop channels that can run side by side on one machine. The build writes the
 * channel into the packaged package.json as `mesuraChannel`; the app reads it before Electron
 * is ready. Channel slugs avoid `mesura-code-dev`, which development mode (`vp run dev:desktop`)
 * already owns.
 */
export const MESURA_DESKTOP_CHANNELS = ["stable", "dev", "lab"] as const;

export type MesuraDesktopChannel = (typeof MESURA_DESKTOP_CHANNELS)[number];

export interface MesuraDesktopIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

export interface MesuraDesktopChannelIdentity {
  readonly channel: MesuraDesktopChannel;
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
  readonly homeDirName: string;
  readonly desktopEntryName: string;
  readonly executableName: string;
  readonly wmClass: string;
  /** `null` keeps the version-derived Beta/Nightly label, product name and icons. */
  readonly stageLabel: "Dev" | "Lab" | null;
  /** Window title and packaged product name; `null` keeps the version-derived name. */
  readonly displayName: string | null;
  readonly artifactBaseName: string;
  readonly backendPort: number;
  readonly tailscaleServePort: number;
  readonly icons: MesuraDesktopIconAssets | null;
}

function sideBySideChannelIdentity(input: {
  readonly channel: Exclude<MesuraDesktopChannel, "stable">;
  readonly stageLabel: "Dev" | "Lab";
  readonly backendPort: number;
  readonly tailscaleServePort: number;
  readonly icons: MesuraDesktopIconAssets;
}): MesuraDesktopChannelIdentity {
  const slug = `mesura-code-channel-${input.channel}`;
  return {
    ...input,
    userDataDirName: slug,
    legacyUserDataDirName: slug,
    homeDirName: `.${slug}`,
    desktopEntryName: `${slug}.desktop`,
    executableName: slug,
    wmClass: slug,
    displayName: `Mesura Code ${input.stageLabel}`,
    artifactBaseName: `Mesura-Code-${input.stageLabel}`,
  };
}

export const MESURA_DESKTOP_CHANNEL_IDENTITY: Readonly<
  Record<MesuraDesktopChannel, MesuraDesktopChannelIdentity>
> = {
  stable: {
    channel: "stable",
    ...DESKTOP_USER_DATA_IDENTITY.production,
    ...DESKTOP_LINUX_IDENTITY.production,
    homeDirName: DEFAULT_STATE_HOME_DIR_NAME,
    stageLabel: null,
    displayName: null,
    artifactBaseName: "Mesura-Code",
    backendPort: 3773,
    tailscaleServePort: 443,
    icons: null,
  },
  dev: sideBySideChannelIdentity({
    channel: "dev",
    stageLabel: "Dev",
    backendPort: 3783,
    tailscaleServePort: 8783,
    icons: {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyMasterPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    },
  }),
  lab: sideBySideChannelIdentity({
    channel: "lab",
    stageLabel: "Lab",
    backendPort: 3793,
    tailscaleServePort: 8793,
    icons: {
      macIconPng: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.developmentMasterPng,
      windowsIconIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  }),
};

/** An absent channel is stable; any other value that is not a known channel throws. */
export function resolveMesuraDesktopChannelIdentity(value: unknown): MesuraDesktopChannelIdentity {
  if (value === undefined) return MESURA_DESKTOP_CHANNEL_IDENTITY.stable;
  const channel = MESURA_DESKTOP_CHANNELS.find((candidate) => candidate === value);
  if (channel === undefined) {
    throw new Error(
      `Unknown Mesura desktop channel ${JSON.stringify(value)}; expected one of ${MESURA_DESKTOP_CHANNELS.join(", ")}.`,
    );
  }
  return MESURA_DESKTOP_CHANNEL_IDENTITY[channel];
}

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
  icon192Png: "icon-192.png",
  icon512Png: "icon-512.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.developmentWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.developmentWebIcon512Png,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.nightlyWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.nightlyWebIcon512Png,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.productionWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.productionWebIcon512Png,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
    {
      sourceRelativePath: sourcePaths.icon192Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon192Png}`,
    },
    {
      sourceRelativePath: sourcePaths.icon512Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon512Png}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
