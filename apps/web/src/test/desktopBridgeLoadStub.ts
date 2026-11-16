/**
 * The desktop bridge methods app modules call while loading, which `env.ts` and friends read
 * once. Install it from `vi.hoisted` so it exists before any app module loads.
 */
export function installDesktopBridgeLoadStub(): void {
  Object.defineProperty(window, "desktopBridge", {
    value: {
      getAppBranding: () => null,
      getLocalEnvironmentBootstraps: () => [],
      getLocalEnvironmentEnabled: () => true,
      getRelayTelemetryEnabled: () => false,
      getSystemLocale: () => null,
    },
    configurable: true,
    writable: true,
  });
}
