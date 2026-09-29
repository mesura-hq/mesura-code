import type { FactoryRunShellSummary } from "@t3tools/contracts";
import {
  factoryRunLabel,
  type FactoryRunTone,
} from "@t3tools/client-runtime/factory/run-presentation";

// The sidebar's status hues (sky working, amber attention, emerald done, red
// failed), the same family the Android thread list row uses for this label.
const CLASS_BY_TONE: Record<FactoryRunTone, string> = {
  info: "text-sky-600 dark:text-sky-400",
  warning: "text-amber-700 dark:text-amber-300",
  success: "text-emerald-700 dark:text-emerald-300",
  error: "text-red-700 dark:text-red-300",
};

/** A thread row's Software Factory label, such as `phase 5/11 · Review`; nothing without a run. */
export function FactoryRunThreadLabel({ run }: { run: FactoryRunShellSummary | null | undefined }) {
  const label = factoryRunLabel(run);
  if (label === null) return null;
  return (
    <span className={`shrink-0 whitespace-nowrap ${CLASS_BY_TONE[label.tone]}`}>{label.text}</span>
  );
}
