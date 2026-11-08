import { describe, expect, it, vi } from "vite-plus/test";
import type { BrowserImportSource } from "@t3tools/contracts";
import {
  authScopeRequiredResponse,
  EnvironmentAuthorizationError,
  PREVIEW_IMPORT_COOKIES_MAX_COUNT,
} from "@t3tools/contracts";

import {
  formatImportResult,
  formatPaymentDomainsText,
  importIntoServerProfile,
  initialWizardStep,
  initialTargetSelection,
  outcomeToStep,
  parsePaymentDomainsText,
  paymentDomainsPatch,
  refreshedSourceProfileDirectory,
  resolveWizardTarget,
  serverImportTargetNotice,
  serverImportTargetProfiles,
} from "./browserImportWizard.logic";

describe("wizard target selection", () => {
  it("treats an existing profile whose id is new as an existing target", () => {
    const profiles = [{ id: "new", name: "Existing new" }];
    const selection = initialTargetSelection(false, profiles);

    expect(selection).toEqual({ kind: "existing", profileId: "new" });
    expect(resolveWizardTarget(selection, "generated", profiles)).toEqual({
      kind: "existing",
      profileId: "new",
      name: "Existing new",
    });
  });

  it("rejects an existing target that is no longer listed", () => {
    expect(
      resolveWizardTarget({ kind: "existing", profileId: "removed" }, "generated", [
        { id: "default", name: "Default" },
      ]),
    ).toBeUndefined();
  });
});

const source = (over: Partial<BrowserImportSource> = {}): BrowserImportSource => ({
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "You" }],
  ...over,
});

describe("initialWizardStep", () => {
  it("handles source availability before checking its profiles", () => {
    expect(
      initialWizardStep(source({ profiles: [], unavailable: "needsKeychainApproval" })),
    ).toEqual({ step: "blocked", reason: "needsKeychainApproval" });
  });
});

describe("refreshedSourceProfileDirectory", () => {
  const refreshed = source({
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work" },
    ],
  });

  it("preserves a selected non-first profile after the browser quits", () => {
    expect(refreshedSourceProfileDirectory("Profile 2", refreshed)).toBe("Profile 2");
  });

  it("falls back only when the old profile vanished and clears an empty result", () => {
    expect(refreshedSourceProfileDirectory("Removed", refreshed)).toBe("Default");
    expect(refreshedSourceProfileDirectory("Removed", source({ profiles: [] }))).toBe("");
  });
});

// Phase 3 fence. Entry point: `BrowserProfilesSetting` in IntegrationsSettings.tsx passes these
// helpers' results to `BrowserImportWizard`; the plan accepts logic tests for this phase.
const desktopDomainCookie = {
  url: "https://zen.example/",
  name: "domain_cookie",
  value: "a",
  domain: ".zen.example",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax" as const,
};

const zenRead = (count: number, over: { undecryptable?: number; hosts?: string[] } = {}) => ({
  cookies: Array.from({ length: count }, (_, index) => ({
    ...desktopDomainCookie,
    name: `cookie_${index}`,
  })),
  undecryptable: over.undecryptable ?? 0,
  undecryptableHosts: over.hosts ?? [],
});

const serverTarget = { kind: "server", profileId: "default", name: "Default" } as const;

const allowed = () => true;

describe("server import target profiles", () => {
  const profiles = [
    { id: "default", name: "Default", kind: "persistent" },
    { id: "incognito", name: "Incognito", kind: "incognito" },
    { id: "profile-work", name: "Work", kind: "persistent" },
  ] as const;

  it("offers the server's persistent profiles when its browser is available", () => {
    expect(serverImportTargetProfiles(true, profiles)).toEqual([
      { id: "default", name: "Default" },
      { id: "profile-work", name: "Work" },
    ]);
  });

  it("offers no server profiles when the server browser is unavailable", () => {
    expect(serverImportTargetProfiles(false, profiles)).toEqual([]);
  });

  it("resolves a listed server profile into a server target", () => {
    expect(
      resolveWizardTarget(
        { kind: "server", profileId: "profile-work" },
        "generated",
        [{ id: "profile-work", name: "Work (desktop)" }],
        [{ id: "profile-work", name: "Work" }],
      ),
    ).toEqual({ kind: "server", profileId: "profile-work", name: "Work" });
  });

  it("rejects a server target the server no longer lists, even when the desktop has it", () => {
    expect(
      resolveWizardTarget(
        { kind: "server", profileId: "profile-work" },
        "generated",
        [{ id: "profile-work", name: "Work" }],
        [{ id: "default", name: "Default" }],
      ),
    ).toBeUndefined();
  });
});

describe("importIntoServerProfile", () => {
  it("reads on the desktop, then sends the cookies with previewImportCookies", async () => {
    const calls: string[] = [];
    const read = zenRead(2);
    const readCookies = vi.fn(async () => {
      calls.push("read");
      return read;
    });
    const importCookies = vi.fn(async () => {
      calls.push("import");
      return { imported: 2, skipped: 0, skippedDomains: [] };
    });

    await importIntoServerProfile(
      { canImport: allowed, readCookies, importCookies },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(calls).toEqual(["read", "import"]);
    expect(readCookies).toHaveBeenCalledExactlyOnceWith({
      sourceId: "zen",
      sourceProfileDirectory: "abc.default",
    });
    expect(importCookies).toHaveBeenCalledExactlyOnceWith({
      profileId: "default",
      cookies: read.cookies,
    });
  });

  it("splits a large server import into batches the RPC accepts and sums them", async () => {
    const importCookies = vi.fn(async ({ cookies }: { cookies: ReadonlyArray<unknown> }) => ({
      imported: cookies.length,
      skipped: 0,
      skippedDomains: [],
    }));

    const outcome = await importIntoServerProfile(
      {
        canImport: allowed,
        readCookies: async () => zenRead(PREVIEW_IMPORT_COOKIES_MAX_COUNT + 1),
        importCookies,
      },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(importCookies.mock.calls.map(([input]) => input.cookies.length)).toEqual([
      PREVIEW_IMPORT_COOKIES_MAX_COUNT,
      1,
    ]);
    expect(outcome).toMatchObject({
      kind: "imported",
      imported: PREVIEW_IMPORT_COOKIES_MAX_COUNT + 1,
    });
  });

  it("does not call the server when the desktop read fails, and keeps the read reason", async () => {
    const importCookies = vi.fn();

    const outcome = await importIntoServerProfile(
      {
        canImport: allowed,
        readCookies: async () => {
          throw new Error("Importing cookies from zen failed: browserRunning.");
        },
        importCookies,
      },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(importCookies).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "blocked", reason: "browserRunning" });
    expect(outcomeToStep(outcome)).toEqual({ step: "quit" });
  });

  it("reports a server refusal as a profile that could not be opened", async () => {
    const outcome = await importIntoServerProfile(
      {
        canImport: allowed,
        readCookies: async () => zenRead(1),
        importCookies: async () => {
          throw new Error("This environment has no browser profile with that id.");
        },
      },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(outcome).toEqual({ kind: "blocked", reason: "sessionUnavailable" });
  });
});

describe("server import result", () => {
  it("shows imported, skipped and skipped-domain counts from the server result", async () => {
    const outcome = await importIntoServerProfile(
      {
        canImport: allowed,
        readCookies: async () => zenRead(5, { undecryptable: 1, hosts: ["locked.example"] }),
        importCookies: async () => ({
          imported: 3,
          skipped: 2,
          skippedDomains: ["paypal.com", "checkout.stripe.com"],
        }),
      },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(outcome).toMatchObject({
      kind: "imported",
      imported: 3,
      skipped: 3,
      skippedDomains: ["locked.example", "paypal.com", "checkout.stripe.com"],
      targetName: "Default",
    });
    const step = outcomeToStep(outcome);
    if (step.step !== "done") throw new Error(`expected the done step, got ${step.step}`);
    expect(formatImportResult(step, "vigilia-home")).toEqual({
      title: "Imported 3 cookies",
      description: "Added to Default in vigilia-home's server browser. 3 cookies skipped.",
      skippedDomains: "locked.example, paypal.com and checkout.stripe.com",
    });
  });

  it("keeps the desktop result wording for a desktop profile import", () => {
    expect(
      formatImportResult(
        { imported: 1, skipped: 2, skippedDomains: ["a.example"], targetName: "Work" },
        "laptop",
      ),
    ).toEqual({
      title: "Imported 1 cookie",
      description: "Added to Work for laptop. 2 cookies skipped.",
      skippedDomains: "a.example",
    });
    expect(
      formatImportResult(
        { imported: 0, skipped: 0, skippedDomains: [], targetName: "Work" },
        "laptop",
      ),
    ).toEqual({
      title: "No cookies found",
      description: "There were no cookies to import for laptop.",
      skippedDomains: "",
    });
  });
});

describe("payment domain list", () => {
  it("parses one domain per line, trimmed, lowercased, without empty lines", () => {
    expect(parsePaymentDomainsText("  PayPal.com \n\n checkout.STRIPE.com\n   \n")).toEqual([
      "paypal.com",
      "checkout.stripe.com",
    ]);
  });

  it("shows the saved list one domain per line", () => {
    expect(formatPaymentDomainsText(["paypal.com", "pay.google.com"])).toBe(
      "paypal.com\npay.google.com",
    );
  });

  it("saves an edit to the browserPaymentDomains server setting and skips a no-op", () => {
    expect(paymentDomainsPatch("paypal.com\nShop.Example.test", ["paypal.com"])).toEqual({
      browserPaymentDomains: ["paypal.com", "shop.example.test"],
    });
    expect(paymentDomainsPatch(" PayPal.com \n", ["paypal.com"])).toBeUndefined();
  });
});

describe("desktop import path guards", () => {
  it("keeps a new desktop profile as the default target when one can be created", () => {
    const profiles = [{ id: "default", name: "Default" }];
    expect(initialTargetSelection(true, profiles)).toEqual({ kind: "new" });
    expect(resolveWizardTarget({ kind: "new" }, "profile-generated", profiles)).toEqual({
      kind: "new",
      profileId: "profile-generated",
    });
  });

  it("keeps an existing desktop profile target and its done step", () => {
    const profiles = [{ id: "profile-work", name: "Work" }];
    expect(
      resolveWizardTarget({ kind: "existing", profileId: "profile-work" }, "generated", profiles),
    ).toEqual({ kind: "existing", profileId: "profile-work", name: "Work" });
    expect(
      outcomeToStep({
        kind: "imported",
        imported: 4,
        skipped: 1,
        skippedDomains: ["x.example"],
        targetName: "Work",
      }),
    ).toEqual({
      step: "done",
      imported: 4,
      skipped: 1,
      skippedDomains: ["x.example"],
      targetName: "Work",
    });
  });

  it("keeps the advice to close a running source browser", () => {
    expect(initialWizardStep(source({ unavailable: "browserRunning" }))).toEqual({ step: "quit" });
    expect(outcomeToStep({ kind: "blocked", reason: "browserRunning" })).toEqual({ step: "quit" });
  });
});

describe("server import review repairs", () => {
  it("keeps the confirmed counts when a later server batch fails", async () => {
    let batch = 0;
    const outcome = await importIntoServerProfile(
      {
        canImport: allowed,
        readCookies: async () =>
          zenRead(PREVIEW_IMPORT_COOKIES_MAX_COUNT + 3, {
            undecryptable: 1,
            hosts: ["locked.example"],
          }),
        importCookies: async () => {
          batch += 1;
          if (batch === 2) throw new Error("The environment could not import cookies.");
          return {
            imported: PREVIEW_IMPORT_COOKIES_MAX_COUNT - 2,
            skipped: 2,
            skippedDomains: ["paypal.com"],
          };
        },
      },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(outcome).toEqual({
      kind: "imported",
      imported: PREVIEW_IMPORT_COOKIES_MAX_COUNT - 2,
      skipped: 3,
      skippedDomains: ["locked.example", "paypal.com"],
      targetName: "Default",
      serverBrowser: true,
      interrupted: true,
    });
    const step = outcomeToStep(outcome);
    if (step.step !== "done") throw new Error(`expected the done step, got ${step.step}`);
    expect(formatImportResult(step, "vigilia-home")).toEqual({
      title: "Imported 4,998 cookies",
      description:
        "Added to Default in vigilia-home's server browser before the import stopped. 3 cookies skipped. Try again to import the rest.",
      skippedDomains: "locked.example and paypal.com",
    });
  });

  it("does not read the source cookies when the connection cannot import into the server", async () => {
    const readCookies = vi.fn(async () => zenRead(1));
    const importCookies = vi.fn();

    const outcome = await importIntoServerProfile(
      { canImport: () => false, readCookies, importCookies },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(outcome).toEqual({ kind: "blocked", reason: "serverPermissionDenied" });
    expect(readCookies).not.toHaveBeenCalled();
    expect(importCookies).not.toHaveBeenCalled();
  });

  it("reports a server authorization rejection as missing permission", async () => {
    const outcome = await importIntoServerProfile(
      {
        canImport: allowed,
        readCookies: async () => zenRead(1),
        importCookies: async () => {
          throw new EnvironmentAuthorizationError({
            ...authScopeRequiredResponse("preview:operate"),
            message: "This connection requires preview:operate.",
          });
        },
      },
      { sourceId: "zen", sourceProfileDirectory: "abc.default", target: serverTarget },
    );

    expect(outcome).toEqual({ kind: "blocked", reason: "serverPermissionDenied" });
  });

  it("explains a server browser hidden by a missing permission", () => {
    expect(serverImportTargetNotice(true, false)).toBe(
      "The server browser isn't offered: this connection lacks permission to use it.",
    );
    expect(serverImportTargetNotice(true, true)).toBeUndefined();
    expect(serverImportTargetNotice(false, false)).toBeUndefined();
  });
});
