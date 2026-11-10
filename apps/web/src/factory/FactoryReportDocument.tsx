import type { EnvironmentId, FactoryRunState, ScopedThreadRef } from "@t3tools/contracts";
import {
  factoryCriterionResultLabel,
  type FactoryReportSection,
  type FactoryReportTryIt,
  type FactoryReportView,
} from "@t3tools/client-runtime/factory/report-view";
import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";
import type {
  FactoryCriterionEvidence,
  FactoryCriterionOutcome,
  FactoryPhaseVerification,
} from "@t3tools/shared/factoryRun";
import { deriveFactoryRunTrace } from "@t3tools/shared/factoryRunTrace";
import { CameraOffIcon } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import { ChatMarkdownAssetImage } from "../components/chat/ChatMarkdownMedia";
import { ExpandedImageDialog } from "../components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";
import { useTheme } from "../hooks/useTheme";
import { cn } from "~/lib/utils";
import { FactoryCostFloor } from "./FactoryCostFloor";
import { ArchitectureBody, Fold, Markdown, type MarkdownScope } from "./FactoryPlanDocument";
import { FactoryRunTrace, useFactoryTraceClock } from "./FactoryRunTrace";
import { FactoryRunUsageBlock } from "./FactoryRunUsageBlock";
import { onFoldTreeKeyDown } from "./foldKeyboard";

const ERROR_TEXT = "text-destructive-foreground";

/** Elapsed, machine and waiting time, and the cost: all from the run, never from report.md. */
function ClockBand({ view }: { view: FactoryReportView }) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
      <span>elapsed {view.clock.elapsed}</span>
      <span>machine {view.clock.machine}</span>
      <span>waiting {view.clock.waiting}</span>
      <span>
        {view.cost}
        {view.costIsFloor ? <FactoryCostFloor /> : null}
      </span>
    </p>
  );
}

/** Opens a capture in the app's media viewer, with the URL the thumbnail already resolved. */
type OpenEvidence = (preview: ExpandedImagePreview) => void;

/** One capture as a thumbnail; the image itself is served by a signed media URL. */
function EvidenceThumb({
  evidence,
  threadRef,
  onOpen,
}: {
  evidence: FactoryCriterionEvidence;
  threadRef: ScopedThreadRef;
  onOpen: OpenEvidence;
}) {
  return (
    <figure className="flex w-40 shrink-0 flex-col gap-1">
      <ChatMarkdownAssetImage
        environmentId={threadRef.environmentId}
        resource={{ _tag: "media-file", threadId: threadRef.threadId, path: evidence.path }}
        kind={evidence.kind}
        alt={evidence.caption}
        maxHeightRem={6}
        framed
        onImageExpand={onOpen}
        onVideoExpand={onOpen}
      />
      <figcaption className="line-clamp-2 text-search-label leading-snug text-muted-foreground">
        {evidence.source === "live" ? "Live" : "Test"}
        {evidence.viewport === null ? null : ` · ${evidence.viewport}`}: {evidence.caption}
      </figcaption>
    </figure>
  );
}

function CriterionRow({
  criterion,
  threadRef,
  onOpenEvidence,
}: {
  criterion: FactoryCriterionOutcome;
  threadRef: ScopedThreadRef | null;
  onOpenEvidence: OpenEvidence;
}) {
  const missingCapture = criterion.visual && criterion.evidence.length === 0;
  return (
    <li className="flex flex-col gap-1.5 border-b border-border/30 py-2 last:border-b-0">
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 text-xs">
        <span className="text-muted-foreground tabular-nums">{criterion.n}</span>
        {/* Plain text, as the record holds it: markdown would drop a `<date>` placeholder. */}
        <span className="min-w-0 text-foreground/90">{criterion.name}</span>
        <span
          className={cn(
            "whitespace-nowrap text-muted-foreground",
            criterion.result === "FAIL" && ERROR_TEXT,
            criterion.result === "NOT_EXERCISED" && "text-warning-foreground",
          )}
        >
          {factoryCriterionResultLabel(criterion.result)}
        </span>
      </div>
      {criterion.authoredTestsOnly || missingCapture ? (
        <div className="flex flex-wrap gap-1.5 pl-4 text-search-label">
          {criterion.authoredTestsOnly ? (
            <span className="rounded-sm border border-border/70 px-1 text-muted-foreground">
              authored tests only
            </span>
          ) : null}
          {missingCapture ? (
            <span className="flex items-center gap-1 rounded-sm border border-warning/50 px-1 text-warning-foreground">
              <CameraOffIcon aria-hidden="true" className="size-3" />
              shows something on screen, no capture
            </span>
          ) : null}
        </div>
      ) : null}
      {criterion.evidence.length === 0 || threadRef === null ? null : (
        <div className="flex gap-2 overflow-x-auto pb-1 pl-4">
          {criterion.evidence.map((evidence) => (
            <EvidenceThumb
              key={`${evidence.path}\u0000${evidence.caption}`}
              evidence={evidence}
              threadRef={threadRef}
              onOpen={onOpenEvidence}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/** Each phase's criteria with their result and captures, one fold per phase. */
function VerificationTable({
  verification,
  threadRef,
  onOpenEvidence,
}: {
  verification: ReadonlyArray<FactoryPhaseVerification>;
  threadRef: ScopedThreadRef | null;
  onOpenEvidence: OpenEvidence;
}) {
  return (
    <div className="flex flex-col gap-2">
      {verification.map((phase) => {
        const passed = phase.criteria.filter((criterion) => criterion.result === "PASS").length;
        const captures = phase.criteria.reduce(
          (sum, criterion) => sum + criterion.evidence.length,
          0,
        );
        const missing = phase.criteria.filter(
          (criterion) => criterion.visual && criterion.evidence.length === 0,
        ).length;
        return (
          <Fold
            key={phase.phase}
            summary={
              <span className="flex flex-col">
                <span className={cn(phase.degraded && ERROR_TEXT)}>
                  {phase.phase}. {phase.title}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {passed}/{phase.criteria.length} passed
                  {captures > 0
                    ? ` · ${captures} ${captures === 1 ? "capture" : "captures"}`
                    : null}
                  {missing > 0 ? ` · ${missing} without capture` : null}
                  {phase.degraded ? " · degraded" : null}
                </span>
              </span>
            }
          >
            <ol>
              {phase.criteria.map((criterion) => (
                <CriterionRow
                  key={criterion.n}
                  criterion={criterion}
                  threadRef={threadRef}
                  onOpenEvidence={onOpenEvidence}
                />
              ))}
            </ol>
          </Fold>
        );
      })}
    </div>
  );
}

/** The branch, its commits and the suites that prove the run, ready to run again. */
function TryIt({ tryIt }: { tryIt: FactoryReportTryIt }) {
  return (
    <div className="flex flex-col gap-3 text-xs">
      {tryIt.branch === null && tryIt.commits.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground">
            {tryIt.branch === null ? "Commits" : `Branch ${tryIt.branch}`}
            <span className="text-muted-foreground"> · {tryIt.commits.length} commits</span>
          </p>
          <ul className="flex flex-col gap-0.5 font-mono text-search-label text-muted-foreground">
            {tryIt.commits.map((commit) => (
              <li key={commit.hash} className="truncate">
                {commit.hash.slice(0, 10)} {commit.subject}
              </li>
            ))}
          </ul>
        </div>
      )}
      {tryIt.commands.length === 0 ? (
        <p className="text-muted-foreground">The run recorded no test suites to run again.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground">Run the suites again</p>
          <pre className="overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-search-label leading-relaxed text-foreground/85">
            {tryIt.commands
              .map((entry) =>
                entry.cwd === null ? entry.command : `(cd ${entry.cwd} && ${entry.command})`,
              )
              .join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

function SectionBody({
  section,
  view,
  scope,
  theme,
  threadRef,
  onOpenEvidence,
}: {
  section: FactoryReportSection;
  view: FactoryReportView;
  scope: MarkdownScope;
  theme: "light" | "dark";
  threadRef: ScopedThreadRef | null;
  onOpenEvidence: OpenEvidence;
}) {
  if (section.kind === "architecture") {
    return <ArchitectureBody architecture={section} scope={scope} theme={theme} />;
  }
  if (section.kind === "verification") {
    // The derived table first, then the author's comment on what it cannot show.
    return (
      <div className="flex flex-col gap-3">
        <VerificationTable
          verification={view.verification}
          threadRef={threadRef}
          onOpenEvidence={onOpenEvidence}
        />
        {section.body === null ? null : <Markdown text={section.body} scope={scope} />}
      </div>
    );
  }
  return <Markdown text={section.body} scope={scope} />;
}

/** The step record: one fold per phase, all closed until the reader opens one. */
function StepRecord({ view }: { view: FactoryReportView }) {
  return (
    <div className="flex flex-col gap-2">
      {view.steps.map((phase) => {
        const lineKeys = occurrenceKeys(phase.lines.map((line) => line.text));
        return (
          <Fold
            key={phase.phase}
            summary={
              <span className={cn(phase.degraded && ERROR_TEXT)}>
                Phase {phase.phase} · {phase.title}
              </span>
            }
          >
            <ol className="flex flex-col gap-0.5 text-xs text-foreground/80">
              {phase.lines.map((line, index) => (
                <li key={lineKeys[index]} className={cn(line.error && ERROR_TEXT)}>
                  {line.text}
                </li>
              ))}
            </ol>
          </Fold>
        );
      })}
    </div>
  );
}

function RunTrace({ state }: { state: FactoryRunState }) {
  const nowMs = useFactoryTraceClock(state.finishedAt === null);
  const trace = useMemo(() => deriveFactoryRunTrace(state, nowMs), [state, nowMs]);
  if (trace === null) return null;
  return <FactoryRunTrace trace={trace} />;
}

/**
 * A whole report: headings on a page (the Factory pane), folds in a card (the chat),
 * one frame from the run in both. Only a degraded phase, a failed result, a red check
 * and an unrepaired finding take the error tone.
 */
export const FactoryReportDocument = memo(function FactoryReportDocument({
  view,
  state,
  environmentId,
  cwd,
  threadRef,
  variant = "page",
}: {
  view: FactoryReportView;
  state: FactoryRunState;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  /** The thread the run is attached to: captures and the plan share are read through it. */
  threadRef: ScopedThreadRef | null;
  variant?: "page" | "card";
}) {
  const { resolvedTheme } = useTheme();
  const scope = useMemo(
    () => ({ environmentId, cwd, threadRef: threadRef ?? undefined }),
    [environmentId, cwd, threadRef],
  );
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const openEvidence: OpenEvidence = setPreview;

  const card = variant === "card";
  // In the card every section opens folded, so a finished run takes a few lines of the chat.
  const section = (heading: string, body: ReactNode, key: string = heading) =>
    card ? (
      <Fold key={key} summary={<span className="font-medium">{heading}</span>}>
        {body}
      </Fold>
    ) : (
      <section key={key} className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground">{heading}</h2>
        {body}
      </section>
    );
  const sectionKeys = occurrenceKeys(view.sections.map((entry) => entry.heading));

  return (
    <div
      className={cn("flex w-full flex-col", card ? "gap-3" : "mx-auto max-w-3xl gap-6 px-4 py-5")}
      data-key-scope="tree"
      onKeyDown={onFoldTreeKeyDown}
    >
      {card ? null : (
        <header className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold text-foreground">{view.title || "Report"}</h2>
          <ClockBand view={view} />
        </header>
      )}
      {view.missingNotice === null ? null : (
        <p className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
          {view.missingNotice}
        </p>
      )}
      {threadRef === null ? null : (
        <FactoryRunUsageBlock threadRef={threadRef} runId={state.runId} />
      )}
      {view.sections.map((entry, index) =>
        section(
          entry.heading,
          <SectionBody
            section={entry}
            view={view}
            scope={scope}
            theme={resolvedTheme}
            threadRef={threadRef}
            onOpenEvidence={openEvidence}
          />,
          sectionKeys[index],
        ),
      )}
      {section("Check it yourself", <TryIt tryIt={view.tryIt} />)}
      {section("The run", <RunTrace state={state} />)}
      {card ? null : section("The run, step by step", <StepRecord view={view} />)}
      {preview === null ? null : (
        <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
});
