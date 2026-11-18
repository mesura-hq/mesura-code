import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { SILERO_VAD } from "../speech/silero.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import { speechOnlyAudio, type SpeechOnlyAudio } from "./speechOnlyAudio.ts";

/** `unavailable` means no filtering happened: the caller sends the original recording. */
export type SilenceFilterOutcome = SpeechOnlyAudio | { readonly kind: "unavailable" };

/**
 * Drops silence from a dictation before it goes to OpenAI, with upstream's Silero model, so a
 * long recording costs only its speech and a silent stretch gives the model nothing to invent
 * words from. Every failure is `unavailable`: the transcription then gets the whole recording.
 */
export class DictationSilenceFilter extends Context.Service<
  DictationSilenceFilter,
  { readonly filter: (audioPath: string) => Effect.Effect<SilenceFilterOutcome> }
>()("t3/dictation/DictationSilenceFilter") {}

class DictationSilenceFilterError extends Schema.TaggedError<DictationSilenceFilterError>()(
  "DictationSilenceFilterError",
  { cause: Schema.Defect() },
) {}

const MODEL_TIMEOUT = "15 seconds";
const MODEL_RETRY_MS = 10 * 60_000;
/** Decode, Silero and encode of a 45-minute recording take well under this. */
const FILTER_TIMEOUT = "5 minutes";
/** Each filter runs one Silero process and two ffmpeg passes; the rest wait their turn. */
const CONCURRENT_FILTERS = 2;

export const make = Effect.gen(function* () {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const permits = yield* Semaphore.make(CONCURRENT_FILTERS);
  let modelRetryAt = 0;

  const vadModelPath = Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) < modelRetryAt) return undefined;
    const path = yield* store.download(SILERO_VAD).pipe(
      Effect.timeout(MODEL_TIMEOUT),
      Effect.orElseSucceed(() => undefined),
    );
    if (path === undefined) {
      modelRetryAt = (yield* Clock.currentTimeMillis) + MODEL_RETRY_MS;
      yield* Effect.logWarning("Silero unavailable; dictation sends whole recordings.");
    }
    return path;
  });

  const filter = Effect.fn("DictationSilenceFilter.filter")(function* (audioPath: string) {
    const vadPath = yield* vadModelPath;
    if (vadPath === undefined) return { kind: "unavailable" } as const;
    return yield* Effect.tryPromise({
      try: (signal) => speechOnlyAudio(audioPath, vadPath, signal),
      catch: (cause) => new DictationSilenceFilterError({ cause }),
    }).pipe(
      Effect.timeout(FILTER_TIMEOUT),
      Effect.tap((outcome) =>
        outcome.kind === "invalid-cut"
          ? Effect.logWarning(
              `Dictation cut rejected (${outcome.reason}); sending the whole recording.`,
            )
          : Effect.void,
      ),
      permits.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Dictation silence filter failed; sending the whole recording.",
          cause,
        ).pipe(Effect.as({ kind: "unavailable" } as const)),
      ),
    );
  });

  return DictationSilenceFilter.of({ filter });
});

export const layer = Layer.effect(DictationSilenceFilter, make);
