import { cn } from "~/lib/utils";

import type { GitChangeBucket, GitChangesSummary as Summary } from "./treeDiff.logic";

/**
 * The side summary from Symmetria IDE's Active Changes header: one row per side
 * that has files. The glyph shapes carry the side and stay neutral, so green
 * and red keep meaning added and removed lines everywhere in the surface.
 */
const BUCKETS = [
  { key: "staged", glyph: "●", label: "staged" },
  { key: "unstaged", glyph: "○", label: "unstaged" },
  { key: "untracked", glyph: "✦", label: "untracked" },
] as const satisfies ReadonlyArray<{ key: keyof Summary; glyph: string; label: string }>;

export function TreeDiffSummary(props: {
  readonly summary: Summary;
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const visibleBuckets = BUCKETS.filter((bucket) => props.summary[bucket.key].files > 0);
  if (visibleBuckets.length === 0 && props.summary.conflicted === 0) return null;
  return (
    <div
      className={cn(
        "flex text-[11px] text-muted-foreground",
        props.compact ? "flex-row flex-wrap gap-x-3 gap-y-0.5" : "flex-col gap-0.5",
        props.className,
      )}
    >
      {props.summary.conflicted > 0 ? (
        <div className="flex items-center gap-1.5 text-warning">
          <span aria-hidden="true" className="w-3 text-center">
            !
          </span>
          <span>{props.summary.conflicted} conflicted</span>
        </div>
      ) : null}
      {visibleBuckets.map((bucket) => (
        <BucketRow
          key={bucket.key}
          glyph={bucket.glyph}
          label={bucket.label}
          bucket={props.summary[bucket.key]}
          compact={props.compact ?? false}
        />
      ))}
    </div>
  );
}

function BucketRow(props: {
  glyph: string;
  label: string;
  bucket: GitChangeBucket;
  compact: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 tabular-nums">
      <span aria-hidden="true" className="w-3 text-center text-foreground/80">
        {props.glyph}
      </span>
      {props.compact ? null : <span className="w-16">{props.label}</span>}
      {/* Zero sides are left out, as in the IDE: untracked files never have deletions. */}
      {props.bucket.insertions > 0 ? (
        <span className="font-mono text-diff-addition">+{props.bucket.insertions}</span>
      ) : null}
      {props.bucket.deletions > 0 ? (
        <span className="font-mono text-diff-deletion">-{props.bucket.deletions}</span>
      ) : null}
      <span className="text-muted-foreground/70">
        ({props.bucket.files}
        {props.compact ? ` ${props.label}` : ""})
      </span>
    </div>
  );
}
