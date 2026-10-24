// Entry point: the public CodexSetupSection used by Welcome and provider settings.
// Every command and query is controlled here. No provider or shell operation runs.
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ChatGptHandoffInput,
  type ChatGptHandoffState,
  type ChatGptTransferredProfile,
  type ProviderAuthState,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { act, render as renderBrowser, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { CodexSetupSection } from "./CodexSetupSection";

type HandoffTarget = { environmentId: EnvironmentId; input: ChatGptHandoffInput };
type Query = { kind: "auth" | "install" | "handoff" };
const fixture = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  install: null as ProviderInstallState | null,
  handoff: null as ChatGptHandoffState | null,
  handoffError: null as Error | null,
  remote: false,
  primary: null as EnvironmentId | null,
  handoffQuery: vi.fn<(target: HandoffTarget) => Query>(),
  commands: {
    startProviderAuth: vi.fn(),
    refreshProviders: vi.fn(),
    completeProviderAuth: vi.fn(),
    cancelProviderAuth: vi.fn(),
    logoutProviderAuth: vi.fn(),
    startProviderInstall: vi.fn(),
    cancelProviderInstall: vi.fn(),
    chatGptReconnectProfile: vi.fn(),
    chatGptImportProfile: vi.fn(),
  },
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  consumed: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: () => ({ kind: "auth" }),
    providerInstallState: () => ({ kind: "install" }),
    chatGptHandoffState: fixture.handoffQuery,
    ...fixture.commands,
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: Query | null) => ({
    data:
      query?.kind === "auth"
        ? fixture.auth
        : query?.kind === "install"
          ? fixture.install
          : query?.kind === "handoff"
            ? fixture.handoff
            : null,
    error: query?.kind === "handoff" ? fixture.handoffError : null,
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentHttpBaseUrl: (id: EnvironmentId | null) =>
    id === fixture.primary || !fixture.remote ? "http://127.0.0.1:4100" : "https://fixture.invalid",
  usePrimaryEnvironmentId: () => fixture.primary,
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: fixture.openExternal } }),
}));
vi.mock("./ChatGptUsageButton", () => ({ ChatGptUsageButton: () => null }));
vi.mock("./ChatGptAccountPicker", () => ({ ChatGptAccountPicker: () => null }));
vi.mock("./AddCodexAccountDialog", () => ({ AddCodexAccountDialog: () => null }));
// These cases use the onboarding presentation, which does not render SettingsRow.
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null }));

const environmentId = EnvironmentId.make("phase3-destination");
const primaryId = EnvironmentId.make("phase3-primary");
const instanceId = ProviderInstanceId.make("codex");
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const profile: ChatGptTransferredProfile = {
  registration: { clientId: "oaiapp_phase3_fixture" },
  credentials: {
    clientId: "oaiapp_phase3_fixture",
    accessToken: "fixture-access",
    refreshToken: null,
    idToken: "fixture-id",
    issuer: "https://fixture.invalid",
    expiresAt: 0,
    earliestRefreshAt: null,
    scopes: [],
    subject: "fixture-subject",
    email: null,
  },
};
function provider(authenticated = false) {
  return decodeProvider({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: authenticated ? "authenticated" : "unauthenticated" },
    checkedAt: "2026-04-10T00:00:00.000Z",
    models: [],
    setup: { canInstall: true, canAuthenticate: true },
  });
}
function receipt(phase: ProviderAuthState["phase"]): ProviderAuthState {
  return {
    instanceId,
    phase,
    flowId: "fixture-flow",
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<A>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let root: Screen;
let container: HTMLDivElement;
let authenticated: boolean;
let autoStart: boolean;
let strict: boolean;
async function render() {
  await act(async () => {
    const content = (
      <CodexSetupSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={provider(authenticated)}
        mode="managed"
        enabled
        presentation="onboarding"
        onModeChange={() => undefined}
        autoStart={autoStart}
        onAutoStartConsumed={fixture.consumed}
      />
    );
    await root.rerender(strict ? <StrictMode>{content}</StrictMode> : content);
  });
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}. ${container.textContent}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function startHandoff() {
  fixture.remote = true;
  fixture.primary = primaryId;
  fixture.commands.chatGptReconnectProfile.mockResolvedValue(
    AsyncResult.success(profile.registration),
  );
  await render();
  await click("Continue with ChatGPT");
  expect(fixture.handoffQuery).toHaveBeenCalledWith({
    environmentId: primaryId,
    input: {
      instanceId,
      environmentId,
      attemptId: expect.any(String),
      returnUrl: window.location.href,
      profile: profile.registration,
    },
  });
}
async function setupBrowserFixture0() {
  vi.resetAllMocks();

  vi.stubGlobal("desktopBridge", undefined);
  fixture.auth = receipt("idle");
  fixture.install = {
    driver: ProviderDriverKind.make("codex"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: "1.0.0",
    installedVersion: "1.0.0",
    canRemove: false,
    message: null,
    source: "local",
  };
  fixture.handoff = null;
  fixture.handoffError = null;
  fixture.remote = false;
  fixture.primary = null;
  fixture.handoffQuery.mockReturnValue({ kind: "handoff" });
  fixture.openExternal.mockResolvedValue(undefined);
  fixture.commands.refreshProviders.mockResolvedValue(AsyncResult.success(undefined));
  authenticated = false;
  autoStart = false;
  strict = false;
  container = document.createElement("div");
  document.body.append(container);
  root = await renderBrowser(null, { container, router: false });

  return {
    async [Symbol.asyncDispose]() {
      await root[Symbol.asyncDispose]();
      container.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    },
  };
}

describe("phase3 Codex auth lifecycle", () => {
  it.each(["failed", "cancelled"] as const)(
    "retains the new request after the previous %s receipt",
    async (phase) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      fixture.auth = receipt(phase);
      fixture.commands.startProviderAuth.mockResolvedValue(AsyncResult.success(undefined));
      await render();
      await click("Continue with ChatGPT");
      expect(fixture.commands.startProviderAuth).toHaveBeenCalledWith({
        environmentId,
        input: {
          instanceId,
          methodId: "chatgpt",
          returnUrl: window.location.href,
          callbackMode: "server",
        },
      });
      fixture.auth = receipt("succeeded");
      await render();
      expect(container.textContent).toContain("Finishing sign-in...");
      expect(fixture.commands.refreshProviders).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId },
      });
      authenticated = true;
      await render();
      expect(container.textContent).toContain("Ready");
      expect(container.textContent).not.toContain("Finishing sign-in...");
    },
  );

  it.each(["receipt-first", "snapshot-first"] as const)(
    "accepts independent auth and provider updates: %s",
    async (order) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      fixture.commands.startProviderAuth.mockResolvedValue(AsyncResult.success(undefined));
      await render();
      await click("Continue with ChatGPT");
      if (order === "receipt-first") {
        fixture.auth = receipt("succeeded");
        await render();
        expect(container.textContent).toContain("Finishing sign-in...");
        expect(fixture.commands.refreshProviders).toHaveBeenCalledTimes(1);
      } else {
        authenticated = true;
        await render();
        expect(container.textContent).toContain("Ready");
      }
      authenticated = true;
      fixture.auth = receipt("succeeded");
      await render();
      expect(container.textContent).toContain("Ready");
      expect(container.textContent).not.toContain("Finishing sign-in...");
      expect(fixture.commands.refreshProviders).toHaveBeenCalledTimes(
        order === "receipt-first" ? 1 : 0,
      );
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "reports the primary handoff %s receipt and permits a new attempt",
    async (phase) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await startHandoff();
      const firstAttempt = fixture.handoffQuery.mock.lastCall?.[0].input.attemptId;
      fixture.handoff = {
        phase: "auth",
        state: { ...receipt(phase), message: "Controlled primary failure" },
      };
      await render();
      expect(container.textContent).toContain("Controlled primary failure");
      expect(button("Continue with ChatGPT").disabled).toBe(false);
      expect(fixture.commands.chatGptImportProfile).not.toHaveBeenCalled();
      fixture.handoff = null;
      await click("Continue with ChatGPT");
      expect(fixture.commands.chatGptReconnectProfile).toHaveBeenCalledTimes(2);
      expect(fixture.handoffQuery.mock.lastCall?.[0].input.attemptId).not.toBe(firstAttempt);
      expect(container.textContent).not.toContain("Controlled primary failure");
    },
  );

  it("imports retained finished handoff data before disposing a later query error", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const imported = deferred<AsyncResult.Success<void>>();
    fixture.commands.chatGptImportProfile.mockReturnValue(imported.promise);
    await startHandoff();
    fixture.handoff = { phase: "finished", profile };
    fixture.handoffError = new Error("Controlled stale-query error");
    await render();
    expect(fixture.commands.chatGptImportProfile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, profile },
    });
    expect(container.textContent).toContain(
      "ChatGPT sign-in on the primary environment was interrupted. Try again.",
    );
    await act(async () => {
      imported.resolve(AsyncResult.success(undefined));
      await imported.promise;
    });
    expect(container.textContent).toContain("Finishing sign-in...");
    await render();
    expect(fixture.commands.chatGptImportProfile).toHaveBeenCalledTimes(1);
    authenticated = true;
    await render();
    expect(container.textContent).toContain("Ready");
  });

  it("consumes auto-start UI state while pendingRef guards StrictMode dispatch", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const started = deferred<AsyncResult.Success<void>>();
    fixture.commands.startProviderAuth.mockReturnValue(started.promise);
    autoStart = true;
    strict = true;
    await render();
    expect(fixture.commands.startProviderAuth).toHaveBeenCalledTimes(1);
    expect(button("Open sign-in page").disabled).toBe(true);
    await act(async () => {
      started.reject(new Error("Controlled request rejection"));
      await started.promise.catch(() => undefined);
    });
    expect(container.textContent).toContain("Codex setup failed. Try again.");
    expect(button("Continue with ChatGPT").disabled).toBe(false);
    fixture.auth = receipt("idle");
    await render();
    expect(fixture.commands.startProviderAuth).toHaveBeenCalledTimes(1);
    expect(fixture.commands.startProviderInstall).not.toHaveBeenCalled();
  });

  it("reports effect-only browser opening failures and retains the explicit retry callback", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.commands.startProviderAuth.mockResolvedValue(AsyncResult.success(undefined));
    fixture.openExternal.mockRejectedValueOnce(new Error("Controlled shell rejection"));
    await render();
    await click("Continue with ChatGPT");
    const url = "https://fixture.invalid/authorize";
    fixture.auth = { ...receipt("waiting"), authorizationUrl: url };
    await render();
    expect(fixture.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(container.textContent).toContain("Could not finish sign-in on this computer.");
    await render();
    expect(fixture.openExternal).toHaveBeenCalledTimes(1);
    await click("Open sign-in page");
    expect(fixture.openExternal).toHaveBeenNthCalledWith(2, url);
    expect(fixture.commands.completeProviderAuth).not.toHaveBeenCalled();
  });

  it("discards a cancelled desktop callback and completes the explicitly reopened current flow", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const oldCallback = deferred<string>();
    const currentCallback = deferred<string>();
    const receive = vi
      .fn<(url: string) => Promise<string>>()
      .mockReturnValueOnce(oldCallback.promise)
      .mockReturnValueOnce(currentCallback.promise);
    const cancel = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("desktopBridge", {
      receiveProviderAuthCallback: receive,
      cancelProviderAuthCallback: cancel,
    });
    fixture.commands.startProviderAuth.mockResolvedValue(AsyncResult.success(undefined));
    fixture.commands.completeProviderAuth.mockResolvedValue(AsyncResult.success(undefined));
    await render();
    await click("Continue with ChatGPT");
    const oldUrl = "https://fixture.invalid/old-authorization";
    fixture.auth = { ...receipt("waiting"), authorizationUrl: oldUrl };
    await render();
    expect(receive).toHaveBeenCalledExactlyOnceWith(oldUrl);
    const currentUrl = "https://fixture.invalid/current-authorization";
    fixture.auth = { ...receipt("waiting"), flowId: "current-flow", authorizationUrl: currentUrl };
    await render();
    expect(cancel).toHaveBeenCalledWith(oldUrl);
    await act(async () => {
      oldCallback.resolve("http://localhost/auth/callback?code=old-fixture");
      await oldCallback.promise;
    });
    expect(fixture.commands.completeProviderAuth).not.toHaveBeenCalled();
    await click("Open sign-in page");
    expect(receive).toHaveBeenNthCalledWith(2, currentUrl);
    const callbackUrl = "http://localhost/auth/callback?code=current-fixture";
    await act(async () => {
      currentCallback.resolve(callbackUrl);
      await currentCallback.promise;
    });
    expect(fixture.commands.completeProviderAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, flowId: "current-flow", callbackUrl },
    });
    fixture.auth = receipt("succeeded");
    authenticated = true;
    await render();
    expect(container.textContent).toContain("Ready");
    expect(fixture.openExternal).not.toHaveBeenCalled();
  });
});
