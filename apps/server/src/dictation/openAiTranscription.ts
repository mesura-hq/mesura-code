import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

export const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

/** Past this length `gpt-4o-transcribe` silently truncates, so `whisper-1` takes over. */
export const LONG_RECORDING_THRESHOLD_MS = 420_000;

const LANGUAGE_LINE = "The speaker primarily speaks English and Spanish.";
const GPT_4O_INSTRUCTIONS =
  "Transcribe verbatim. Keep filler words and false starts. " +
  "Insert paragraph breaks at topic shifts.";
const VOCABULARY_HINTS_MAX_LENGTH = 400;
const ATTEMPT_TIMEOUT = "110 seconds";
const RETRY_DELAY = "2 seconds";
const RETRIES = 2;

export class OpenAiTranscriptionError extends Data.TaggedError("OpenAiTranscriptionError")<{
  /** Readable, shown to the user as the job's failure. */
  readonly reason: string;
  /** 5xx, network and timeout failures; everything else is final. */
  readonly retryable: boolean;
}> {}

export interface OpenAiTranscriptionRequest {
  readonly apiKey: string;
  readonly audio: Uint8Array;
  /** OpenAI detects the audio format from this name's extension. */
  readonly fileName: string;
  readonly durationMs: number;
  readonly vocabularyHints: ReadonlyArray<string>;
}

export interface OpenAiTranscription {
  readonly transcribe: (
    request: OpenAiTranscriptionRequest,
  ) => Effect.Effect<string, OpenAiTranscriptionError>;
}

/** Deduplicated and comma-joined, keeping only whole hints that fit in 400 characters. */
function formatVocabularyHints(hints: ReadonlyArray<string>): string {
  let joined = "";
  for (const hint of new Set(hints.map((entry) => entry.trim()).filter(Boolean))) {
    const candidate = joined.length === 0 ? hint : `${joined}, ${hint}`;
    if (candidate.length > VOCABULARY_HINTS_MAX_LENGTH) break;
    joined = candidate;
  }
  return joined;
}

function transcriptionPrompt(useWhisper: boolean, hints: ReadonlyArray<string>): string {
  if (useWhisper) return LANGUAGE_LINE;
  const spellings = formatVocabularyHints(hints);
  const prompt = `${GPT_4O_INSTRUCTIONS} ${LANGUAGE_LINE}`;
  return spellings.length > 0 ? `${prompt} Use these exact spellings: ${spellings}` : prompt;
}

function statusFailure(status: number): OpenAiTranscriptionError {
  if (status === 401) {
    return new OpenAiTranscriptionError({
      reason: "OpenAI rejected the API key (HTTP 401). Check the key in Settings.",
      retryable: false,
    });
  }
  if (status === 429) {
    return new OpenAiTranscriptionError({
      reason: "OpenAI rate limit or quota reached (HTTP 429).",
      retryable: false,
    });
  }
  return new OpenAiTranscriptionError({
    reason:
      status >= 500
        ? `OpenAI failed to transcribe (HTTP ${status}).`
        : `OpenAI refused the recording (HTTP ${status}).`,
    retryable: status >= 500,
  });
}

/** Turns an uploaded recording into text with the user's OpenAI key. */
export const makeOpenAiTranscription: Effect.Effect<
  OpenAiTranscription,
  never,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const transcribe = (request: OpenAiTranscriptionRequest) => {
    const useWhisper = request.durationMs > LONG_RECORDING_THRESHOLD_MS;
    const form = new FormData();
    form.append("file", new Blob([request.audio]), request.fileName);
    form.append("model", useWhisper ? "whisper-1" : "gpt-4o-transcribe");
    form.append("response_format", "text");
    form.append("prompt", transcriptionPrompt(useWhisper, request.vocabularyHints));
    form.append("temperature", "0");
    const httpRequest = HttpClientRequest.post(OPENAI_TRANSCRIPTION_URL).pipe(
      HttpClientRequest.bearerToken(request.apiKey),
      HttpClientRequest.bodyFormData(form),
    );

    const attempt = Effect.gen(function* () {
      const response = yield* client.execute(httpRequest);
      if (response.status < 200 || response.status >= 300) {
        return yield* statusFailure(response.status);
      }
      const text = (yield* response.text).trim();
      if (text.length === 0) {
        return yield* new OpenAiTranscriptionError({
          reason: "No speech detected",
          retryable: false,
        });
      }
      return text;
    }).pipe(
      Effect.timeoutOrElse({
        duration: ATTEMPT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new OpenAiTranscriptionError({
              reason: "OpenAI did not answer within 110 seconds.",
              retryable: true,
            }),
          ),
      }),
      Effect.mapError((error) =>
        HttpClientError.isHttpClientError(error)
          ? new OpenAiTranscriptionError({
              reason: "Could not reach OpenAI. Check the server's network connection.",
              retryable: true,
            })
          : error,
      ),
    );

    return attempt.pipe(
      Effect.retry({
        schedule: Schedule.spaced(RETRY_DELAY),
        times: RETRIES,
        while: (error) => error.retryable,
      }),
    );
  };

  return { transcribe };
});
