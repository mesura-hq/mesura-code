/**
 * Installs `window.desktopBridge` before any app module loads, because `env.ts` reads it once.
 * It carries what modules read while loading (`branding.ts`, `localEnvironment.ts`,
 * `timestampFormat.ts`, `cloud/publicConfig.ts`) and on the first render
 * (`useBrowserLayoutZoomFactor.ts`). Call it from `vi.hoisted`.
 */
export function installLoadTimeDesktopBridge(): void {
  Object.defineProperty(window, "desktopBridge", {
    value: {
      getLocalEnvironmentBootstraps: () => [],
      getAppBranding: () => null,
      getLocalEnvironmentEnabled: () => true,
      getRelayTelemetryEnabled: () => true,
      getSystemLocale: () => null,
      getWindowZoomFactor: () => 1,
    },
    configurable: true,
    writable: true,
  });
}
