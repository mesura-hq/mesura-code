/**
 * Seed subscriptions from the credentials OpenCode already holds. Discovery finds a subscription
 * but does not own it: the seeded row must survive an OpenCode uninstall or another agent.
 *
 * @module usage/openCodeCredentialDiscovery
 */
import { ACCOUNT_LIMITS_VENDOR_NAME, type AccountLimitsNamespace } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Cast so `DecodingServices` pins to `never`. Without it the erased schema
// widens the requirements channel to `any` at every call site, which the
// Effect language service rejects — the same trap `ProviderDriver.ts` notes.
const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown) as unknown as Schema.Codec<unknown, string>,
);

/**
 * OpenCode's service ids, mapped to the vendor each one meters.
 *
 * `openai` is deliberately absent. That login's limits are the ChatGPT
 * subscription the Codex driver already reports, and claiming it here would
 * open the second row this whole cycle exists to prevent.
 */
const NAMESPACE_BY_SERVICE_ID: Readonly<Record<string, AccountLimitsNamespace>> = {
  "opencode-go": "opencode-go",
  "zai-coding-plan": "zai",
};

export interface DiscoveredCredential {
  readonly namespace: AccountLimitsNamespace;
  readonly label: string;
  readonly credential: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An API credential, which is the only shape either plan uses. */
function apiKey(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "api") return null;
  const key = value.key;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
}

/**
 * Where OpenCode keeps its credentials, most specific first.
 *
 * `opencode debug paths` prints the authoritative answer on every platform, but
 * it spawns a process — these rules cover the documented locations without one.
 */
export function openCodeDataDirectories(environment: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const directories: string[] = [];
  const explicit = environment.OPENCODE_DATA_DIR?.trim();
  if (explicit) directories.push(explicit);
  const xdg = environment.XDG_DATA_HOME?.trim();
  if (xdg) directories.push(`${xdg}/opencode`);
  const home = environment.HOME?.trim();
  if (home) directories.push(`${home}/.local/share/opencode`);
  return directories;
}

/**
 * Read both credential stores and report the plans this fork can meter. OpenCode is mid-migration:
 * the newer `account.json` holds some services, and the flat `auth.json` holds those plus others.
 * A missing store is not a failure, because OpenCode not being installed is an ordinary state.
 */
export const discoverOpenCodeCredentials = Effect.fn("discoverOpenCodeCredentials")(
  function* (input: {
    readonly dataDir: string;
    /**
     * Reads a file, reporting absence rather than failing. OpenCode not being
     * installed is an ordinary state, so it must not arrive as an error.
     */
    readonly readFile: (filePath: string) => Effect.Effect<Option.Option<string>>;
  }) {
    const found = new Map<AccountLimitsNamespace, DiscoveredCredential>();

    const claim = (serviceId: string, credential: unknown) => {
      const namespace = NAMESPACE_BY_SERVICE_ID[serviceId];
      if (namespace === undefined || found.has(namespace)) return;
      const key = apiKey(credential);
      if (key === null) return;
      found.set(namespace, {
        namespace,
        label: ACCOUNT_LIMITS_VENDOR_NAME[namespace],
        credential: key,
      });
    };

    const read = Effect.fn("discoverOpenCodeCredentials.read")(function* (fileName: string) {
      const contents = yield* input.readFile(`${input.dataDir}/${fileName}`);
      if (Option.isNone(contents)) return null;
      // A store that is present but unreadable is treated as absent: the point
      // of discovery is to find what it can, never to fail a startup.
      return yield* decodeJson(contents.value).pipe(Effect.orElseSucceed(() => null));
    });

    // The newer store first, so its entry wins where a service is in both.
    const account = yield* read("account.json");
    if (isRecord(account) && Array.isArray(account.accounts)) {
      for (const entry of account.accounts) {
        if (!isRecord(entry) || typeof entry.serviceID !== "string") continue;
        claim(entry.serviceID, entry.credential);
      }
    }

    const auth = yield* read("auth.json");
    if (isRecord(auth)) {
      for (const [serviceId, credential] of Object.entries(auth)) claim(serviceId, credential);
    }

    return [...found.values()];
  },
);
