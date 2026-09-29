import { factoryNodeDisplayName } from "@t3tools/client-runtime/factory/run-presentation";
import { CheckIcon, CircleDotIcon, CircleSlashIcon, CornerDownLeftIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { FactorySpineNodeStatus, FactorySpineView } from "./factoryRunView.logic";
import { FACTORY_MARK_CLASS_BY_TONE } from "./factoryTones";

const NODE_TONE = {
  done: "success",
  current: "info",
  pending: "neutral",
  stopped: "warning",
} as const satisfies Record<FactorySpineNodeStatus, keyof typeof FACTORY_MARK_CLASS_BY_TONE>;

// Static icons only: the node in flight is marked by colour and a dot, never
// an animation (a repainting spinner pegs the GPU on high-refresh displays).
function NodeIcon({ status }: { status: FactorySpineNodeStatus }) {
  if (status === "done") return <CheckIcon aria-hidden className="size-3 shrink-0" />;
  if (status === "current") return <CircleDotIcon aria-hidden className="size-3 shrink-0" />;
  if (status === "stopped") return <CircleSlashIcon aria-hidden className="size-3 shrink-0" />;
  return null;
}

/**
 * The selected phase's spine: Build, Harden and Close as rows of nodes, and
 * under them every return as a readable line that names where the phase went
 * back in.
 */
export const FactoryNodeSpine = memo(function FactoryNodeSpine({
  spine,
}: {
  spine: FactorySpineView;
}) {
  return (
    <div className="space-y-2">
      {spine.stages.map((stage) => (
        <div key={stage.stage} className="flex flex-wrap items-center gap-1.5">
          <span className="w-14 shrink-0 text-[.65rem] font-medium uppercase tracking-wide text-muted-foreground">
            {stage.stage}
          </span>
          <ol className="flex flex-wrap items-center gap-1" aria-label={`${stage.stage} nodes`}>
            {stage.nodes.map((node) => (
              <li
                key={node.node}
                aria-label={`${node.label}: ${node.status}`}
                aria-current={node.status === "current" ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs",
                  FACTORY_MARK_CLASS_BY_TONE[NODE_TONE[node.status]],
                )}
              >
                <NodeIcon status={node.status} />
                {node.label}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {spine.returns.length === 0 ? null : (
        <ol className="ml-4 space-y-1 border-l border-border/60 pl-3" aria-label="Returns">
          {spine.returns.map((edge) => (
            <li key={edge.text} className="flex gap-1.5 text-xs text-muted-foreground">
              <CornerDownLeftIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0">
                <span className="text-foreground">{edge.text}</span>
                <span className="ml-1.5 whitespace-nowrap">
                  {edge.pending
                    ? `→ ${factoryNodeDisplayName(edge.to)}, in progress`
                    : `→ back in at ${factoryNodeDisplayName(edge.to)}`}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});
