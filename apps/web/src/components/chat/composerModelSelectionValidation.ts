import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { getStartedThreadModelChangeBlockReason } from "../ChatView.logic";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";

/**
 * The thread restrictions on changing the composer's model, shared by
 * model-only changes and complete combined-picker choices. Nothing here
 * writes; callers write only after an accepted decision.
 */

export interface ComposerModelSelectionFeedback {
  title: string;
  description: string;
}

export type ComposerModelSelectionDecision =
  | { accepted: true; modelSelection: ModelSelection }
  | { accepted: false; feedback: ComposerModelSelectionFeedback | null };

export function resolveComposerModelSelection(input: {
  instanceId: ProviderInstanceId;
  model: string;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  lockedProvider: ProviderDriverKind | null;
  thread: {
    modelSelection: ModelSelection;
    session: { providerInstanceId?: ProviderInstanceId | undefined } | null;
  };
  /**
   * Complete choices must name a model the exact instance offers. A model-only
   * change keeps the historical fallback to the instance's default model.
   */
  requireOfferedModel: boolean;
  /**
   * The composer's saved model for this instance. A complete choice may
   * re-apply it while the instance's catalog no longer lists it, as an
   * unavailable OpenCode or Antigravity selection.
   */
  savedModel: string | null;
}): ComposerModelSelectionDecision {
  const rejected = { accepted: false, feedback: null } as const;
  // Look up the configured instance so model normalization and custom model
  // lookup stay scoped to that exact instance. Unknown instance ids are
  // rejected; the server remains authoritative too.
  const entry = input.providers.find((snapshot) => snapshot.instanceId === input.instanceId);
  const driverKind = entry?.driver ?? null;
  if (input.lockedProvider !== null && driverKind !== null && driverKind !== input.lockedProvider) {
    return rejected;
  }
  const sessionInstanceId = input.thread.session?.providerInstanceId;
  if (input.lockedProvider !== null && sessionInstanceId) {
    const currentEntry = input.providers.find(
      (snapshot) => snapshot.instanceId === sessionInstanceId,
    );
    if (
      currentEntry?.continuation?.groupKey &&
      entry?.continuation?.groupKey &&
      currentEntry.continuation.groupKey !== entry.continuation.groupKey
    ) {
      return rejected;
    }
  }
  const resolvedModel = resolveAppModelSelectionForInstance(
    input.instanceId,
    input.settings,
    input.providers,
    input.model,
    input.requireOfferedModel
      ? {
          fallbackToDefault: false,
          preserveUnavailableSelection: input.savedModel === input.model,
        }
      : undefined,
  );
  if (!resolvedModel) {
    return rejected;
  }
  const modelSelection: ModelSelection = { instanceId: input.instanceId, model: resolvedModel };
  const blockReason = getStartedThreadModelChangeBlockReason({
    providers: input.providers,
    hasStartedSession: input.thread.session !== null,
    currentModelSelection: input.thread.modelSelection,
    currentProviderInstanceId: sessionInstanceId ?? null,
    nextModelSelection: modelSelection,
  });
  if (blockReason) {
    return { accepted: false, feedback: blockReason };
  }
  return { accepted: true, modelSelection };
}
