import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  installThreadLinkEnvironment,
  linkEnvelope,
  mountThreadLinkStream,
} from "~/test/threadLinkFixture";
import { resetPreviewStateForTests } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  openTerminalLinkInPreview,
  TerminalLinkPreviewOpenError,
} from "./openTerminalLinkInPreview";

vi.mock("~/assets/assetUrls", () => ({ resolveAssetUrl: vi.fn() }));
vi.mock("~/browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: () => undefined,
}));
vi.mock("~/state/server", async () => ({
  environmentServerConfigsAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture
    .configs,
}));
vi.mock("~/connection/catalog", async () => {
  const f = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  return { environmentCatalog: { catalogValueAtom: f.catalog, stateAtom: f.connection } };
});
vi.mock("~/state/preview", async () => ({
  previewEnvironment: {
    open: "open",
    openLinkTarget: {
      permissionAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture.permission,
    },
  },
}));
vi.mock("~/state/session", async () => {
  const f = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const Option = await import("effect/Option");
  return {
    environmentSession: { preparedConnectionValueAtom: f.prepared },
    readPreparedConnection: (id: import("@t3tools/contracts").EnvironmentId) =>
      Option.getOrNull(appAtomRegistry.get(f.prepared(id))),
    readEnvironmentScope: () => true,
  };
});
const browserDefaultsMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: browserDefaultsMocks.resolve,
  browserDefaultOpenViewport: (defaults: { viewport: unknown }) => defaults.viewport,
  browserDefaultOpenProfileId: (defaults: { profileId: string }) => defaults.profileId,
}));

const linkTargetMocks = vi.hoisted(() => ({
  preference: vi.fn<() => "system" | "app" | Promise<"system" | "app">>(),
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: async () => {
    savedTarget.value = await linkTargetMocks.preference();
  },
  getClientSettings: () => ({ browserLinkTarget: savedTarget.value }),
}));
const savedTarget = vi.hoisted(() => ({ value: "app" as "app" | "system" }));

const hydratedDefaults = {
  viewport: { _tag: "freeform", width: 1280, height: 720 } as const,
  profileId: "work",
};

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

let stopTransport: () => void;
let viewportWidth = 1280;
let primaryPointerCoarse = false;

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
    pendingMaximizeThreadKey: null,
  });
  installThreadLinkEnvironment(threadRef);
  stopTransport = mountThreadLinkStream(threadRef);
  viewportWidth = 1280;
  primaryPointerCoarse = false;
  vi.stubGlobal("window", {
    get innerWidth() {
      return viewportWidth;
    },
    matchMedia: () => ({ matches: primaryPointerCoarse }),
  });
  browserDefaultsMocks.resolve.mockReset();
  browserDefaultsMocks.resolve.mockResolvedValue(hydratedDefaults);
  linkTargetMocks.preference.mockReturnValue("app");
});

afterEach(() => {
  stopTransport();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("openTerminalLinkInPreview", () => {
  it.each(["target", "defaults"] as const)(
    "does not open either browser when reading %s fails",
    async (setting) => {
      const failure = new Error("Settings read failed");
      if (setting === "target") {
        linkTargetMocks.preference.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        browserDefaultsMocks.resolve.mockRejectedValueOnce(failure);
      }
      const fallbackToBrowser = vi.fn();
      const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));

      await expect(
        openTerminalLinkInPreview({
          url: "https://example.com/docs",
          threadRef,
          allocate: openPreview,
          fallbackToBrowser,
          forceBrowser: false,
        }),
      ).rejects.toBe(failure);
      expect(fallbackToBrowser).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
    },
  );

  it("opens in the system browser while that is the configured target", async () => {
    linkTargetMocks.preference.mockReturnValue("system");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));

    await openTerminalLinkInPreview({
      url: "http://localhost:3000/",
      threadRef,
      allocate: openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("opens public URLs in-app too, not only local servers", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      allocate: openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(openPreview).toHaveBeenCalledOnce();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("waits for hydrated viewport and profile defaults before opening", async () => {
    let hydrate: ((defaults: typeof hydratedDefaults) => void) | undefined;
    browserDefaultsMocks.resolve.mockImplementationOnce(
      () =>
        new Promise<typeof hydratedDefaults>((resolve) => {
          hydrate = resolve;
        }),
    );
    const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));

    const opening = openTerminalLinkInPreview({
      url: "http://localhost:3000/",
      threadRef,
      allocate: openPreview,
      fallbackToBrowser: vi.fn(),
      forceBrowser: false,
    });

    await vi.waitFor(() => expect(browserDefaultsMocks.resolve).toHaveBeenCalledOnce());
    expect(openPreview).not.toHaveBeenCalled();
    hydrate?.(hydratedDefaults);
    await opening;

    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        threadId: "thread-1",
        viewport: hydratedDefaults.viewport,
        profileId: hydratedDefaults.profileId,
      },
    });
  });

  it("preserves the complete preview failure cause before falling back", async () => {
    const rpcError = new Error("preview unavailable");
    const cause = Cause.combine(Cause.fail(rpcError), Cause.die("preview defect"));
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://127.0.0.1:5173/",
      threadRef,
      allocate: async () => AsyncResult.failure(cause),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    const error = reportError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(TerminalLinkPreviewOpenError);
    expect(error).toMatchObject({
      environmentId: "local",
      threadId: "thread-1",
      targetOrigin: "http://127.0.0.1:5173",
      cause,
    });
    expect(error.message).not.toContain("preview unavailable");
  });

  it("does not report or fall back when opening the preview is interrupted", async () => {
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      threadRef,
      allocate: async () => AsyncResult.failure(Cause.interrupt()),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("opens in the system browser when Ctrl or Command is held", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      allocate: openPreview,
      fallbackToBrowser,
      forceBrowser: true,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
  });
});

it.each([
  [767, false],
  [1280, true],
] as const)(
  "terminal link policy: width %s coarse %s never allocates a preview",
  async (width, coarse) => {
    viewportWidth = width;
    primaryPointerCoarse = coarse;
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));
    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      allocate: openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });
    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
    expect(browserDefaultsMocks.resolve).not.toHaveBeenCalled();
  },
);

it("terminal link policy: rechecks the viewport after saved target hydration", async () => {
  let release = () => {};
  linkTargetMocks.preference.mockImplementationOnce(
    () =>
      new Promise<"app">((resolve) => {
        release = () => resolve("app");
      }),
  );
  const fallbackToBrowser = vi.fn();
  const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));
  const opening = openTerminalLinkInPreview({
    url: "https://example.com/docs",
    threadRef,
    allocate: openPreview,
    fallbackToBrowser,
    forceBrowser: false,
  });
  viewportWidth = 767;
  release();
  await opening;
  expect(fallbackToBrowser).toHaveBeenCalledOnce();
  expect(openPreview).not.toHaveBeenCalled();
});

it.each(["mailto:hello@example.com", "vscode://file/work", "not a URL"])(
  "terminal link policy: nonweb %s skips preview and unrelated settings",
  async (url) => {
    linkTargetMocks.preference.mockClear();
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(linkEnvelope(threadRef)));
    await openTerminalLinkInPreview({
      url,
      threadRef,
      allocate: openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });
    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
    expect(linkTargetMocks.preference).not.toHaveBeenCalled();
  },
);
