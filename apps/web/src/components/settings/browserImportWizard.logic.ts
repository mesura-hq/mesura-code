import type {
  BrowserCookieReadResult,
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportSourceId,
  BrowserProfile,
  ImportedCookie,
} from "@t3tools/contracts";
import { BrowserImportFailureReason, PREVIEW_IMPORT_COOKIES_MAX_COUNT } from "@t3tools/contracts";

export interface WizardTargetProfile {
  readonly id: string;
  readonly name: string;
}

export type WizardTarget =
  | { readonly kind: "new"; readonly profileId: string }
  | { readonly kind: "existing"; readonly profileId: string; readonly name: string }
  | { readonly kind: "server"; readonly profileId: string; readonly name: string };

export type WizardTargetSelection =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly profileId: string }
  | { readonly kind: "server"; readonly profileId: string };

/** The server browser holds the same persistent profiles the client reports to it. */
export function serverImportTargetProfiles(
  serverBrowserAvailable: boolean,
  profiles: ReadonlyArray<Pick<BrowserProfile, "id" | "name" | "kind">>,
): ReadonlyArray<WizardTargetProfile> {
  if (!serverBrowserAvailable) return [];
  return profiles
    .filter((profile) => profile.kind !== "incognito")
    .map((profile) => ({ id: profile.id, name: profile.name }));
}

export function initialTargetSelection(
  canCreateProfile: boolean,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTargetSelection {
  if (canCreateProfile) return { kind: "new" };
  const first = targetProfiles[0];
  return first ? { kind: "existing", profileId: first.id } : { kind: "new" };
}

export function resolveWizardTarget(
  selection: WizardTargetSelection,
  newProfileId: string,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
  serverTargetProfiles: ReadonlyArray<WizardTargetProfile> = [],
): WizardTarget | undefined {
  if (selection.kind === "new") return { kind: "new", profileId: newProfileId };
  const candidates = selection.kind === "server" ? serverTargetProfiles : targetProfiles;
  const profile = candidates.find((candidate) => candidate.id === selection.profileId);
  if (profile === undefined) return undefined;
  return {
    kind: selection.kind,
    profileId: selection.profileId,
    name: profile.name,
  };
}

interface ImportCounts {
  readonly imported: number;
  readonly skipped: number;
  readonly skippedDomains: ReadonlyArray<string>;
  readonly targetName: string;
  /** Set when the cookies went to the environment's server browser instead of the desktop. */
  readonly serverBrowser?: true;
  /** Set when a later server batch failed; the counts cover the batches the server confirmed. */
  readonly interrupted?: true;
}

export type ImportOutcome =
  | ({ readonly kind: "imported" } & ImportCounts)
  | {
      readonly kind: "blocked";
      readonly reason: BrowserImportFailureReason;
      /** Shown instead of the reason's copy, such as a managed policy's refusal. */
      readonly message?: string;
    };

export type WizardStep =
  | { readonly step: "quit" }
  | {
      readonly step: "fullDiskAccess";
      readonly resume: "configure" | "import";
      readonly checked?: boolean;
    }
  | { readonly step: "configure" }
  | { readonly step: "checking"; readonly check: "browser" | "fullDiskAccess" }
  | { readonly step: "importing" }
  | ({ readonly step: "done" } & ImportCounts)
  | {
      readonly step: "blocked";
      readonly reason: BrowserImportFailureReason;
      readonly message?: string;
    };

export function canCloseWizard(step: WizardStep): boolean {
  return step.step !== "importing";
}

export function initialWizardStep(source: BrowserImportSource): WizardStep {
  if (source.unavailable === "browserRunning") return { step: "quit" };
  if (source.unavailable === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "configure" };
  }
  if (source.unavailable !== undefined) return { step: "blocked", reason: source.unavailable };
  if (source.profiles.length === 0) return { step: "blocked", reason: "unknownSourceProfile" };
  return { step: "configure" };
}

export function outcomeToStep(outcome: ImportOutcome): WizardStep {
  if (outcome.kind === "imported") {
    return {
      step: "done",
      imported: outcome.imported,
      skipped: outcome.skipped,
      skippedDomains: outcome.skippedDomains,
      targetName: outcome.targetName,
      ...(outcome.serverBrowser ? { serverBrowser: true } : {}),
      ...(outcome.interrupted ? { interrupted: true } : {}),
    };
  }
  if (outcome.reason === "browserRunning") return { step: "quit" };
  if (outcome.reason === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "import", checked: true };
  }
  return outcome.message === undefined
    ? { step: "blocked", reason: outcome.reason }
    : { step: "blocked", reason: outcome.reason, message: outcome.message };
}

export function refreshedSourceStep(source: BrowserImportSource | undefined): WizardStep {
  if (source === undefined) return { step: "blocked", reason: "unknownSource" };
  return initialWizardStep(source);
}

export function fullDiskAccessRecheckStep(source: BrowserImportSource | undefined): WizardStep {
  const next = refreshedSourceStep(source);
  return next.step === "fullDiskAccess" ? { ...next, checked: true } : next;
}

export function refreshedSourceProfileDirectory(
  currentDirectory: string,
  source: BrowserImportSource,
): string {
  if (source.profiles.some((profile) => profile.directory === currentDirectory)) {
    return currentDirectory;
  }
  return source.profiles[0]?.directory ?? "";
}

export function isRetryableReason(reason: BrowserImportFailureReason): boolean {
  switch (reason) {
    case "needsKeychainApproval":
    case "keychainItemMissing":
    case "keychainUnavailable":
    case "readFailed":
    case "sessionUnavailable":
    case "profileNotSaved":
      return true;
    default:
      return false;
  }
}

export function formatSkippedDomains(domains: ReadonlyArray<string>): string {
  if (domains.length === 0) return "";
  if (domains.length === 1) return domains[0]!;
  if (domains.length <= 3) return `${domains.slice(0, -1).join(", ")} and ${domains.at(-1)}`;
  return `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more`;
}

/** IPC carries reason tokens inside messages; treat unknown tokens as read failures without exposing raw
 * text. */
export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

export interface ServerProfileImportPorts {
  /** Checked before the read, so a connection without the grant never decrypts the cookies. */
  readonly canImport: () => boolean;
  readonly readCookies: (input: {
    readonly sourceId: BrowserImportSourceId;
    readonly sourceProfileDirectory: string;
  }) => Promise<BrowserCookieReadResult>;
  readonly importCookies: (input: {
    readonly profileId: string;
    readonly cookies: ReadonlyArray<ImportedCookie>;
  }) => Promise<BrowserImportResult>;
}

/** Reads on the desktop, then sends the cookies to the server browser in batches its RPC accepts. */
export async function importIntoServerProfile(
  ports: ServerProfileImportPorts,
  input: {
    readonly sourceId: BrowserImportSourceId;
    readonly sourceProfileDirectory: string;
    readonly target: Extract<WizardTarget, { readonly kind: "server" }>;
  },
): Promise<ImportOutcome> {
  if (!ports.canImport()) return { kind: "blocked", reason: "serverPermissionDenied" };
  let read: BrowserCookieReadResult;
  try {
    read = await ports.readCookies({
      sourceId: input.sourceId,
      sourceProfileDirectory: input.sourceProfileDirectory,
    });
  } catch (cause) {
    return { kind: "blocked", reason: importFailureReason(cause) };
  }
  // Cookies the desktop could not decrypt count as skipped, as they do in a desktop import.
  let imported = 0;
  let skipped = read.undecryptable;
  const skippedDomains = new Set(read.undecryptableHosts);
  const counts = () => ({
    kind: "imported" as const,
    imported,
    skipped,
    skippedDomains: [...skippedDomains],
    targetName: input.target.name,
    serverBrowser: true as const,
  });
  for (let start = 0; start < read.cookies.length; start += PREVIEW_IMPORT_COOKIES_MAX_COUNT) {
    let result: BrowserImportResult;
    try {
      result = await ports.importCookies({
        profileId: input.target.profileId,
        cookies: read.cookies.slice(start, start + PREVIEW_IMPORT_COOKIES_MAX_COUNT),
      });
    } catch (cause) {
      // Earlier batches are already in the profile; report them rather than hide them.
      if (start > 0) return { ...counts(), interrupted: true };
      return { kind: "blocked", reason: serverImportFailureReason(cause) };
    }
    imported += result.imported;
    skipped += result.skipped;
    for (const domain of result.skippedDomains) skippedDomains.add(domain);
  }
  return counts();
}

const serverImportFailureReason = (cause: unknown): BrowserImportFailureReason =>
  (cause as { readonly _tag?: unknown } | undefined)?._tag === "EnvironmentAuthorizationError"
    ? "serverPermissionDenied"
    : "sessionUnavailable";

function cookieResultCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
}

export function formatImportResult(
  result: ImportCounts,
  destinationEnvironmentName: string,
): { readonly title: string; readonly description: string; readonly skippedDomains: string } {
  const { imported, skipped } = result;
  const destination = result.serverBrowser
    ? `in ${destinationEnvironmentName}'s server browser`
    : `for ${destinationEnvironmentName}`;
  return {
    title:
      imported > 0
        ? `Imported ${cookieResultCount(imported)}`
        : skipped > 0
          ? `Skipped ${cookieResultCount(skipped)}`
          : "No cookies found",
    description:
      imported > 0
        ? `Added to ${result.targetName} ${destination}${result.interrupted ? " before the import stopped" : ""}.${skipped > 0 ? ` ${cookieResultCount(skipped)} skipped.` : ""}${result.interrupted ? " Try again to import the rest." : ""}`
        : skipped > 0
          ? `No cookies were imported ${destination}.`
          : `There were no cookies to import ${destination}.`,
    skippedDomains: formatSkippedDomains(result.skippedDomains),
  };
}

/** Why the wizard lists no server profiles although the environment has a server browser. */
export function serverImportTargetNotice(
  serverBrowserAvailable: boolean,
  canImport: boolean,
): string | undefined {
  return serverBrowserAvailable && !canImport
    ? "The server browser isn't offered: this connection lacks permission to use it."
    : undefined;
}

export function parsePaymentDomainsText(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "");
}

export function formatPaymentDomainsText(domains: ReadonlyArray<string>): string {
  return domains.join("\n");
}

/** Undefined when the edit leaves the saved list unchanged. */
export function paymentDomainsPatch(
  text: string,
  current: ReadonlyArray<string>,
): { readonly browserPaymentDomains: ReadonlyArray<string> } | undefined {
  const next = parsePaymentDomainsText(text);
  const unchanged =
    next.length === current.length && next.every((domain, index) => domain === current[index]);
  return unchanged ? undefined : { browserPaymentDomains: next };
}
