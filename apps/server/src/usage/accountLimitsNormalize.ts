/** Provider payload normalization for account subscription limits. */
import type { AccountLimitsMeter, AccountLimitsWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

export interface NormalizedAccountLimits {
  readonly plan: string | null;
  readonly windows: readonly AccountLimitsWindow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoFromUnixSeconds(value: number): string | null {
  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  try {
    return DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
  } catch {
    return null;
  }
}

function meter(id: string | null, label: string | null): AccountLimitsMeter | undefined {
  if (id === null) return undefined;
  return { id, label: label ?? id };
}

function windowRank(window: AccountLimitsWindow): number {
  if (window.id === "five_hour") return 0;
  if (window.id === "seven_day") return 1;
  return 2;
}

function sortWindows(windows: readonly AccountLimitsWindow[]): readonly AccountLimitsWindow[] {
  return [...windows].sort(
    (left, right) =>
      windowRank(left) - windowRank(right) ||
      (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0) ||
      left.id.localeCompare(right.id),
  );
}

interface ClaudeWindowMeta {
  readonly id: string;
  readonly label: string;
  readonly minutes: number | null;
  readonly meter?: AccountLimitsMeter;
}

function humanizeWindowKey(key: string): string {
  const name = key.startsWith("seven_day_") ? key.slice("seven_day_".length) : key;
  return name.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function claudeWindowMeta(key: string): ClaudeWindowMeta | null {
  if (key === "extra_usage" || key === "overage" || key === "limits") return null;
  if (key === "five_hour") {
    return { id: "five_hour", label: "5h", minutes: FIVE_HOUR_MINUTES };
  }
  if (key === "seven_day") {
    return { id: "seven_day", label: "7d", minutes: SEVEN_DAY_MINUTES };
  }

  const scopedLabel =
    key === "iguana_necktie" || /fable/i.test(key) ? "Fable" : humanizeWindowKey(key);
  const scopedId = scopedLabel === "Fable" ? "fable" : key;
  return {
    id: scopedId,
    label: scopedLabel,
    minutes: key.startsWith("seven_day") || scopedLabel === "Fable" ? SEVEN_DAY_MINUTES : null,
    meter: { id: scopedId, label: scopedLabel },
  };
}

function claudeWindowFromValues(
  meta: ClaudeWindowMeta,
  usedPercent: number | null,
  resetsAt: string | null,
): AccountLimitsWindow | null {
  if (usedPercent === null) return null;
  return {
    id: meta.id,
    label: meta.label,
    usedPercent: clampPercent(usedPercent ?? 0),
    resetsAt,
    windowMinutes: meta.minutes,
    ...(meta.meter ? { meter: meta.meter } : {}),
  };
}

function claudeFlatWindow(key: string, value: unknown): AccountLimitsWindow | null {
  const meta = claudeWindowMeta(key);
  if (meta === null || !isRecord(value)) return null;
  return claudeWindowFromValues(meta, readNumber(value.utilization), readString(value.resets_at));
}

function claudeArrayWindow(value: unknown): AccountLimitsWindow | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (kind === null) return null;

  if (kind === "session") {
    return claudeWindowFromValues(
      { id: "five_hour", label: "5h", minutes: FIVE_HOUR_MINUTES },
      readNumber(value.percent),
      readString(value.resets_at),
    );
  }
  if (kind === "weekly_all") {
    return claudeWindowFromValues(
      { id: "seven_day", label: "7d", minutes: SEVEN_DAY_MINUTES },
      readNumber(value.percent),
      readString(value.resets_at),
    );
  }
  if (kind !== "weekly_scoped") return null;

  const scope = isRecord(value.scope) ? value.scope : null;
  const model = scope && isRecord(scope.model) ? scope.model : null;
  const modelId = model ? readString(model.id) : null;
  const displayName = model ? (readString(model.display_name) ?? modelId) : null;
  if (displayName === null) return null;
  const isFable = /fable/i.test(displayName);
  const id = isFable
    ? "fable"
    : `scoped_${(modelId ?? displayName).replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase()}`;
  const label = isFable ? "Fable" : displayName;
  return claudeWindowFromValues(
    { id, label, minutes: SEVEN_DAY_MINUTES, meter: { id, label } },
    readNumber(value.percent),
    readString(value.resets_at),
  );
}

export function normalizeClaudeAccountLimits(value: unknown): NormalizedAccountLimits | null {
  if (!isRecord(value)) return null;
  const rateLimits = value.rate_limits;
  if (rateLimits === null) {
    return { plan: readString(value.subscription_type), windows: [] };
  }
  if (!isRecord(rateLimits)) return null;

  const windows = new Map<string, AccountLimitsWindow>();
  for (const [key, entry] of Object.entries(rateLimits)) {
    const window = claudeFlatWindow(key, entry);
    if (window) windows.set(window.id, window);
  }
  if (Array.isArray(rateLimits.limits)) {
    for (const entry of rateLimits.limits) {
      const window = claudeArrayWindow(entry);
      if (window) windows.set(window.id, window);
    }
  }

  return {
    plan: readString(value.subscription_type),
    windows: sortWindows([...windows.values()]),
  };
}

export function normalizeClaudeRateLimitEvent(value: unknown): AccountLimitsWindow | null {
  if (!isRecord(value) || !isRecord(value.rate_limit_info)) return null;
  const info = value.rate_limit_info;
  const key = readString(info.rateLimitType);
  if (key === null) return null;
  const meta = claudeWindowMeta(key);
  if (meta === null) return null;
  const resetSeconds = readNumber(info.resetsAt);
  const resetsAt = resetSeconds === null ? null : isoFromUnixSeconds(resetSeconds);
  if (info.resetsAt != null && resetsAt === null) return null;
  return claudeWindowFromValues(meta, readNumber(info.utilization), resetsAt);
}

function codexWindow(
  value: unknown,
  slot: "primary" | "secondary",
  currentMeter: AccountLimitsMeter | undefined,
): AccountLimitsWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = readNumber(value.usedPercent ?? value.used_percent);
  if (usedPercent === null) return null;
  const rawMinutes = value.windowDurationMins ?? value.window_minutes;
  const minutes = readNumber(rawMinutes);
  if (rawMinutes != null && (minutes === null || !Number.isInteger(minutes) || minutes <= 0)) {
    return null;
  }
  const resetSeconds = readNumber(value.resetsAt ?? value.resets_at);
  const resetsAt = resetSeconds === null ? null : isoFromUnixSeconds(resetSeconds);
  if ((value.resetsAt ?? value.resets_at) != null && resetsAt === null) return null;
  if (usedPercent === 0 && resetSeconds === null) return null;

  const effectiveMinutes = minutes ?? (slot === "primary" ? FIVE_HOUR_MINUTES : SEVEN_DAY_MINUTES);
  const id =
    effectiveMinutes === FIVE_HOUR_MINUTES
      ? "five_hour"
      : effectiveMinutes === SEVEN_DAY_MINUTES
        ? "seven_day"
        : `window_${effectiveMinutes}m`;
  const label =
    id === "five_hour"
      ? "5h"
      : id === "seven_day"
        ? "7d"
        : effectiveMinutes % (24 * 60) === 0
          ? `${effectiveMinutes / (24 * 60)}d`
          : `${Math.max(1, Math.round(effectiveMinutes / 60))}h`;

  return {
    id,
    label,
    usedPercent: clampPercent(usedPercent),
    resetsAt,
    windowMinutes: effectiveMinutes,
    ...(currentMeter ? { meter: currentMeter } : {}),
  };
}

export function normalizeCodexAccountLimits(value: unknown): NormalizedAccountLimits | null {
  if (!isRecord(value)) return null;
  const snapshot = isRecord(value.rateLimits) ? value.rateLimits : value;
  const meterId = readString(snapshot.limitId ?? snapshot.limit_id);
  const meterLabel = readString(snapshot.limitName ?? snapshot.limit_name);
  const currentMeter = meter(meterId, meterLabel ?? (meterId === "codex" ? "Codex" : null));
  const windows = [
    codexWindow(snapshot.primary, "primary", currentMeter),
    codexWindow(snapshot.secondary, "secondary", currentMeter),
  ].filter((window): window is AccountLimitsWindow => window !== null);

  if (
    windows.length === 0 &&
    meterId === null &&
    readString(snapshot.planType ?? snapshot.plan_type) === null
  ) {
    return null;
  }
  return {
    plan: readString(snapshot.planType ?? snapshot.plan_type),
    windows: sortWindows(windows),
  };
}
