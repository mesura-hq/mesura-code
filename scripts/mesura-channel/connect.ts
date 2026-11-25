// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Hands pairing links to each laptop app over SSH.
// Never opens the stable laptop server or vigilia: `t3 pair` and `t3 auth pairing create` both write
// the server's database directly, so their links come from that server's own "Create link".
import * as NodeFS from "node:fs";
import * as NodeTimersPromises from "node:timers/promises";
import { buildPairingAppLink, setPairingTokenOnUrl } from "@t3tools/shared/remote";

import { MESURA_DESKTOP_CHANNEL_IDENTITY } from "../lib/brand-assets.ts";
import {
  type ChannelServer,
  channelTitle,
  LAPTOP_TAILNET_NAME_ENV,
  laptopChannelPaths,
  laptopStablePaths,
  resolveLaptopTarget,
  READINESS_WAIT_SECONDS,
  SIDE_BY_SIDE_CHANNELS,
  type SideBySideChannel,
  VIGILIA_ENVIRONMENT_LABEL,
  VIGILIA_SERVER_PORT,
} from "./config.ts";
import {
  bundledCliScript,
  hyprlandExecScript,
  readinessWaitScript,
  run,
  runRemote,
  shellQuote,
} from "./shell.ts";

export type ClientChannel = "stable" | SideBySideChannel;

export interface ConnectClient {
  readonly channel: ClientChannel;
  readonly launcher: string;
  /** Labels and origins from the client's `saved-environments.json`; tokens are never read. */
  readonly savedEnvironmentNames: ReadonlyArray<string>;
}

export interface ConnectInput {
  readonly laptopHome: string;
  readonly laptopTailnetName: string;
  readonly laptopTarget: string;
  readonly vigiliaOrigin: string;
  readonly clients: ReadonlyArray<ConnectClient>;
  /** Clients that must not be launched now, with the reason; their pairings stay pending. */
  readonly unavailableClients?: ReadonlyMap<ClientChannel, string>;
}

export type PairingMint =
  | {
      readonly kind: "channel-cli";
      readonly appImage: string;
      readonly nextAppImage: string;
      readonly baseDir: string;
    }
  | { readonly kind: "server-settings"; readonly server: "stable" | "vigilia" };

export interface DesktopPairing {
  readonly client: ClientChannel;
  readonly executable: string;
  readonly clientReadinessUrl: string;
  readonly server: ChannelServer;
  readonly origin: string;
  readonly oneTime: true;
  readonly mint: PairingMint;
}

export interface PhonePairing {
  readonly server: SideBySideChannel;
  readonly origin: string;
  readonly oneTime: true;
  readonly mint: PairingMint;
}

function channelMint(laptopHome: string, channel: SideBySideChannel): PairingMint {
  const paths = laptopChannelPaths(laptopHome, channel);
  return {
    kind: "channel-cli",
    appImage: paths.appImage,
    nextAppImage: paths.nextAppImage,
    baseDir: paths.home,
  };
}

export function planConnect(input: ConnectInput) {
  const stable = laptopStablePaths(input.laptopHome);
  const servers: ReadonlyArray<{
    readonly server: ChannelServer;
    readonly origin: string;
    readonly names: ReadonlyArray<string>;
    readonly mint: PairingMint;
  }> = [
    {
      server: "stable",
      origin: stable.origin,
      names: [stable.origin],
      mint: { kind: "server-settings", server: "stable" },
    },
    ...SIDE_BY_SIDE_CHANNELS.map((channel) => {
      const paths = laptopChannelPaths(input.laptopHome, channel);
      const { displayName } = MESURA_DESKTOP_CHANNEL_IDENTITY[channel];
      return {
        server: channel,
        origin: paths.origin,
        names: [paths.origin, ...(displayName === null ? [] : [displayName])],
        mint: channelMint(input.laptopHome, channel),
      };
    }),
    {
      server: "vigilia",
      origin: input.vigiliaOrigin,
      names: [input.vigiliaOrigin, VIGILIA_ENVIRONMENT_LABEL],
      mint: { kind: "server-settings", server: "vigilia" },
    },
  ];

  const wantedPairings: ReadonlyArray<DesktopPairing> = input.clients.flatMap((client) => {
    const saved = new Set(client.savedEnvironmentNames);
    const clientReadinessUrl =
      client.channel === "stable"
        ? stable.readinessUrl
        : laptopChannelPaths(input.laptopHome, client.channel).readinessUrl;
    return servers
      .filter(({ server }) => server !== client.channel)
      .filter(({ names }) => !names.some((name) => saved.has(name)))
      .map(({ server, origin, mint }) => ({
        client: client.channel,
        executable: client.launcher,
        clientReadinessUrl,
        server,
        origin,
        oneTime: true as const,
        mint,
      }));
  });

  const unavailable = input.unavailableClients ?? new Map<ClientChannel, string>();
  const desktopPairings = wantedPairings.filter(({ client }) => !unavailable.has(client));
  const pendingPairings = wantedPairings.flatMap((pairing) => {
    const reason = unavailable.get(pairing.client);
    return reason === undefined ? [] : [{ pairing, reason }];
  });

  const phonePairings: ReadonlyArray<PhonePairing> = SIDE_BY_SIDE_CHANNELS.map((channel) => ({
    server: channel,
    origin: `https://${input.laptopTailnetName}:${MESURA_DESKTOP_CHANNEL_IDENTITY[channel].tailscaleServePort}`,
    oneTime: true as const,
    mint: channelMint(input.laptopHome, channel),
  }));

  const mintedChannels = new Set(
    [...desktopPairings, ...phonePairings].flatMap(({ server }) =>
      server === "dev" || server === "lab" ? [server] : [],
    ),
  );
  const launchedChannels = new Set(
    desktopPairings.flatMap(({ client }) => (client === "stable" ? [] : [client])),
  );
  return {
    desktopPairings,
    pendingPairings,
    phonePairings,
    /**
     * Direct writes only: minting writes the channel's own database, and a channel launcher may
     * activate its staged image and appends its launch log. The stable launcher's own log and the
     * environment a running app saves after the click are that app's writes.
     */
    writePaths: [
      ...[...mintedChannels].map((channel) => {
        const paths = laptopChannelPaths(input.laptopHome, channel);
        return `${paths.stateDirectory}/statev2.sqlite`;
      }),
      ...[...launchedChannels].flatMap((channel) => {
        const paths = laptopChannelPaths(input.laptopHome, channel);
        return [
          paths.appImage,
          paths.previousAppImage,
          paths.nextAppImage,
          paths.launchLog,
          paths.channelLock,
        ];
      }),
    ],
  };
}

export type ConnectPlan = ReturnType<typeof planConnect>;

/** A desktop app takes the `t3code://pair` link; the phone opens the pairing URL itself. */
export function formatPairingUrl(
  pairing: { readonly origin: string },
  token: string,
  kind: "desktop" | "phone",
): string {
  const pairingUrl = setPairingTokenOnUrl(new URL("/pair", pairing.origin), token).toString();
  return kind === "desktop" ? buildPairingAppLink(pairingUrl) : pairingUrl;
}

/** Reads names only; the saved sign-ins are encrypted with the app's own safe storage. */
export function readSavedEnvironmentNames(registryJson: string): ReadonlyArray<string> {
  if (registryJson.trim().length === 0) return [];
  const document = JSON.parse(registryJson) as {
    readonly records?: ReadonlyArray<{ readonly label?: unknown; readonly httpBaseUrl?: unknown }>;
  };
  return (document.records ?? []).flatMap((record) => [
    ...(typeof record.label === "string" ? [record.label] : []),
    ...(typeof record.httpBaseUrl === "string" && URL.canParse(record.httpBaseUrl)
      ? [new URL(record.httpBaseUrl).origin]
      : []),
  ]);
}

function readMagicDnsName(statusJson: string): string {
  return (JSON.parse(statusJson) as { Self: { DNSName: string } }).Self.DNSName.replace(/\.$/u, "");
}

/** The `host:port` routes Tailscale Serve sends to this machine's loopback `localPort`. */
export function findServeRoutes(
  host: string,
  serveStatusJson: string,
  localPort: number,
): ReadonlyArray<string> {
  const status = JSON.parse(serveStatusJson) as {
    readonly Web?: Record<string, { readonly Handlers?: Record<string, { Proxy?: string }> }>;
  };
  return Object.entries(status.Web ?? {}).flatMap(([hostPort, web]) => {
    const proxy = web.Handlers?.["/"]?.Proxy;
    if (proxy === undefined || !URL.canParse(proxy)) return [];
    const target = new URL(proxy);
    const isLoopback = target.hostname === "127.0.0.1" || target.hostname === "localhost";
    return isLoopback && Number(target.port) === localPort && hostPort.startsWith(`${host}:`)
      ? [hostPort]
      : [];
  });
}

/** vigilia's tailnet origin: its MagicDNS name and the Serve port that proxies the stable server. */
export function resolveServedOrigin(
  host: string,
  serveStatusJson: string,
  localPort: number,
): string {
  const route = findServeRoutes(host, serveStatusJson, localPort)[0];
  if (route === undefined) {
    throw new Error(`No Tailscale Serve route on ${host} proxies 127.0.0.1:${localPort}.`);
  }
  return `https://${route}`;
}

/** Supplied links stay out of argv and shell history; errors name the line, never its content. */
export function parseSuppliedPairingUrls(
  text: string,
): ReadonlyMap<"stable" | "vigilia", ReadonlyArray<string>> {
  const urls = new Map<"stable" | "vigilia", Array<string>>();
  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const server = line.slice(0, separator);
    const url = line.slice(separator + 1);
    if ((server !== "stable" && server !== "vigilia") || !URL.canParse(url)) {
      throw new Error(`Pairing links line ${index + 1} is not stable=<url> or vigilia=<url>.`);
    }
    urls.set(server, [...(urls.get(server) ?? []), url]);
  }
  return urls;
}

/** Reads `-` from stdin, or a file only its owner can read. */
export function readPrivateInput(path: string): string {
  if (path === "-") return NodeFS.readFileSync(0, "utf8");
  // A pairing URL pasted in place of the path must not come back in an error message.
  let content: string;
  let privateToOwner: boolean;
  try {
    const stat = NodeFS.statSync(path);
    privateToOwner = (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.();
    content = privateToOwner ? NodeFS.readFileSync(path, "utf8") : "";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // oxlint-disable-next-line preserve-caught-error -- the caught error's message holds the path, which can be a pasted pairing URL.
    throw new Error(
      `Could not read the file given to --pairing-urls (${typeof code === "string" ? code : "unreadable"}).`,
    );
  }
  if (!privateToOwner) {
    throw new Error("The file given to --pairing-urls must be owned by you with mode 0600.");
  }
  return content;
}

/**
 * Hands a link to a laptop app. With `onlyIfAnswering`, the app's backend is checked in the same
 * remote step, right before the dispatch, so a stopped stable app is never cold-started.
 */
export function handoffScript(commandLine: string, onlyIfAnswering?: string): string {
  const dispatch = `${hyprlandExecScript(commandLine)}\necho handed-over`;
  if (onlyIfAnswering === undefined) return dispatch;
  return [
    `if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${shellQuote(onlyIfAnswering)})" = 200 ]; then`,
    dispatch,
    "else",
    "echo not-running",
    "fi",
  ].join("\n");
}

function mintOnChannel(target: string, mint: PairingMint, label: string): string {
  if (mint.kind !== "channel-cli") throw new Error("Only Dev and Lab links are minted here.");
  const cliArgs = [
    "auth",
    "pairing",
    "create",
    "--base-dir",
    mint.baseDir,
    "--json",
    "--ttl",
    "1h",
    "--label",
    label,
  ];
  const output = runRemote(
    target,
    [
      `if [ -e ${shellQuote(mint.appImage)} ]; then`,
      bundledCliScript(mint.appImage, cliArgs),
      "else",
      bundledCliScript(mint.nextAppImage, cliArgs),
      "fi",
    ].join("\n"),
  );
  const start = output.indexOf("{");
  const credential =
    start === -1
      ? undefined
      : (JSON.parse(output.slice(start)) as { credential?: unknown }).credential;
  if (typeof credential !== "string") {
    throw new Error(`Minting a pairing link in ${mint.baseDir} returned no credential.`);
  }
  return credential;
}

/**
 * Why a client cannot take links now. The stable app is never cold-started: its pairings wait
 * until it runs. A missing launcher or image would fail late, after the links were minted.
 */
export function preflightScript(
  laptopHome: string,
  stableReadinessUrl = laptopStablePaths(laptopHome).readinessUrl,
): string {
  const stable = { ...laptopStablePaths(laptopHome), readinessUrl: stableReadinessUrl };
  return [
    `if [ ! -x ${shellQuote(stable.launcher)} ]; then echo "stable	no launcher at ${stable.launcher}"`,
    `elif [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${shellQuote(stable.readinessUrl)})" != 200 ]; then echo "stable	the stable app is not running; start it and run connect again"; fi`,
    ...SIDE_BY_SIDE_CHANNELS.map((channel) => {
      const paths = laptopChannelPaths(laptopHome, channel);
      return [
        `if [ ! -x ${shellQuote(paths.launcher)} ]; then echo "${channel}	no launcher at ${paths.launcher}; run stage --channel ${channel}"`,
        `elif [ ! -e ${shellQuote(paths.appImage)} ] && [ ! -e ${shellQuote(paths.nextAppImage)} ]; then echo "${channel}	no ${channel} AppImage; run stage --channel ${channel}"; fi`,
      ].join("\n");
    }),
  ].join("\n");
}

/** Each output line of `preflightScript` is `<client>\t<reason>`. */
export function parsePreflight(output: string): ReadonlyMap<ClientChannel, string> {
  return new Map(
    output
      .split("\n")
      .filter((line) => line.includes("\t"))
      .map((line) => {
        const [client, reason] = line.split("\t");
        return [client as ClientChannel, reason ?? ""];
      }),
  );
}

export interface ConnectOptions {
  /** One-time pairing URLs made with "Create link" on the stable servers, used in order. */
  readonly suppliedPairingUrls: ReadonlyMap<"stable" | "vigilia", ReadonlyArray<string>>;
}

export async function executeConnect(options: ConnectOptions): Promise<void> {
  const laptop = resolveLaptopTarget();
  const laptopTailnetName =
    process.env[LAPTOP_TAILNET_NAME_ENV] ??
    readMagicDnsName(runRemote(laptop.target, "tailscale status --json"));
  const vigiliaOrigin = resolveServedOrigin(
    readMagicDnsName(run("tailscale", ["status", "--json"])),
    run("tailscale", ["serve", "status", "--json"]),
    VIGILIA_SERVER_PORT,
  );
  const savedNames = (path: string) =>
    readSavedEnvironmentNames(
      runRemote(laptop.target, `cat ${shellQuote(path)} 2>/dev/null || true`),
    );
  const stable = laptopStablePaths(laptop.home);
  const clients: ReadonlyArray<ConnectClient> = [
    {
      channel: "stable",
      launcher: stable.launcher,
      savedEnvironmentNames: savedNames(stable.savedEnvironments),
    },
    ...SIDE_BY_SIDE_CHANNELS.map((channel) => {
      const paths = laptopChannelPaths(laptop.home, channel);
      return {
        channel,
        launcher: paths.launcher,
        savedEnvironmentNames: savedNames(paths.savedEnvironments),
      };
    }),
  ];
  const plan = planConnect({
    laptopHome: laptop.home,
    laptopTailnetName,
    laptopTarget: laptop.target,
    vigiliaOrigin,
    clients,
    unavailableClients: parsePreflight(runRemote(laptop.target, preflightScript(laptop.home))),
  });

  const supplied = new Map(
    [...options.suppliedPairingUrls].map(([server, urls]) => [server, [...urls]]),
  );
  const pending = plan.pendingPairings.map(({ pairing, reason }) => ({ pairing, reason }));
  const linksByClient = new Map<string, Array<{ pairing: DesktopPairing; link: string }>>();
  for (const pairing of plan.desktopPairings) {
    let link: string | undefined;
    if (pairing.mint.kind === "channel-cli") {
      const token = mintOnChannel(
        laptop.target,
        pairing.mint,
        `Mesura Code ${pairing.client} (connect)`,
      );
      link = formatPairingUrl(pairing, token, "desktop");
    } else {
      const url = supplied.get(pairing.mint.server)?.shift();
      if (url !== undefined) link = buildPairingAppLink(url);
    }
    if (link === undefined) {
      pending.push({ pairing, reason: "needs a link from that server's Create link" });
      continue;
    }
    const links = linksByClient.get(pairing.executable) ?? [];
    links.push({ pairing, link });
    linksByClient.set(pairing.executable, links);
  }

  // One deadline for every cold start, so a missing server cannot hold the command for long.
  const deadline = Date.now() + READINESS_WAIT_SECONDS * 1_000;
  for (const [executable, links] of linksByClient) {
    for (const [index, { pairing, link }] of links.entries()) {
      const outcome = runRemote(
        laptop.target,
        handoffScript(
          `env HOME=${shellQuote(laptop.home)} ${shellQuote(executable)} ${shellQuote(link)}`,
          pairing.client === "stable" ? pairing.clientReadinessUrl : undefined,
        ),
      ).trim();
      if (outcome !== "handed-over") {
        pending.push({ pairing, reason: "the stable app stopped before its link was handed over" });
        continue;
      }
      process.stdout.write(
        `Asked ${pairing.client} to add ${pairing.server} (${pairing.origin}).\n`,
      );
      // The first link may cold-start the app; later links reach it as a second instance.
      if (index === 0) {
        try {
          runRemote(
            laptop.target,
            readinessWaitScript(pairing.clientReadinessUrl, (deadline - Date.now()) / 1_000),
          );
        } catch {
          throw new Error(
            `${pairing.client} (${executable}) did not answer at ${pairing.clientReadinessUrl}; see its launch.log.`,
          );
        }
      }
      await NodeTimersPromises.setTimeout(3_000);
    }
  }

  // A fresh channel leaves Tailscale HTTPS off; a URL on a route that does not exist only fails on the phone.
  const laptopRoutes = runRemote(
    laptop.target,
    "tailscale serve status --json 2>/dev/null || echo '{}'",
  );
  process.stdout.write("\nPhone pairing links (one-time, valid for 1 hour):\n");
  for (const pairing of plan.phonePairings) {
    const route = new URL(pairing.origin).host;
    const backendPort = MESURA_DESKTOP_CHANNEL_IDENTITY[pairing.server].backendPort;
    if (!findServeRoutes(laptopTailnetName, laptopRoutes, backendPort).includes(route)) {
      process.stdout.write(
        `  ${pairing.server}: no Tailscale route at ${pairing.origin}; turn on Settings > Connections > Tailscale HTTPS in Mesura Code ${channelTitle(pairing.server)}, then run connect again.\n`,
      );
      continue;
    }
    const token = mintOnChannel(laptop.target, pairing.mint, "Phone (connect)");
    process.stdout.write(`  ${pairing.server}: ${formatPairingUrl(pairing, token, "phone")}\n`);
  }

  if (pending.length > 0) {
    process.stdout.write(
      "\nStill missing (stable and vigilia links: Settings > Connections > Create link, one per line as stable=<url> or vigilia=<url> in a mode-0600 file passed with --pairing-urls):\n",
    );
    for (const { pairing, reason } of pending) {
      process.stdout.write(
        `  ${pairing.client} needs ${pairing.server} (${pairing.origin}): ${reason}\n`,
      );
    }
  }
}
