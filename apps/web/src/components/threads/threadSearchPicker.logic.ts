import {
  scoreThreadTokenMatch,
  type ThreadSearchFields,
} from "@t3tools/client-runtime/state/thread-token-search";

import {
  enumerateCommandPaletteItems,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../CommandPalette.logic";

/** How many rows stand in for results before anything is typed, so the picker
    also works as a fast way back to what you were doing. */
export const THREAD_SEARCH_RECENT_LIMIT = 30;

export const THREAD_SEARCH_RECENT_GROUP = "thread-search-recent";
export const THREAD_SEARCH_TITLE_GROUP = "thread-search-titles";
export const THREAD_SEARCH_CONTENT_GROUP = "thread-search-content";

/** The value `buildThreadActionItems` puts on every thread row, and the key
    this module joins a row back to its thread by. */
export function threadSearchItemValue(threadId: string): string {
  return `thread:${threadId}`;
}

export interface ThreadSearchCandidate {
  readonly item: CommandPaletteActionItem;
  readonly fields: ThreadSearchFields;
  /** Whether the server found the word it was asked for in this thread's messages. */
  readonly hasContentMatch: boolean;
}

interface ThreadSearchCandidateThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch?: string | null;
  /** This thread's `threadSearchMatchKey`, built by the caller. A thread's
      identity is its environment and its id together, and the caller is where
      the branded values for both live. */
  readonly matchKey: string;
}

/**
 * Pairs each rendered row with the text its thread is searched by.
 *
 * A row carries presentation only, so the searchable text comes from the
 * thread it was built from, joined on the row's value. A row with no thread
 * behind it is dropped rather than searched on its rendered text, which would
 * quietly match on things like a status badge.
 */
export function buildThreadSearchCandidates(input: {
  readonly items: ReadonlyArray<CommandPaletteActionItem>;
  readonly threads: ReadonlyArray<ThreadSearchCandidateThread>;
  readonly projectTitleById: ReadonlyMap<string, string>;
  /** Keyed by `threadSearchMatchKey`, so a hit in one environment cannot be
      read as a hit in another that happens to share a thread id. */
  readonly contentMatchKeys: ReadonlySet<string>;
}): ThreadSearchCandidate[] {
  // Keyed by thread id alone, because that is all the row carries: upstream's
  // `buildThreadActionItems` sets `value` to `thread:<id>` with no environment
  // in it. Do not "fix" this to a composite key without changing that value
  // first — the lookup would then miss every row. The content-match set below
  // is keyed properly, because this module owns both sides of it.
  const threadById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const prefix = threadSearchItemValue("");

  const candidates: ThreadSearchCandidate[] = [];
  for (const item of input.items) {
    if (!item.value.startsWith(prefix)) continue;
    const thread = threadById.get(item.value.slice(prefix.length));
    if (thread === undefined) continue;

    candidates.push({
      item,
      fields: {
        title: thread.title,
        projectTitle: input.projectTitleById.get(thread.projectId) ?? null,
        branch: thread.branch ?? null,
      },
      hasContentMatch: input.contentMatchKeys.has(thread.matchKey),
    });
  }
  return candidates;
}

interface RankedCandidate {
  readonly candidate: ThreadSearchCandidate;
  readonly score: number;
  readonly index: number;
}

/** Best first, and equal scores keep the order they arrived in, which is
    recency. The index tiebreak is explicit rather than leaning on the sort
    being stable. */
function rankedItems(ranked: ReadonlyArray<RankedCandidate>): CommandPaletteActionItem[] {
  return ranked
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate.item);
}

/** Numbers the rows across every heading at once, so mod+1..9 counts down the
    list the user sees instead of restarting under each heading. */
function numberedGroups(
  sections: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly items: ReadonlyArray<CommandPaletteActionItem>;
  }>,
): CommandPaletteGroup[] {
  const numbered = enumerateCommandPaletteItems(sections.flatMap((section) => section.items));

  const groups: CommandPaletteGroup[] = [];
  let offset = 0;
  for (const section of sections) {
    if (section.items.length === 0) continue;
    groups.push({
      value: section.value,
      label: section.label,
      items: numbered.slice(offset, offset + section.items.length),
    });
    offset += section.items.length;
  }
  return groups;
}

/**
 * The picker's rows, grouped.
 *
 * With no query the recent threads stand in for results. With a query, rows
 * that match on their own text come first and rows that match only because the
 * server found the word inside their messages follow: a title hit is a
 * stronger answer to "find that thread" than a passing mention.
 */
export function buildThreadSearchGroups(input: {
  readonly candidates: ReadonlyArray<ThreadSearchCandidate>;
  readonly tokens: ReadonlyArray<string>;
  readonly contentToken: string | null;
  readonly recentLimit?: number;
}): CommandPaletteGroup[] {
  if (input.tokens.length === 0) {
    return numberedGroups([
      {
        value: THREAD_SEARCH_RECENT_GROUP,
        label: "Recent threads",
        items: input.candidates
          .slice(0, input.recentLimit ?? THREAD_SEARCH_RECENT_LIMIT)
          .map((candidate) => candidate.item),
      },
    ]);
  }

  const byFields: RankedCandidate[] = [];
  const byContent: RankedCandidate[] = [];

  input.candidates.forEach((candidate, index) => {
    const fieldScore = scoreThreadTokenMatch({
      fields: candidate.fields,
      tokens: input.tokens,
    });
    if (fieldScore !== null) {
      byFields.push({ candidate, score: fieldScore, index });
      return;
    }
    if (!candidate.hasContentMatch || input.contentToken === null) return;

    const contentScore = scoreThreadTokenMatch({
      fields: candidate.fields,
      tokens: input.tokens,
      contentToken: input.contentToken,
      hasContentMatch: true,
    });
    if (contentScore !== null) {
      byContent.push({ candidate, score: contentScore, index });
    }
  });

  return numberedGroups([
    { value: THREAD_SEARCH_TITLE_GROUP, label: "Threads", items: rankedItems(byFields) },
    { value: THREAD_SEARCH_CONTENT_GROUP, label: "In messages", items: rankedItems(byContent) },
  ]);
}

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
  for (const turn of turns.toReversed()) {
    const added = kept.length === 0 ? turn.length : turn.length + 1;
    if (kept.length > 0 && length + added > maxLength) break;
    kept.unshift(turn);
    length += added;
  }
  return kept.join("\n").slice(0, maxLength);
}

interface AgentSearchCoverageInput {
  readonly unavailableEnvironments: ReadonlyArray<{ readonly label: string }>;
  readonly budgetExhausted: boolean;
  readonly unreadEvidence: boolean;
}

/**
 * Plain sentences for every way a search fell short of complete coverage, in
 * the order a reader should weigh them. Empty when the search saw everything.
 */
export function describeAgentSearchCoverage(coverage: AgentSearchCoverageInput): string[] {
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

/** The row value of one agent result, keyed by environment and thread together. */
export function agentSearchResultValue(match: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return `agent-thread:${match.environmentId}:${match.threadId}`;
}
