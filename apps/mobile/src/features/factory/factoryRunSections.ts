import type { FactoryRunStreamItem } from "@t3tools/contracts";
import {
  deriveFactoryPhaseView,
  deriveFactoryRunRail,
  type FactoryPhaseView,
  type FactoryRailItem,
} from "@t3tools/client-runtime/factory/run-view";

/** The phases the reader opened or closed; any other phase is open while it runs. */
export type FactoryPhaseOverrides = ReadonlyMap<number, boolean>;

export interface FactoryRunSection {
  readonly phase: FactoryRailItem;
  /** The phase's spine, roles and record while it is open; null while folded. */
  readonly view: FactoryPhaseView | null;
}

export interface FactoryRunSections {
  readonly rail: ReadonlyArray<FactoryRailItem>;
  readonly sections: ReadonlyArray<FactoryRunSection>;
}

/**
 * The Android Run tab's sections, one per phase, from one stream item. Every
 * item arrives decoded, so the shared model compares by value against the
 * previous sections: a phase the item did not change keeps its rail entry and
 * its view, and its memoized section skips the render.
 */
export function deriveFactoryRunSections(
  item: FactoryRunStreamItem,
  overrides: FactoryPhaseOverrides,
  previous: FactoryRunSections | null,
): FactoryRunSections {
  const rail = deriveFactoryRunRail(item.state, null, previous?.rail);
  const sections = rail.map((phase) => {
    const open = overrides.get(phase.index) ?? phase.status === "running";
    const before = previous?.sections.find((section) => section.phase.index === phase.index);
    const view = open
      ? deriveFactoryPhaseView({ item, phaseIndex: phase.index, previous: before?.view ?? null })
      : null;
    return before !== undefined && before.phase === phase && before.view === view
      ? before
      : { phase, view };
  });
  return { rail, sections };
}
