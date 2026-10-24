import { act, render as renderBrowser, type Screen } from "../../test/render";
/**
 * `useDeviceState` reports `loaded` from the device subscription. The query
 * hook returns `null` until the first value arrives, so a pending subscription
 * must not read as loaded: `DevicePanel` would show first-run setup for an
 * environment that is already configured.
 */
import { EnvironmentId, type DeviceServiceState } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

const query = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("./query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./query")>()),
  useEnvironmentQuery: () => ({
    data: query.data,
    error: null,
    isPending: query.data === null,
    isSuccess: query.data !== null,
    refresh: () => undefined,
  }),
}));

import { useDeviceState } from "./device";

const ENVIRONMENT_ID = EnvironmentId.make("device-state-environment");

const CONFIGURED: DeviceServiceState = {
  hosts: [],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 3,
};

let root: Screen | undefined;
let container: HTMLDivElement | undefined;
function Probe() {
  const { state, loaded } = useDeviceState(ENVIRONMENT_ID);
  return (
    <output>
      {loaded ? "loaded" : "pending"}:revision-{state.revision}:
      {state.onboardingCompleted ? "onboarded" : "setup"}
    </output>
  );
}

function observed(): string {
  return container?.textContent ?? "";
}

async function render(): Promise<void> {

  container ??= document.body.appendChild(document.createElement("div"));
  root ??= await renderBrowser(null, { container: container, router: false });
  await act(async () => await root!.rerender(<Probe />));
}

async function setupBrowserFixture0() {


return {async [Symbol.asyncDispose]() {

  await act(async () => root?.[Symbol.asyncDispose]());
  container?.remove();
  root = undefined;
  container = undefined;
  query.data = null;
  vi.unstubAllGlobals();

}};
}

describe("device state loading", () => {
  it("device state: a pending subscription is not loaded, and its first value is", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    await render();
    expect(observed()).toBe("pending:revision-0:setup");

    query.data = CONFIGURED;
    await render();
    expect(observed()).toBe("loaded:revision-3:onboarded");
  });
});
