import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TextGenerationError } from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

const OpenCodeTextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateThreadSearchStep",
]);

/** How long cleaning up a search step's session may take before the step fails. */
const OPENCODE_SESSION_CLEANUP_TIMEOUT_MS = 5_000;
/** The share of that bound an abort may use, so the delete is always attempted. */
const OPENCODE_SESSION_ABORT_TIMEOUT_MS = 2_000;

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedError<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedError<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedError<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedError<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedError<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
) {
  const host = yield* ProviderHost.ProviderHost;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(
    input: TextGenerationOperations.Request<S>,
  ) {
    /**
     * Mesura: an untrusted prompt (a thread search step) is bounded and its
     * OpenCode session deleted afterwards, so no transcript outlives it. Other
     * tasks keep their sessions and OpenCode's own limits.
     */
    const ephemeralSession =
      input.untrustedInput === true
        ? {
            timeout:
              input.timeoutMs === undefined ? Duration.infinity : Duration.millis(input.timeoutMs),
          }
        : undefined;
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
      resolveAttachmentPath: host.resolveAttachmentPath,
    });

    /**
     * The session an ephemeral step owns, from the moment `session.create` is
     * sent. The ID stays a promise: a step cancelled or timed out while
     * creation is in flight still owns the session that arrives later.
     */
    let ownedSession:
      | {
          readonly client: ReturnType<
            OpenCodeRuntime.OpenCodeRuntime["Service"]["createOpenCodeSdkClient"]
          >;
          readonly sessionID: Promise<string | undefined>;
        }
      | undefined;

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
      function* (
        server: Pick<
          OpenCodeRuntime.OpenCodeServerConnection,
          "url" | "serverPassword" | "version"
        >,
      ) {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: input.cwd,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        });
        const session = yield* Effect.tryPromise({
          // Deliberately not cancelled: an aborted request can still create a
          // session whose ID never arrives, which nothing could then delete.
          try: () => {
            const request = client.session.create({
              title: `Mesura Code ${input.operation}`,
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            });
            if (ephemeralSession !== undefined) {
              ownedSession = {
                client,
                sessionID: request.then(
                  (created) => created.data?.id,
                  () => undefined,
                ),
              };
            }
            return request;
          },
          catch: (cause) =>
            new OpenCodeTextGenerationSessionRequestError({
              operation: input.operation,
              cwd: input.cwd,
              cause,
            }),
        });
        if (!session.data) {
          return yield* new OpenCodeTextGenerationSessionPayloadError({
            operation: input.operation,
            cwd: input.cwd,
          });
        }
        const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
        const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const promptContext = {
          operation: input.operation,
          cwd: input.cwd,
          sessionId: session.data.id,
          providerId: parsedModel.providerID,
          modelId: parsedModel.modelID,
        };

        const result = yield* Effect.tryPromise({
          try: () =>
            client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(selectedAgent ? { agent: selectedAgent } : {}),
              ...(selectedVariant ? { variant: selectedVariant } : {}),
              parts: [{ type: "text", text: input.prompt }, ...fileParts],
            }),
          catch: (cause) =>
            new OpenCodeTextGenerationPromptRequestError({
              ...promptContext,
              cause,
            }),
        });
        const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
        if (promptFailure) {
          return yield* new OpenCodeTextGenerationPromptResponseError({
            ...promptContext,
            ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
            providerMessage: promptFailure.message,
          });
        }
        const responseParts = result.data?.parts ?? [];
        const rawText = getOpenCodeTextResponse(responseParts);
        if (rawText.length === 0) {
          return yield* new OpenCodeTextGenerationEmptyOutputError({
            ...promptContext,
            responsePartCount: responseParts.length,
            textPartCount: responseParts.filter(isOpenCodeTextPart).length,
          });
        }
        return rawText;
      },
      Effect.catchTags({
        OpenCodeTextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.prompt request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCodeTextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode returned empty output.",
              cause,
            }),
          ),
      }),
    );

    /**
     * Delete the session this step created, aborting it first when it may
     * still be running. Bounded, and a failure is reported rather than
     * swallowed: the caller must not be told no transcript remains.
     */
    const deleteCreatedSession = (options: {
      readonly abortFirst: boolean;
      readonly context: string;
    }) =>
      Effect.suspend(() => {
        const owned = ownedSession;
        if (owned === undefined) return Effect.void;
        const cleanupFailed = (cause?: unknown) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `${options.context}OpenCode could not delete the session, so its transcript may remain.`,
            ...(cause !== undefined ? { cause } : {}),
          });
        return Effect.gen(function* () {
          const sessionID = yield* Effect.promise(() => owned.sessionID);
          // Creation failed, so no session exists.
          if (sessionID === undefined) return;
          if (options.abortFirst) {
            // Bounded apart from the delete, so a stalled abort cannot skip it.
            yield* Effect.tryPromise(() => owned.client.session.abort({ sessionID })).pipe(
              Effect.timeoutOption(OPENCODE_SESSION_ABORT_TIMEOUT_MS),
              Effect.ignore,
            );
          }
          yield* Effect.tryPromise(() => owned.client.session.delete({ sessionID })).pipe(
            Effect.mapError(cleanupFailed),
          );
        }).pipe(
          Effect.timeoutOption(OPENCODE_SESSION_CLEANUP_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.sync(() => {
                  // Past the bound the step reports failure, but a session
                  // that arrives later is still deleted when it does.
                  void owned.sessionID.then((sessionID) =>
                    sessionID === undefined
                      ? undefined
                      : owned.client.session.delete({ sessionID }).catch(() => undefined),
                  );
                }).pipe(Effect.andThen(Effect.fail(cleanupFailed()))),
              onSome: () => Effect.void,
            }),
          ),
        );
      });

    const runEphemeralAgainstServer = (
      server: Parameters<typeof runAgainstServer>[0],
      timeout: Duration.Duration,
    ) =>
      runAgainstServer(server).pipe(
        Effect.timeoutOption(timeout),
        // A cancelled search leaves nothing behind either, but cannot report it.
        Effect.onInterrupt(() =>
          deleteCreatedSession({ abortFirst: true, context: "" }).pipe(Effect.ignore),
        ),
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isFailure(exit)) {
            return deleteCreatedSession({ abortFirst: false, context: "" }).pipe(
              Effect.andThen(Effect.failCause(exit.cause)),
            );
          }
          if (Option.isNone(exit.value)) {
            return deleteCreatedSession({
              abortFirst: true,
              context: "OpenCode request timed out. ",
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: "OpenCode request timed out.",
                  }),
                ),
              ),
            );
          }
          return deleteCreatedSession({ abortFirst: false, context: "" }).pipe(
            Effect.as(exit.value.value),
          );
        }),
      );

    const useServer = (server: Parameters<typeof runAgainstServer>[0]) =>
      ephemeralSession === undefined
        ? runAgainstServer(server)
        : runEphemeralAgainstServer(server, ephemeralSession.timeout);

    const serverOutput =
      openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory: input.cwd,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(useServer), Effect.scoped)
        : serverOwner.withServer(useServer);
    const rawOutput = yield* serverOutput.pipe(
      Effect.catchTags({
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
              cause,
            }),
          ),
      }),
    );

    return yield* TextGenerationOperations.decodeJsonReply(input, "OpenCode", rawOutput);
  });

  return TextGenerationOperations.fromRunner("OpenCodeTextGeneration", runOpenCodeJson);
});
