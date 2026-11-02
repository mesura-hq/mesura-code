import type { ModelSelection, ProjectId, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";

/**
 * The model a new draft takes from its project: the configured default, swapped
 * for the configured fallback while the default's provider is out of usage.
 * Without a configured default, the project's first selectable provider is the
 * candidate for that check when `providerDefaultAllowed` holds.
 */
export function resolveNewDraftDefaultModelSelection(input: {
  readonly configuredSelection: ModelSelection | null;
  readonly providerDefaultAllowed: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings | undefined;
  readonly projectId: ProjectId;
}): ModelSelection | null {
  const { configuredSelection, settings } = input;
  const resolution = resolveNewThreadModelSelection({
    defaultSelection:
      configuredSelection ??
      (input.providerDefaultAllowed && settings
        ? resolveProjectDefaultProviderModelSelection(input.providers, settings, input.projectId)
        : null),
    fallbackSelection: settings?.fallbackModelSelection ?? null,
    providers: input.providers,
    ...(settings ? { settings } : {}),
    projectId: input.projectId,
    now: Date.now(),
  });
  return resolution.fallback ? resolution.selection : configuredSelection;
}
