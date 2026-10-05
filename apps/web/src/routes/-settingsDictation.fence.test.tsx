// @vitest-environment happy-dom
/**
 * Entry point: the real `/settings/dictation` file route (`settings.dictation.tsx`),
 * mounted under a `/settings` parent the way `routeTree.gen.ts` mounts it, beside
 * the real `SettingsSidebarNav`. The user reaches the page by clicking the nav.
 * The fixture replaces the settings store, the settings scope, and sidebar
 * chrome that needs a live connection; the page and the nav stay real.
 *
 * Phase 2 of the STT redesign, criteria 1–3: the Dictation settings page.
 */
import { DEFAULT_SERVER_SETTINGS, SECRET_SETTING_REDACTION_MARKER } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environmentId: "dictation-settings-laptop",
  dictation: { openAiApiKey: "", vocabularyHints: [] as string[] },
  updates: [] as Array<{ environmentId: string | null; patch: Record<string, unknown> }>,
  /** Every environment the Transcriptions list read jobs for. */
  jobReads: [] as Array<string | null>,
}));

const REDACTION_MARKER = SECRET_SETTING_REDACTION_MARKER;

vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const settings = () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    ...DEFAULT_SERVER_SETTINGS,
    dictation: fixture.dictation,
  });
  const read = (selector?: (value: ReturnType<typeof settings>) => unknown) =>
    selector ? selector(settings()) : settings();
  return {
    ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
    useEnvironmentSettings: (_environmentId: string, selector?: never) => read(selector),
    usePrimarySettings: (selector?: never) => read(selector),
    useUpdateEnvironmentSettings: (environmentId: string) => (patch: Record<string, unknown>) => {
      fixture.updates.push({ environmentId, patch });
    },
    useUpdatePrimarySettings: () => (patch: Record<string, unknown>) => {
      fixture.updates.push({ environmentId: null, patch });
    },
    useClientSettings: (selector?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
    usePrimarySettingsAvailable: () => true,
  };
});
vi.mock("~/components/settings/SettingsScopeContext", () => {
  const environment = {
    environmentId: fixture.environmentId,
    label: "Laptop",
    connection: { phase: "connected" },
  };
  const scope = {
    scope: { kind: "environment", environmentId: fixture.environmentId, label: "Laptop" },
    search: {},
    environment,
    environments: [environment],
    target: null,
    connectedEnvironments: [environment],
    targets: [],
  };
  return { useSettingsScope: () => scope, useOptionalSettingsScope: () => scope };
});
vi.mock("~/state/dictation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/dictation")>()),
  useDictationJobs: (environmentId: string | null) => {
    fixture.jobReads.push(environmentId);
    return { jobs: [], loaded: false };
  },
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));
vi.mock("~/components/settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));
vi.mock("~/components/sidebar/SidebarChrome", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/sidebar/SidebarChrome")>()),
  SidebarUtilityMenu: () => null,
}));
vi.mock("~/components/clerk/T3ConnectSidebarSignIn", () => ({
  T3ConnectSidebarSignIn: () => null,
  T3ConnectSidebarAvatar: () => null,
}));

import {
  closeTranscriptionsList,
  TranscriptionsListHost,
} from "~/components/dictation/TranscriptionsList";
import { SettingsSidebarNav } from "~/components/settings/SettingsSidebarNav";
import { SidebarProvider } from "~/components/ui/sidebar";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { Route as SettingsDictationRoute } from "./settings.dictation";

function SettingsShell() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SidebarProvider>
      <nav data-testid="settings-nav">
        <SettingsSidebarNav pathname={pathname} />
      </nav>
      <main data-testid="settings-page">
        <Outlet />
      </main>
      {/* `__root.tsx` mounts this through the CommandPalette on every page. */}
      <TranscriptionsListHost />
    </SidebarProvider>
  );
}

function createSettingsRouter() {
  const root = createRootRoute({ component: SettingsShell });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings" });
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => settings, path, component: () => <p>{text}</p> });
  const dictation = (SettingsDictationRoute as unknown as typeof settings).update({
    id: "/dictation",
    path: "/dictation",
    getParentRoute: () => settings,
  } as never);
  return createRouter({
    routeTree: root.addChildren([
      settings.addChildren([
        page("/general", "General settings page"),
        page("/providers", "Providers settings page"),
        dictation,
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
  });
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createSettingsRouter> | undefined;

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountSettings(): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  router = createSettingsRouter();
  await router.load();
  await act(async () => {
    root = createRoot(container!);
    const { RouterProvider } = await import("@tanstack/react-router");
    // `AppRoot` provides the app registry that dialog hosts such as Transcriptions read.
    root.render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router!} />
      </AppAtomRegistryProvider>,
    );
  });
  await settle();
}

function navButton(label: string): HTMLElement {
  const nav = document.querySelector('[data-testid="settings-nav"]')!;
  const button = [...nav.querySelectorAll<HTMLElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(
    button,
    `Expected a nav entry named ${label}; nav: ${[...nav.querySelectorAll("button")].map((b) => b.textContent)}`,
  ).toBeDefined();
  return button!;
}

/**
 * The router plugin code-splits route components, so the first visit to a
 * page waits on a lazy import; a fixed number of ticks is not enough.
 */
async function settleRouter(): Promise<void> {
  await settle();
  for (let round = 0; round < 100 && router!.state.status !== "idle"; round += 1) {
    await settle();
  }
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settleRouter();
}

async function openDictationPage(): Promise<HTMLElement> {
  await mountSettings();
  await click(navButton("Dictation"));
  expect(router!.state.location.pathname).toBe("/settings/dictation");
  return document.querySelector<HTMLElement>('[data-testid="settings-page"]')!;
}

function keyField(page: HTMLElement): HTMLInputElement {
  const field = page.querySelector<HTMLInputElement>('input[type="password"]');
  expect(field, `Expected a password field; page: ${page.textContent}`).not.toBeNull();
  return field!;
}

function hintsField(page: HTMLElement): HTMLTextAreaElement {
  const field = page.querySelector<HTMLTextAreaElement>("textarea");
  expect(field, `Expected a vocabulary hints text area; page: ${page.textContent}`).not.toBeNull();
  return field!;
}

function saveButtonFor(field: HTMLElement): HTMLElement {
  const scope = field.closest("form, section") ?? document.body;
  const button = [...scope.querySelectorAll<HTMLElement>("button")].find((candidate) =>
    /save/i.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? ""),
  );
  expect(
    button,
    `Expected a Save button near the field; scope: ${scope.textContent}`,
  ).toBeDefined();
  return button!;
}

async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    field.focus();
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function buttonNamed(scope: ParentNode, name: string): HTMLElement | undefined {
  return [...scope.querySelectorAll<HTMLElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
}

function dictationPatches(): Array<Record<string, unknown>> {
  return fixture.updates
    .map((update) => update.patch.dictation)
    .filter((patch): patch is Record<string, unknown> => patch !== undefined);
}

beforeEach(() => {
  fixture.dictation = { openAiApiKey: "", vocabularyHints: [] };
  fixture.updates = [];
  fixture.jobReads = [];
});

afterEach(async () => {
  closeTranscriptionsList();
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  router = undefined;
  vi.unstubAllGlobals();
});

describe("dictation settings guards", () => {
  it("dictation settings guard: the settings navigation still lists the existing sections and opens Providers", async () => {
    await mountSettings();
    for (const label of ["General", "Providers", "Integrations", "Connections", "Archive"]) {
      navButton(label);
    }
    await click(navButton("Providers"));
    expect(router!.state.location.pathname).toBe("/settings/providers");
    expect(document.body.textContent).toContain("Providers settings page");
  });
});

describe("dictation settings page (criterion 1: OpenAI key)", () => {
  it("dictation settings: the settings navigation lists Dictation and opens a page with a password field", async () => {
    const page = await openDictationPage();
    expect(keyField(page).type).toBe("password");
  });

  it("dictation settings: saving a typed OpenAI key sends it in one server settings update for the environment", async () => {
    const page = await openDictationPage();
    await typeInto(keyField(page), "sk-proj-fence-key");
    await click(saveButtonFor(keyField(page)));

    expect(fixture.updates).toHaveLength(1);
    expect(fixture.updates[0]!.environmentId).toBe(fixture.environmentId);
    expect(dictationPatches()[0]).toMatchObject({ openAiApiKey: "sk-proj-fence-key" });
  });

  it("dictation settings: a stored key is never shown in the password field", async () => {
    fixture.dictation = { openAiApiKey: REDACTION_MARKER, vocabularyHints: [] };
    const page = await openDictationPage();
    expect(keyField(page).value).toBe("");
  });
});

describe("dictation settings page (criterion 2: configured status)", () => {
  it("dictation settings: the page reports a configured key when the stored value is the redaction marker", async () => {
    fixture.dictation = { openAiApiKey: REDACTION_MARKER, vocabularyHints: [] };
    const page = await openDictationPage();
    expect(page.textContent).toMatch(/configured/i);
    expect(page.textContent).not.toMatch(/not configured/i);
  });

  it("dictation settings: the page reports no key when the stored key is empty", async () => {
    const page = await openDictationPage();
    expect(page.textContent).toMatch(/not configured/i);
  });

  it("dictation settings: a stored value other than the redaction marker does not count as configured", async () => {
    fixture.dictation = { openAiApiKey: "sk-not-a-marker", vocabularyHints: [] };
    const page = await openDictationPage();
    expect(page.textContent).toMatch(/not configured/i);
    expect(keyField(page).value).toBe("");
    expect(page.textContent).not.toContain("sk-not-a-marker");
  });
});

describe("dictation settings page (criterion 3: vocabulary hints)", () => {
  it("dictation settings: stored vocabulary hints show as one text field, one hint per line", async () => {
    fixture.dictation = { openAiApiKey: "", vocabularyHints: ["Mesura", "Symmetria", "Hyprland"] };
    const page = await openDictationPage();
    expect(hintsField(page).value).toBe("Mesura\nSymmetria\nHyprland");
  });

  it("dictation settings: saving vocabulary hints sends one list entry per non-empty line and keeps the stored key", async () => {
    fixture.dictation = { openAiApiKey: REDACTION_MARKER, vocabularyHints: [] };
    const page = await openDictationPage();
    await typeInto(hintsField(page), "Mesura\n  Hyprland  \n\nVigilia\n");
    await click(saveButtonFor(hintsField(page)));

    const patch = dictationPatches().at(-1);
    expect(patch?.vocabularyHints).toEqual(["Mesura", "Hyprland", "Vigilia"]);
    // An empty key in the patch would delete the stored key on the server.
    expect([undefined, REDACTION_MARKER]).toContain(patch?.openAiApiKey);
  });
});

describe("dictation settings page (review P2-1: removing the key)", () => {
  it("dictation settings: Remove key deletes a configured key with an empty-key update", async () => {
    fixture.dictation = { openAiApiKey: REDACTION_MARKER, vocabularyHints: [] };
    const page = await openDictationPage();
    const remove = buttonNamed(page, "Remove key");
    expect(remove, `Expected a Remove key button; page: ${page.textContent}`).toBeDefined();
    await click(remove!);

    expect(fixture.updates).toHaveLength(1);
    expect(fixture.updates[0]!.environmentId).toBe(fixture.environmentId);
    expect(dictationPatches()[0]).toEqual({ openAiApiKey: "" });
  });

  it("dictation settings: Remove key is offered only when a key is configured", async () => {
    const page = await openDictationPage();
    expect(buttonNamed(page, "Remove key")).toBeUndefined();
  });
});

describe("dictation settings page (review P1-2: Transcriptions entry)", () => {
  it("dictation settings: Show transcriptions opens the list for the page's environment", async () => {
    const page = await openDictationPage();
    const show = buttonNamed(page, "Show transcriptions");
    expect(show, `Expected a Show transcriptions button; page: ${page.textContent}`).toBeDefined();
    await click(show!);

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Transcriptions");
    expect(fixture.jobReads).toContain(fixture.environmentId);
    expect(fixture.jobReads).not.toContain(null);
  });
});
