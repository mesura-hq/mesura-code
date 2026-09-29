import type { EnvironmentId } from "@t3tools/contracts";

import type {
  AgentThreadSearchCoverage,
  AgentThreadSearchEnvironment,
  AgentThreadSearchResult,
} from "./agentThreadSearch.ts";

// What the web and mobile agent-search surfaces tell the user about a search:
// the description they send, the environment whose model reasons, and the
// wording of every verdict. Kept here so both clients say the same thing.

export const AGENT_SEARCH_PROGRESS_TEXT = "Searching connected environments…";
export const AGENT_SEARCH_NO_ENVIRONMENT_TEXT =
  "No environment is connected, so there is nothing to search.";
export const AGENT_SEARCH_HINT_TEXT =
  "Describe a conversation in your own words — a topic, a decision, a project. Every connected environment is searched, archived threads included.";
export const AGENT_SEARCH_UNEXPECTED_FAILURE_TEXT = "The search failed unexpectedly. Try again.";

/**
 * The description one agent search sends: every turn of the popup
 * conversation, oldest first, so a refinement such as "it was on the laptop"
 * keeps the subject it refines. The coordinator clamps an overlong description
 * from its end, which would cut the newest turn, so the oldest turns are
 * dropped here instead. A single turn longer than the limit keeps its start.
 */
export function composeAgentSearchDescription(
  turns: ReadonlyArray<string>,
  maxLength: number,
): string {
  const kept: string[] = [];
  let length = 0;
  // Newest first, by index: mobile runs this on Hermes, which lacks Array#toReversed.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const added = kept.length === 0 ? turn.length : turn.length + 1;
    if (kept.length > 0 && length + added > maxLength) break;
    kept.unshift(turn);
    length += added;
  }
  return kept.join("\n").slice(0, maxLength);
}

/**
 * The environment whose configured text model reasons about a search: the
 * preferred one while it is among the searched environments, else the first.
 * Null when nothing is connected.
 */
export function resolveAgentSearchModelEnvironmentId(
  environments: ReadonlyArray<AgentThreadSearchEnvironment>,
  preferredEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    preferredEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === preferredEnvironmentId)
  ) {
    return preferredEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

/**
 * Plain sentences for every way a search fell short of complete coverage, in
 * the order a reader should weigh them. Empty when the search saw everything.
 */
export function describeAgentSearchCoverage(
  coverage: Pick<AgentThreadSearchCoverage, "budgetExhausted" | "unreadEvidence"> & {
    readonly unavailableEnvironments: ReadonlyArray<{ readonly label: string }>;
  },
): string[] {
  const notes: string[] = [];
  if (coverage.unavailableEnvironments.length > 0) {
    const labels = coverage.unavailableEnvironments.map((environment) => environment.label);
    notes.push(
      `Could not reach ${labels.join(", ")}, so ${labels.length === 1 ? "its" : "their"} threads were not searched.`,
    );
  }
  if (coverage.budgetExhausted) {
    notes.push("The search stopped at its work limit, so older matches may be missing.");
  }
  if (coverage.unreadEvidence) {
    notes.push("Some matching messages were found but not reviewed.");
  }
  return notes;
}

/**
 * The verdict line of a settled search that found no thread to show: an
 * `alert` for a failure, a `status` for no confident match. Null when the
 * search returned matches.
 */
export function describeAgentSearchVerdict(
  result: AgentThreadSearchResult,
): { readonly tone: "alert" | "status"; readonly text: string } | null {
  switch (result.status) {
    case "matches":
      return null;
    case "noConfidentMatch":
      return {
        tone: "status",
        text: "No confident match. Add a detail you remember and search again.",
      };
    case "failed":
      return {
        tone: "alert",
        text:
          result.failure === "model"
            ? "The search model failed. Try again, or check the text model in Settings."
            : "Could not read thread history from the connected environments. Try again.",
      };
  }
}
