import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type { VoiceAgentRequest } from "@t3tools/client-runtime/voice-conversation/controller";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolvePromptInjectedEffort } from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../providerModels";

/** The composer selections a voice request uses, read when the request is sent. */
export interface VoiceTurnComposerSelection {
  readonly selectedModelSelection: ModelSelection;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedModel: string;
  readonly selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  readonly selectedPromptEffort: string | null;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * The turn for one voice request. The spoken text stays verbatim and the voice instructions travel
 * as structured context. The composer's draft and attachments are never part of it.
 *
 * The request queues behind an active run instead of steering it: the call only sends when the
 * thread is idle, and a run that starts in between must keep its own input.
 */
export function buildVoiceTurnInput(input: {
  readonly threadId: ThreadId;
  readonly request: VoiceAgentRequest;
  readonly selection: VoiceTurnComposerSelection;
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
}): StartThreadTurnInput {
  const { request, selection } = input;
  return {
    threadId: input.threadId,
    commandId: CommandId.make(request.commandId),
    message: {
      messageId: MessageId.make(request.messageId),
      role: "user",
      text: request.text,
      context: {
        version: 1,
        records: [],
        voice: {
          ...request.context,
          promptEffort: resolvePromptInjectedEffort(
            getProviderModelCapabilities(
              selection.selectedProviderModels,
              selection.selectedModel,
              selection.selectedProvider,
            ),
            selection.selectedPromptEffort,
          ),
        },
      },
      attachments: [],
    },
    modelSelection: selection.selectedModelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: selection.interactionMode,
    dispatchMode: "queue",
    createdAt: input.createdAt,
  };
}

/** What ChatView lends one voice dispatch, read when the call sends the request. */
export interface VoiceTurnDispatchHost {
  /** The thread can take a request now: loaded, connected, idle and operable. */
  readonly threadReady: boolean;
  readonly threadId: ThreadId | null;
  readonly runtimeMode: RuntimeMode;
  readonly readSelection: () =>
    | (VoiceTurnComposerSelection & { providerAvailable: boolean })
    | undefined;
  readonly sendInFlight: { current: boolean };
  readonly beginLocalDispatch: () => void;
  readonly resetLocalDispatch: () => void;
  readonly persistSettings: (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
  readonly startTurn: (input: StartThreadTurnInput) => Promise<AtomCommandResult<unknown, unknown>>;
  /** Runs once the thread accepted the turn. */
  readonly onAccepted: () => void;
}

/**
 * Sends one voice request as a turn with the composer's current agent, effort and modes, persisted
 * like a typed send. `isCallActive` is checked again after each await: a hangup revokes the
 * request synchronously. It lives outside ChatView because React Compiler cannot compile
 * `try`/`finally` or `throw` inside `try`, and one such function makes it skip the whole component.
 */
export async function dispatchVoiceTurn(
  request: VoiceAgentRequest,
  isCallActive: () => boolean,
  host: VoiceTurnDispatchHost,
): Promise<void> {
  if (!isCallActive() || !host.threadReady || host.threadId === null || host.sendInFlight.current) {
    throw new Error("The thread is not ready for a voice request. Try again when it is ready.");
  }
  const selection = host.readSelection();
  if (!selection?.providerAvailable) throw new Error("Select an available agent in the composer.");
  const threadId = host.threadId;
  const createdAt = new Date().toISOString();
  host.sendInFlight.current = true;
  host.beginLocalDispatch();
  try {
    const settingsResult = await host.persistSettings({
      threadId,
      createdAt,
      interactionMode: selection.interactionMode,
    });
    if (settingsResult._tag === "Failure") throw squashAtomCommandFailure(settingsResult);
    if (!isCallActive()) throw new Error("The call ended before the request was sent.");
    const result = await host.startTurn(
      buildVoiceTurnInput({
        threadId,
        request,
        selection,
        runtimeMode: host.runtimeMode,
        createdAt,
      }),
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    host.onAccepted();
  } catch (error) {
    host.resetLocalDispatch();
    throw error;
  } finally {
    host.sendInFlight.current = false;
  }
}
