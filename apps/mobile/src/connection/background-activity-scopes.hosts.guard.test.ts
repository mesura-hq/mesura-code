/**
 * Phase 6 guards: the Hosts screen's subscription must not keep the app's
 * connection alive in the background. `subscribeHostStats` retains no
 * background scope — host sampling runs on the server regardless of demand —
 * while the scopes that exist keep their meaning.
 */
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  observeMobileBackgroundActivitySubscription,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

describe("background activity scopes and the Hosts screen", () => {
  it.effect("background scope guard: a host stats subscription retains no background scope", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("hosts-guard-host-stats");
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeHostStats,
        input: {},
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("background scope guard: resource telemetry still retains the diagnostics scope", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("hosts-guard-diagnostics");
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeResourceTelemetry,
        input: {},
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);
      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );
});
