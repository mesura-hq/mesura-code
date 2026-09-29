import { CheckIcon, ChevronRight } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { factoryRailTone, type FactoryRailItem } from "./factoryRunView.logic";
import { FACTORY_MARK_CLASS_BY_TONE } from "./factoryTones";

/**
 * The run's phases in order, one entry per phase with its state, in the class
 * vocabulary of the Agents panel's phase rail. Picking an entry shows that
 * phase below.
 */
export const FactoryPhaseRail = memo(function FactoryPhaseRail({
  items,
  onSelect,
}: {
  items: ReadonlyArray<FactoryRailItem>;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1" aria-label="Phases">
      {items.map((item, position) => (
        <li key={item.index} className="flex min-w-0 items-center gap-1">
          {position > 0 ? (
            <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/40" />
          ) : null}
          <button
            type="button"
            aria-label={`Phase ${item.index}: ${item.status} — ${item.title}`}
            aria-pressed={item.selected}
            onClick={() => onSelect(item.index)}
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-sm text-left border px-1.5 py-0.5 font-mono text-[.65rem]",
              FACTORY_MARK_CLASS_BY_TONE[factoryRailTone(item.status)],
              item.selected && "bg-accent",
            )}
          >
            {item.status === "clean" ? <CheckIcon aria-hidden className="size-3 shrink-0" /> : null}
            <span className="shrink-0">{item.index}</span>
            <span className="min-w-0">{item.title}</span>
          </button>
        </li>
      ))}
    </ol>
  );
});
