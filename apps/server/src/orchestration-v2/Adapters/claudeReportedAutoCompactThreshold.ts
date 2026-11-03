// Mesura: the context meter measures against the threshold Claude itself reports. Claude
// resolves it from every settings source (managed settings, user settings, the instance's
// "Auto-compact after"), so the meter stays right when the window is set outside Mesura.

/** The part of the SDK's `getContextUsage` answer that decides automatic compaction. */
export interface ClaudeContextUsageCompaction {
  readonly autoCompactThreshold?: number;
  readonly isAutoCompactEnabled: boolean;
}

/** `null` when Claude does not compact on its own or reports no usable threshold. */
export function claudeReportedAutoCompactThreshold(
  usage: ClaudeContextUsageCompaction,
): number | null {
  const threshold = usage.autoCompactThreshold;
  return usage.isAutoCompactEnabled &&
    typeof threshold === "number" &&
    Number.isFinite(threshold) &&
    threshold > 0
    ? Math.round(threshold)
    : null;
}

/**
 * Replaces the settings-derived threshold with the reported one. `undefined` means Claude
 * has not answered yet, so the settings value stays; `null` removes the threshold.
 */
export function withClaudeReportedAutoCompactThreshold<
  Usage extends { readonly autoCompactThreshold?: number },
>(usage: Usage, reported: number | null | undefined): Usage {
  if (reported === undefined) return usage;
  const { autoCompactThreshold: _settingsThreshold, ...rest } = usage;
  return (reported === null ? rest : { ...rest, autoCompactThreshold: reported }) as Usage;
}
