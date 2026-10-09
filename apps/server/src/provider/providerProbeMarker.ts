/**
 * The environment marker that tells a host a spawned provider CLI is a short
 * probe, not an agent session.
 *
 * Contract: a host may wrap the provider CLIs (`codex`, `claude`) to confine
 * every process the server spawns, for example under a memory limit shared by
 * all agent sessions. Such a wrapper exempts a process whose environment has
 * exactly `MESURA_PROVIDER_PROBE=1`, so the server's status, skills,
 * account-limit and reset-credit probes stay responsive while sessions fill
 * that limit.
 *
 * The exemption is only safe while sessions never carry the marker: a marked
 * session escapes the confinement. So probes add it with
 * `withProviderProbeMarker`, and every session spawn removes it with
 * `withoutProviderProbeMarker`, including a value the server inherited.
 */
export const PROVIDER_PROBE_MARKER_ENVIRONMENT = Object.freeze({
  MESURA_PROVIDER_PROBE: "1",
});

const PROVIDER_PROBE_MARKER_REMOVAL: Readonly<Record<string, undefined>> = Object.freeze(
  Object.fromEntries(
    Object.keys(PROVIDER_PROBE_MARKER_ENVIRONMENT).map((name) => [name, undefined]),
  ),
);

/**
 * A new environment carrying the probe marker. Never writes into `environment`,
 * which is often `process.env` itself or an instance environment that the same
 * provider's sessions spawn with next.
 */
export const withProviderProbeMarker = (
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => ({ ...environment, ...PROVIDER_PROBE_MARKER_ENVIRONMENT });

/**
 * A new environment with the probe marker removed, for a session's child. The
 * key stays present as `undefined`: that outranks the same key from
 * `process.env` when a spawner extends the inherited environment, and Node's
 * `spawn` drops undefined entries, so the child never sees the variable.
 */
export const withoutProviderProbeMarker = (
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => ({ ...environment, ...PROVIDER_PROBE_MARKER_REMOVAL });
