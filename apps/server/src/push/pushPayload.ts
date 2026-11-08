/**
 * Mesura: the notification a thread's awareness state becomes on a phone.
 *
 * Only the project title, the thread title and a fixed reason line leave the
 * host. Message text, command output and the relay's failure detail stay
 * behind: the push service relays the payload, and a lock screen shows it.
 */
import type { PushNotificationPayload, PushPreferences } from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";

/** The phases a device can ask to be told about, each behind one preference. */
export const PUSH_PREFERENCE_BY_PHASE = {
  waiting_for_approval: "approval",
  waiting_for_input: "input",
  failed: "failed",
  completed: "completed",
} as const satisfies Partial<Record<AgentAwarenessPhase, keyof PushPreferences>>;

export type PushPhase = keyof typeof PUSH_PREFERENCE_BY_PHASE;

export const isPushPhase = (phase: AgentAwarenessPhase): phase is PushPhase =>
  Object.hasOwn(PUSH_PREFERENCE_BY_PHASE, phase);

function reasonLine(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "waiting_for_approval":
      return "needs your approval";
    case "waiting_for_input":
      return "is asking you a question";
    case "failed":
      return "failed";
    case "completed":
      return "finished";
    // Never pushed; named so the switch stays exhaustive.
    case "starting":
      return "is starting";
    case "running":
      return "is working";
    case "stale":
      return "stopped reporting";
  }
}

export function buildPushPayload(state: AgentAwarenessState): PushNotificationPayload {
  return {
    title: state.projectTitle,
    body: `${state.threadTitle}\n${reasonLine(state.phase)}`,
    tag: `thread:${state.environmentId}:${state.threadId}`,
    // The web router's thread route. The awareness `deepLink` carries a
    // `/threads/` prefix the web router does not serve.
    url: `/${encodeURIComponent(state.environmentId)}/${encodeURIComponent(state.threadId)}`,
  };
}
