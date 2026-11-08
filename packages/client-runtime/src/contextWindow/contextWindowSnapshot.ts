// Mesura: the context-window snapshot lives here rather than in `apps/web/src/lib/contextWindow.ts`
// so the indicator's presentation and request modules beside it share one source. The derivation
// below is upstream's v2 one (live usage, provider thread usage, compaction items), plus the
// cache-creation pair and a capital M for millions.
import type {
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderThread,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructure, ThreadStructureTurnItem } from "../state/models.ts";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export type ContextWindowLimitSource = Pick<ContextWindowSnapshot, "maxTokens"> & {
  readonly autoCompactThreshold?: number | null;
};

/**
 * Where the context stops growing: the auto-compact threshold when the provider reports
 * one, otherwise the model's window. The meter's ring, percentage and right label measure
 * against it, so a 1M model that compacts at 717k reads `538k ◔ 717k`.
 */
export function contextWindowLimitTokens(usage: ContextWindowLimitSource): number | null {
  const threshold = usage.autoCompactThreshold ?? null;
  if (threshold !== null && threshold > 0) return threshold;
  const maxTokens = usage.maxTokens ?? null;
  return maxTokens !== null && maxTokens > 0 ? maxTokens : null;
}

function contextWindowShares(
  usedTokens: number,
  limitTokens: number | null,
): Pick<ContextWindowSnapshot, "remainingTokens" | "usedPercentage" | "remainingPercentage"> {
  if (limitTokens === null) {
    return { remainingTokens: null, usedPercentage: null, remainingPercentage: null };
  }
  const usedPercentage = Math.min(100, (usedTokens / limitTokens) * 100);
  return {
    remainingTokens: Math.max(0, Math.round(limitTokens - usedTokens)),
    usedPercentage,
    remainingPercentage: Math.max(0, 100 - usedPercentage),
  };
}

/** Newest usage report across a thread's provider turns. Snapshots order turns
    by provider thread, not time, so pick by timestamp. */
export function latestProviderTurnTokenUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "tokenUsage">>,
  projection?: Pick<ThreadStructure, "thread" | "contextTransfers"> | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage"> | null,
): OrchestrationV2ProviderTurnTokenUsage | null {
  let latest: OrchestrationV2ProviderTurnTokenUsage | null = null;
  for (const { tokenUsage } of turns) {
    if (tokenUsage === undefined) continue;
    // Ties go to the later entry, since live upserts append.
    if (latest === null || Date.parse(tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = tokenUsage;
    }
  }
  if (latest !== null || projection == null || providerThread?.contextUsage != null) return latest;
  const forkedFrom = projection.thread.forkedFrom;
  if (forkedFrom?.type !== "run") return null;
  return (
    projection.contextTransfers.find(
      (transfer) =>
        transfer.type === "fork" &&
        transfer.targetThreadId === projection.thread.id &&
        transfer.sourceThreadId === forkedFrom.threadId &&
        transfer.sourcePoint.runId === forkedFrom.runId &&
        transfer.sourceProviderInstanceId === projection.thread.modelSelection.instanceId &&
        (transfer.status === "pending" || transfer.resolution?.strategy === "native_fork"),
    )?.sourceTokenUsage ?? null
  );
}

export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: ThreadStructureTurnItem;
  }>,
  liveUsage?: OrchestrationV2ProviderTurnTokenUsage | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage" | "updatedAt"> | null,
): ContextWindowSnapshot | null {
  if (liveUsage != null) {
    const usedTokens = Math.max(0, liveUsage.usedTokens);
    const maxTokens = liveUsage.maxTokens ?? null;
    const autoCompactThreshold = liveUsage.autoCompactThreshold ?? null;
    return {
      usedTokens,
      totalProcessedTokens: null,
      maxTokens,
      ...contextWindowShares(
        usedTokens,
        contextWindowLimitTokens({ maxTokens, autoCompactThreshold }),
      ),
      inputTokens: liveUsage.inputTokens ?? null,
      cachedInputTokens: liveUsage.cachedInputTokens ?? null,
      cacheCreationTokens: liveUsage.cacheCreationTokens ?? null,
      outputTokens: liveUsage.outputTokens ?? null,
      reasoningOutputTokens: liveUsage.reasoningOutputTokens ?? null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastCacheCreationTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold,
      cost: null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  if (
    providerUsage !== null &&
    providerUsage !== undefined &&
    providerUsageUpdatedAt !== undefined
  ) {
    const maxTokens = asFiniteNumber(providerUsage.maxTokens);
    const usedTokens = providerUsage.usedTokens;
    const autoCompactThreshold = providerUsage.autoCompactThreshold ?? null;
    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(providerUsage.totalProcessedTokens),
      maxTokens,
      ...contextWindowShares(
        usedTokens,
        contextWindowLimitTokens({ maxTokens, autoCompactThreshold }),
      ),
      inputTokens: asFiniteNumber(providerUsage.inputTokens),
      cachedInputTokens: asFiniteNumber(providerUsage.cachedInputTokens),
      cacheCreationTokens: asFiniteNumber(providerUsage.cacheCreationTokens),
      outputTokens: asFiniteNumber(providerUsage.outputTokens),
      reasoningOutputTokens: asFiniteNumber(providerUsage.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(providerUsage.lastUsedTokens),
      lastInputTokens: asFiniteNumber(providerUsage.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(providerUsage.lastCachedInputTokens),
      lastCacheCreationTokens: asFiniteNumber(providerUsage.lastCacheCreationTokens),
      lastOutputTokens: asFiniteNumber(providerUsage.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(providerUsage.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(providerUsage.toolUses),
      durationMs: asFiniteNumber(providerUsage.durationMs),
      compactsAutomatically: providerUsage.compactsAutomatically ?? null,
      cost: providerUsage.cost ?? null,
      autoCompactThreshold,
      updatedAt: DateTime.formatIso(providerUsageUpdatedAt),
    };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.item.type !== "compaction") {
      continue;
    }
    const payload = entry.item;
    const usedTokens = asFiniteNumber(payload.afterTokenCount);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload.beforeTokenCount),
      maxTokens: null,
      ...contextWindowShares(usedTokens, null),
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastCacheCreationTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: null,
      cost: null,
      updatedAt: DateTime.formatIso(payload.startedAt ?? payload.updatedAt),
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
