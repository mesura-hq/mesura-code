import type {
  FactoryPhaseMarkTone,
  FactoryRunTone,
} from "@t3tools/client-runtime/factory/run-presentation";

// Status hues shared with the web: sky running, amber waiting or stopped,
// emerald done, rose degraded.
export const FACTORY_TEXT_BY_TONE: Record<FactoryRunTone, string> = {
  info: "text-adaptive-sky-600-400",
  warning: "text-adaptive-amber-700-300",
  success: "text-adaptive-emerald-700-300",
  error: "text-adaptive-rose-700-300",
};

export const FACTORY_MARK_BY_TONE: Record<FactoryPhaseMarkTone, string> = {
  ...FACTORY_TEXT_BY_TONE,
  neutral: "text-foreground-tertiary",
};
