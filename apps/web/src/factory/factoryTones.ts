import type { FactoryPhaseMarkTone } from "@t3tools/client-runtime/factory/run-presentation";

export { factoryEventClock } from "@t3tools/client-runtime/factory/run-presentation";

/**
 * The phase-mark vocabulary of the Agents panel's phase strip, shared by the
 * run card's marks and the Run tab's rail and spine.
 */
export const FACTORY_MARK_CLASS_BY_TONE: Record<FactoryPhaseMarkTone, string> = {
  info: "border-info/40 text-info-foreground",
  success: "border-success/30 text-success-foreground",
  error: "border-destructive/40 text-destructive-foreground",
  warning: "border-warning/40 text-warning-foreground",
  neutral: "border-border/50 text-muted-foreground/70",
};
