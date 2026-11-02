// Entry point: `BrowserSettingsPanel`, the Settings → Browser page, with the desktop
// preview bridge, the environment and the `preview.importCookies` command stubbed at their modules.
import { render } from "../../../test/render";
import {
  PREVIEW_IMPORT_COOKIES_MAX_COUNT,
  type BrowserCookieReadResult,
  type BrowserImportResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const { ENVIRONMENT_ID } = vi.hoisted(() => ({
  ENVIRONMENT_ID: "environment-server" as EnvironmentId,
}));

const state = vi.hoisted(() => ({
  scopeKind: "all" as "all" | "project",
  canImport: true,
  read: undefined as unknown as BrowserCookieReadResult,
  readBrowserCookies: vi.fn(),
  importCookies: vi.fn(),
  updateScopedSettings: vi.fn(),
}));

const IMPORT_PERMISSION = vi.hoisted(() => ({ importPermission: true }));

vi.mock(import("~/components/preview/previewBridge"), () => ({
  previewBridge: {
    listBrowserImportSources: async () => [
      { id: "zen", name: "Zen", profiles: [{ directory: "abc.default", name: "Default" }] },
    ],
    readBrowserCookies: state.readBrowserCookies,
    importBrowserCookies: () => Promise.reject(new Error("the desktop import must not run")),
  } as never,
}));
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("~/state/environments"), async (original) => {
  const environment = { environmentId: ENVIRONMENT_ID, label: "vigilia-home" };
  return {
    ...(await original()),
    useEnvironments: (() => ({ environments: [environment], isReady: true })) as never,
    usePrimaryEnvironment: (() => environment) as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map([
      [ENVIRONMENT_ID, { environment: { capabilities: { serverBrowser: true } } }],
    ])) as never,
}));
vi.mock(import("~/state/preview"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewEnvironment: {
      ...actual.previewEnvironment,
      importCookies: {
        ...actual.previewEnvironment.importCookies,
        permissionAtom: (() => IMPORT_PERMISSION) as never,
      },
    },
  };
});
vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: unknown, ...rest: never[]) =>
      atom === IMPORT_PERMISSION
        ? state.canImport
        : (actual.useAtomValue as (...args: unknown[]) => unknown)(atom, ...rest)) as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) =>
    command.label === "environment-data:preview:import-cookies"
      ? state.importCookies
      : async () => ({ _tag: "Success", value: undefined })) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useClientSettingsHydrated: () => true,
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_UNIFIED_SETTINGS) : DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdateScopedSettings: () => state.updateScopedSettings,
  useScopedSettingsWriteAllowed: () => true,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: state.scopeKind, environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    connectedEnvironments: [],
    targets: [],
    target: null,
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    description,
    status,
    control,
    resetAction,
    children,
  }: Record<string, ReactNode>) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {status ? <p role="status">{status}</p> : null}
      {control}
      {resetAction}
      {children}
    </div>
  )) as never,
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
}));

import { BrowserSettingsPanel } from "./IntegrationsSettings";

const zenCookies = (count: number): BrowserCookieReadResult["cookies"] =>
  Array.from({ length: count }, (_, index) => ({
    url: "https://zen.example/",
    name: `cookie_${index}`,
    value: "v",
    domain: ".zen.example",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
  }));

function setup(
  over: {
    readonly scopeKind?: "all" | "project";
    readonly canImport?: boolean;
    readonly read?: BrowserCookieReadResult;
    readonly importResults?: ReadonlyArray<BrowserImportResult | Error>;
  } = {},
) {
  state.scopeKind = over.scopeKind ?? "all";
  state.canImport = over.canImport ?? true;
  state.read = over.read ?? { cookies: zenCookies(3), undecryptable: 0, undecryptableHosts: [] };
  state.readBrowserCookies.mockReset().mockImplementation(async () => state.read);
  const results = [...(over.importResults ?? [])];
  state.importCookies.mockReset().mockImplementation(async () => {
    const next = results.shift();
    if (next instanceof Error) return { _tag: "Failure", cause: Cause.fail(next) };
    return { _tag: "Success", value: next };
  });
  state.updateScopedSettings.mockReset();
}

async function openZenImport() {
  await userEvent.click(page.getByRole("button", { name: "Add profile" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Zen" }));
  await expect.element(page.getByRole("heading", { name: "Import from Zen" })).toBeVisible();
}

const serverTile = () => page.getByRole("button", { name: /Server browser on/ });

describe("browser import into the server browser, rendered", () => {
  it("offers the server profile, reads on the desktop and shows the server counts", async () => {
    setup({
      read: { cookies: zenCookies(5), undecryptable: 1, undecryptableHosts: ["locked.example"] },
      importResults: [{ imported: 3, skipped: 2, skippedDomains: ["paypal.com"] }],
    });
    await using _screen = await render(<BrowserSettingsPanel />, {
      router: "/settings/browser",
    });

    await openZenImport();
    await expect.element(serverTile()).toHaveTextContent("DefaultServer browser on vigilia-home");
    await userEvent.click(serverTile());
    await userEvent.click(page.getByRole("button", { name: "Import", exact: true }));

    await expect.element(page.getByRole("heading", { name: "Imported 3 cookies" })).toBeVisible();
    expect(state.readBrowserCookies).toHaveBeenCalledExactlyOnceWith({
      sourceId: "zen",
      sourceProfileDirectory: "abc.default",
    });
    expect(state.importCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: { profileId: "default", cookies: state.read.cookies },
    });
    await expect
      .element(page.getByText(/^Added to Default in .+'s server browser\. 3 cookies skipped\.$/))
      .toBeVisible();
    await expect.element(page.getByText("locked.example and paypal.com")).toBeVisible();
  });

  it("shows the confirmed counts when a later server batch fails", async () => {
    setup({
      read: {
        cookies: zenCookies(PREVIEW_IMPORT_COOKIES_MAX_COUNT + 1),
        undecryptable: 0,
        undecryptableHosts: [],
      },
      importResults: [
        { imported: PREVIEW_IMPORT_COOKIES_MAX_COUNT, skipped: 0, skippedDomains: [] },
        new Error("The environment could not import cookies into this browser profile."),
      ],
    });
    await using _screen = await render(<BrowserSettingsPanel />, {
      router: "/settings/browser",
    });

    await openZenImport();
    await userEvent.click(serverTile());
    await userEvent.click(page.getByRole("button", { name: "Import", exact: true }));

    await expect
      .element(page.getByRole("heading", { name: "Imported 5,000 cookies" }))
      .toBeVisible();
    await expect
      .element(page.getByText(/before the import stopped\. Try again to import the rest\.$/))
      .toBeVisible();
    expect(state.importCookies).toHaveBeenCalledTimes(2);
  });

  it("hides the server target and explains why when the connection cannot import", async () => {
    setup({ canImport: false });
    await using _screen = await render(<BrowserSettingsPanel />, {
      router: "/settings/browser",
    });

    await openZenImport();

    await expect
      .element(
        page.getByText(
          "The server browser isn't offered: this connection lacks permission to use it.",
        ),
      )
      .toBeVisible();
    await expect.element(serverTile()).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /Existing profile/ })).toBeVisible();
  });
});

describe("payment sites setting, rendered", () => {
  it("lists the payment domains and saves an edit to the server setting", async () => {
    setup();
    await using screen = await render(<BrowserSettingsPanel />, {
      router: "/settings/browser",
    });
    const textarea = screen.getByRole("textbox", { name: "Payment sites" });

    await expect
      .element(textarea)
      .toHaveValue(DEFAULT_UNIFIED_SETTINGS.browserPaymentDomains.join("\n"));
    await userEvent.fill(textarea, "PayPal.com\n\nshop.example.test\n");
    await userEvent.click(screen.getByRole("heading", { name: "Payment sites" }));

    expect(state.updateScopedSettings).toHaveBeenCalledExactlyOnceWith({
      browserPaymentDomains: ["paypal.com", "shop.example.test"],
    });
  });

  it("disables payment-site editing in project scope and says to select an environment", async () => {
    setup({ scopeKind: "project" });
    await using screen = await render(<BrowserSettingsPanel />, {
      router: "/settings/browser",
    });

    await expect.element(screen.getByRole("textbox", { name: "Payment sites" })).toBeDisabled();
    await expect
      .element(screen.getByText("Environment-wide setting. Select an environment to change it."))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Reset payment sites to default" }))
      .not.toBeInTheDocument();
  });
});
