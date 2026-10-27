/**
 * Marks a spawned provider CLI as a short probe, not an agent session. A host wrapper
 * that confines spawned CLIs under a shared limit may exempt `MESURA_PROVIDER_PROBE=1`, so
 * probes stay responsive. Safe only while sessions never carry it: probes add it with
 * `withProviderProbeMarker`; every session spawn strips it, an inherited value included.
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
