/**
 * Test boundary for `state/orchestration`, for tests that mount `HomeRouteScreen`
 * or `HomeHeader`. Imported by tests only, from `vi.mock` factories:
 *
 *   vi.mock("../../state/orchestration", async () =>
 *     (await import("./homeRouteTestDoubles")).orchestrationBoundary);
 *
 * Both screens import `AgentThreadSearch`, which reaches the connection runtime,
 * and from there `expo-crypto` and the other Expo native modules that cannot load
 * under vitest. The Home header renders only the agent search mode button, which
 * never reads orchestration, so the boundary holds no atoms: reading one throws
 * and names the double to use instead. Agent search itself is covered with
 * `threads/agentThreadSearch.testMocks`.
 */
const unavailableOrchestrationEnvironment = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `orchestrationEnvironment.${String(property)} is outside this test's boundary; ` +
          "mount agent search through threads/agentThreadSearch.testMocks instead.",
      );
    },
  },
);

export const orchestrationBoundary = {
  orchestrationEnvironment: unavailableOrchestrationEnvironment,
};
