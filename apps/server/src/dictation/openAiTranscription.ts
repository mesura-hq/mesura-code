import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

export const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

/** Points transcription at a local stub or a proxy; there is no UI for it. */
const OPENAI_TRANSCRIPTION_URL_ENV = "T3CODE_DICTATION_OPENAI_URL";

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

export class OpenAiTranscriptionError extends Schema.TaggedError<OpenAiTranscriptionError>()(
  "OpenAiTranscriptionError",
  {
    reason: Schema.String,
    retryable: Schema.Boolean,
    /** OpenAI refused the audio itself or heard nothing in it, as opposed to the key or the network. */
    audioRejected: Schema.optional(Schema.Boolean),
  },
) {}

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

const decodeTranscriptionBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        message: Schema.optional(Schema.NullOr(Schema.String)),
        param: Schema.optional(Schema.NullOr(Schema.String)),
        code: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    }),
  ),
);

/** Whisper reports a refused file with no `param` or `code`; only its message names the file. */
const FILE_FORMAT_MESSAGE =
  /invalid file format|corrupted or unsupported|could not be decoded|unsupported (?:file|audio) format/i;

/**
 * Whether OpenAI refused the recording itself, so sending the whole recording may succeed. A
 * 403, a 404, a 413 (the whole recording is larger) or a 400 about another field is not that.
 */
function rejectsAudio(status: number, body: string): boolean {
  if (status !== 400 && status !== 415 && status !== 422) return false;
  const error = Option.getOrUndefined(decodeErrorBody(body))?.error;
  return (
    error?.param === "file" ||
    /audio|file/i.test(error?.code ?? "") ||
    FILE_FORMAT_MESSAGE.test(error?.message ?? "")
  );
}

function statusFailure(status: number, body: string): OpenAiTranscriptionError {
  if (status === 401) {
    return new OpenAiTranscriptionError({
      reason: "OpenAI rejected the API key (HTTP 401). Check the key in Settings.",
      retryable: false,
    });
  }
  if (status === 413) {
    return new OpenAiTranscriptionError({
      reason: "OpenAI refused the recording as too large (HTTP 413).",
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
    audioRejected: rejectsAudio(status, body),
  });
}

/** Turns an uploaded recording into text with the user's OpenAI key. */
export const makeOpenAiTranscription: Effect.Effect<
  OpenAiTranscription,
  never,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const transcriptionUrl = yield* Config.String(OPENAI_TRANSCRIPTION_URL_ENV).pipe(
    Config.withDefault(OPENAI_TRANSCRIPTION_URL),
    Effect.orElseSucceed(() => OPENAI_TRANSCRIPTION_URL),
  );

  const transcribe = Effect.fn("OpenAiTranscription.transcribe")(function (
    request: OpenAiTranscriptionRequest,
  ) {
    const useWhisper = request.durationMs > LONG_RECORDING_THRESHOLD_MS;
    const form = new FormData();
    form.append("file", new Blob([request.audio]), request.fileName);
    form.append("model", useWhisper ? "whisper-1" : "gpt-4o-transcribe");
    // gpt-4o-transcribe answers only in json; whisper-1 takes it too, so both parse one shape.
    form.append("response_format", "json");
    form.append("prompt", transcriptionPrompt(useWhisper, request.vocabularyHints));
    form.append("temperature", "0");
    const httpRequest = HttpClientRequest.post(transcriptionUrl).pipe(
      HttpClientRequest.bearerToken(request.apiKey),
      HttpClientRequest.bodyFormData(form),
    );

    const attempt = Effect.gen(function* () {
      const response = yield* client.execute(httpRequest);
      if (response.status < 200 || response.status >= 300) {
        const errorBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* statusFailure(response.status, errorBody);
      }
      const body = yield* response.text;
      const decoded = yield* decodeTranscriptionBody(body).pipe(
        Effect.mapError(
          () =>
            new OpenAiTranscriptionError({
              reason: "OpenAI answered in an unexpected format.",
              retryable: false,
            }),
        ),
      );
      const text = decoded.text.trim();
      if (text.length === 0) {
        return yield* new OpenAiTranscriptionError({
          reason: "No speech detected",
          retryable: false,
          audioRejected: true,
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
  });

  return { transcribe };
});
