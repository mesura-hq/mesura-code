import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Layer from "effect/Layer";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    generateReviewGuide: () => Effect.die("generateReviewGuide is not configured"),
    generateThreadSearchStep: () =>
      Effect.die("generateThreadSearchStep stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

const noLinkLookupLayer = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
  resolveLink: () => Effect.die("No link lookup expected"),
});

const threadSearchRequest = {
  description: "the thread where the cache used the wrong clock",
  searchedTerms: [],
  evidence: [],
  // The empty directory `ThreadSearchReasoning` creates for each step.
  cwd: "/tmp/t3code-thread-search-test",
};

describe("TextGeneration.make", () => {
  // Agent thread search, phase 2: the search step routes like every other
  // text-generation task, to the instance and model the caller selected.
  it.effect("routes a thread search step to the selected provider instance and model", () =>
    Effect.gen(function* () {
      const defaultId = ProviderInstanceId.make("codex");
      const smallId = ProviderInstanceId.make("opencode_small");
      const received: Array<unknown> = [];
      const defaultInstance = makeStubInstance(
        defaultId,
        makeStubTextGeneration({
          generateThreadSearchStep: () =>
            Effect.die("The unselected provider must not answer a thread search step"),
        }),
      );
      const smallInstance = makeStubInstance(
        smallId,
        makeStubTextGeneration({
          generateThreadSearchStep: (input) =>
            Effect.sync(() => {
              received.push(input.modelSelection);
              return { action: "broaden" as const, terms: ["clock skew"] };
            }),
        }),
      );
      const generation = yield* TextGeneration.make.pipe(
        Effect.provideService(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          makeStubRegistry([defaultInstance, smallInstance]),
        ),
        Effect.provide(noLinkLookupLayer),
      );

      const modelSelection = createModelSelection(smallId, "openai/gpt-5-mini");
      const step = yield* generation.generateThreadSearchStep({
        ...threadSearchRequest,
        modelSelection,
      });

      expect(step).toEqual({ action: "broaden", terms: ["clock skew"] });
      expect(received).toEqual([modelSelection]);
    }),
  );

  it.effect("fails a thread search step with a typed error when its provider is unavailable", () =>
    Effect.gen(function* () {
      const generation = yield* TextGeneration.make.pipe(
        Effect.provideService(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          makeStubRegistry([]),
        ),
        Effect.provide(noLinkLookupLayer),
      );

      const error = yield* generation
        .generateThreadSearchStep({
          ...threadSearchRequest,
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_small_model"),
            "gpt-5.6-luna",
          ),
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("TextGenerationError");
      expect(error.operation).toBe("generateThreadSearchStep");
      expect(error.detail).toContain("missing_small_model");
    }),
  );
});
