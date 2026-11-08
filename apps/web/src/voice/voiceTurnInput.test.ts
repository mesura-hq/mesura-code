// Entry point: buildVoiceTurnInput, the turn ChatView's dispatchVoiceRequest starts for each
// voice request.
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildVoiceTurnInput,
  dispatchVoiceTurn,
  type VoiceTurnComposerSelection,
  type VoiceTurnDispatchHost,
} from "./voiceTurnInput";

const selection: VoiceTurnComposerSelection = {
  selectedModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  selectedProvider: ProviderDriverKind.make("codex"),
  selectedModel: "gpt-5.5",
  selectedProviderModels: [],
  selectedPromptEffort: null,
  interactionMode: "plan",
};

const request = {
  delegationId: "delegation-1",
  messageId: "voice-message-1",
  commandId: "voice-command-1",
  text: "Explain the failing test.",
  context: {
    mode: "discuss" as const,
    voice: "marin" as const,
    language: "es" as const,
    handsFree: true,
    transcript: [{ role: "user" as const, text: "Explain the failing test." }],
  },
};

describe("voice turn input", () => {
  it("voice turn uses the request's ids, the composer's selections and no draft content", () => {
    const input = buildVoiceTurnInput({
      threadId: "thread-1" as never,
      request,
      selection,
      runtimeMode: "approval-required",
      createdAt: "2026-11-08T12:00:00.000Z",
    });
    // The call correlates its run by these exact ids.
    expect(input.commandId).toBe("voice-command-1");
    expect(input.message.messageId).toBe("voice-message-1");
    // The spoken words stay verbatim; voice instructions ride as structured context.
    expect(input.message.text).toBe("Explain the failing test.");
    expect(input.message.context?.voice).toMatchObject({ mode: "discuss", handsFree: true });
    expect(input.message.context?.records).toEqual([]);
    expect(input.message.attachments).toEqual([]);
    expect(input.modelSelection).toBe(selection.selectedModelSelection);
    expect(input.interactionMode).toBe("plan");
    expect(input.runtimeMode).toBe("approval-required");
  });

  it("voice turn queues behind an active run instead of steering it", () => {
    const input = buildVoiceTurnInput({
      threadId: "thread-1" as never,
      request,
      selection,
      runtimeMode: "full-access",
      createdAt: "2026-11-08T12:00:00.000Z",
    });
    expect(input.dispatchMode).toBe("queue");
  });
});

const success = { _tag: "Success", value: undefined } as never;

const makeHost = (overrides: Partial<VoiceTurnDispatchHost> = {}) => {
  const host = {
    threadReady: true,
    threadId: "thread-1" as never,
    runtimeMode: "full-access" as const,
    readSelection: () => ({ ...selection, providerAvailable: true }),
    sendInFlight: { current: false },
    beginLocalDispatch: vi.fn(),
    resetLocalDispatch: vi.fn(),
    persistSettings: vi.fn(async () => success),
    startTurn: vi.fn(async () => success),
    onAccepted: vi.fn(),
    ...overrides,
  } satisfies VoiceTurnDispatchHost;
  return host;
};

describe("voice turn dispatch", () => {
  it("voice dispatch acknowledges only after the thread accepts the turn", async () => {
    const host = makeHost();
    await dispatchVoiceTurn(request, () => true, host);
    expect(host.startTurn).toHaveBeenCalledOnce();
    expect(host.onAccepted).toHaveBeenCalledOnce();
    expect(host.resetLocalDispatch).not.toHaveBeenCalled();
    expect(host.sendInFlight.current).toBe(false);
  });

  it("voice dispatch sends nothing when the call hangs up during settings persistence", async () => {
    let active = true;
    const host = makeHost({
      persistSettings: vi.fn(async () => {
        active = false;
        return success;
      }),
    });
    await expect(dispatchVoiceTurn(request, () => active, host)).rejects.toThrow(/call ended/);
    expect(host.startTurn).not.toHaveBeenCalled();
    expect(host.onAccepted).not.toHaveBeenCalled();
    expect(host.resetLocalDispatch).toHaveBeenCalledOnce();
    expect(host.sendInFlight.current).toBe(false);
  });

  it("voice dispatch refuses a busy thread without touching its send state", async () => {
    const host = makeHost({ sendInFlight: { current: true } });
    await expect(dispatchVoiceTurn(request, () => true, host)).rejects.toThrow(/not ready/);
    expect(host.beginLocalDispatch).not.toHaveBeenCalled();
    expect(host.sendInFlight.current).toBe(true);
  });
});
