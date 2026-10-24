import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";

import {
  materializeMuseReplayWorkspace,
  MuseOrchestratorReplayHarness,
} from "../Adapters/MuseAdapterV2.testkit.ts";
import { materializeMuseReplayApplicationMetadata } from "./MesuraReplayMuseMetadata.ts";
import { findReplayFixture, runReplayFixture } from "./ProviderReplayFixtures.ts";

it.effect.each([false, true])(
  "Mesura Muse metadata preserves replay validation (reasoning drift: %s)",
  (drift) =>
    Effect.gen(function* () {
      const fixture = findReplayFixture("simple");
      const driver = fixture?.providers.find((entry) => entry.driver === "muse");
      if (fixture === undefined || driver === undefined) {
        return assert.fail("Expected the simple Muse replay fixture");
      }
      const result = yield* runReplayFixture({
        fixtureName: fixture.name,
        buildInput: fixture.buildInput,
        driver,
        harness: MuseOrchestratorReplayHarness,
        materializeWorkspace: materializeMuseReplayWorkspace,
        transformTranscript: (transcript) => {
          const materialized = materializeMuseReplayApplicationMetadata(transcript);
          if (!drift) return materialized;
          return {
            ...materialized,
            entries: materialized.entries.map((entry) => {
              if (entry.type !== "expect_outbound") return entry;
              const frame = entry.frame;
              if (!Predicate.isObject(frame) || frame.method !== "turn/start") return entry;
              if (!Predicate.isObject(frame.params)) return entry;
              return {
                ...entry,
                frame: {
                  ...frame,
                  params: { ...frame.params, reasoningEffort: "unexpected-effort" },
                },
              };
            }),
          };
        },
      }).pipe(Effect.exit);
      if (drift) {
        if (Exit.isSuccess(result)) return assert.fail("Muse protocol drift must fail replay");
        assert.include(Cause.pretty(result.cause), "MuseReplayMismatchError");
      } else if (Exit.isFailure(result)) {
        return assert.fail(Cause.pretty(result.cause));
      }
    }),
);
