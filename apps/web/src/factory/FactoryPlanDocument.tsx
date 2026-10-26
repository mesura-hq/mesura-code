import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { ContextChip } from "../components/ContextChip";
import { FileTagChipContent } from "../components/chat/FileTagChip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useTheme } from "../hooks/useTheme";
import {
  deriveFactoryPlanDocumentModel,
  type FactoryPlanPhaseCard,
  type FactoryPlanSectionModel,
} from "@t3tools/client-runtime/factory/plan-model";
import { FACTORY_PHASES_HEADING, type FactoryArchitecture } from "@t3tools/shared/factoryDocument";
import { MermaidDiagram } from "./MermaidDiagram";
import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";

export interface MarkdownScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  /** The thread whose file panel opens the document's file links. */
  readonly threadRef?: ScopedThreadRef | undefined;
}

export function Markdown({ text, scope }: { text: string; scope: MarkdownScope }) {
  if (text.trim() === "") return null;
  return (
    <ChatMarkdown
      text={text}
      cwd={scope.cwd}
      environmentId={scope.environmentId}
      threadRef={scope.threadRef}
    />
  );
}

/** Closed until the reader opens it, unless `defaultOpen`; the panel mounts its content only while open. */
export function Fold({
  summary,
  children,
  defaultOpen = false,
  label,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** The trigger's accessible name, when the summary is not text. */
  label?: string;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        aria-label={label}
        className="group flex w-full items-center gap-1.5 text-left text-sm text-foreground/90"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 flex-1">{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-2 pl-5">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function FactoryPlanPhaseCardView({
  phase,
  scope,
  theme,
}: {
  phase: FactoryPlanPhaseCard;
  scope: MarkdownScope;
  theme: "light" | "dark";
}) {
  const fileKeys = occurrenceKeys(phase.files);
  const criterionKeys = occurrenceKeys(phase.acceptance);
  return (
    <article className="rounded-2xl border border-border/70 bg-card/60 p-4">
      <h3 className="text-sm font-medium text-foreground">
        <span className="mr-2 text-muted-foreground tabular-nums">Phase {phase.number}</span>
        {phase.title}
      </h3>
      {phase.goal ? <p className="mt-2 text-sm text-foreground/80">{phase.goal}</p> : null}
      {phase.files.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {phase.files.map((file, index) => (
            <Tooltip key={fileKeys[index]}>
              <TooltipTrigger render={<ContextChip kind="mention" />}>
                <FileTagChipContent
                  path={file}
                  label={file.split("/").at(-1) ?? file}
                  theme={theme}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{file}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ) : null}
      <ol className="mt-3 flex list-decimal flex-col gap-1 pl-5 text-sm text-foreground/85">
        {phase.acceptance.map((criterion, index) => (
          <li key={criterionKeys[index]}>
            <Markdown text={criterion} scope={scope} />
          </li>
        ))}
      </ol>
      {phase.detail ? (
        <div className="mt-3">
          <Fold summary="How, in detail">
            <Markdown text={phase.detail} scope={scope} />
          </Fold>
        </div>
      ) : null}
    </article>
  );
}

export function FactoryPlanSectionBody({
  section,
  scope,
  theme,
}: {
  section: FactoryPlanSectionModel;
  scope: MarkdownScope;
  theme: "light" | "dark";
}) {
  switch (section.kind) {
    case "markdown":
      return <Markdown text={section.body} scope={scope} />;
    case "phases":
      return (
        <div className="flex flex-col gap-3">
          {section.phases.map((phase) => (
            <FactoryPlanPhaseCardView
              key={phase.number}
              phase={phase}
              scope={scope}
              theme={theme}
            />
          ))}
        </div>
      );
    case "decisions": {
      const decisionKeys = occurrenceKeys(section.decisions.map((entry) => entry.verdict));
      return (
        <div className="flex flex-col gap-3">
          {section.decisions.map((decision, index) => (
            <div key={decisionKeys[index]} className="flex flex-col gap-1">
              <Markdown text={decision.verdict} scope={scope} />
              {decision.argument === "" ? null : (
                <Fold summary={<span className="text-xs text-muted-foreground">Why</span>}>
                  <Markdown text={decision.argument} scope={scope} />
                </Fold>
              )}
            </div>
          ))}
        </div>
      );
    }
    case "architecture":
      return <ArchitectureBody architecture={section} scope={scope} theme={theme} />;
  }
}

/** An Architecture section of a plan or a report: the diagram drawn, its reading, its legend. */
export function ArchitectureBody({
  architecture,
  scope,
  theme,
}: {
  architecture: FactoryArchitecture;
  scope: MarkdownScope;
  theme: "light" | "dark";
}) {
  return (
    <div className="flex flex-col gap-3">
      {architecture.diagram !== null ? (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/60">
          <MermaidDiagram source={architecture.diagram} theme={theme} />
        </div>
      ) : null}
      <Markdown text={architecture.body} scope={scope} />
      {architecture.legend.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {architecture.legend.map((entry) => (
            <div key={entry.id} className="contents">
              <dt className="font-mono text-xs text-foreground">{entry.id}</dt>
              <dd className="text-foreground/80">
                <Markdown text={entry.text} scope={scope} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * A whole plan, every level-two section in document order: the phases as
 * cards, the decisions with their arguments folded, the architecture drawn.
 */
export const FactoryPlanDocument = memo(function FactoryPlanDocument({
  markdown,
  environmentId,
  cwd,
  threadRef,
}: {
  markdown: string;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const document = useMemo(() => deriveFactoryPlanDocumentModel(markdown), [markdown]);
  const scope = useMemo(() => ({ environmentId, cwd, threadRef }), [environmentId, cwd, threadRef]);
  const sectionKeys = useMemo(
    () => occurrenceKeys(document.sections.map((section) => section.heading)),
    [document],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">{document.title || "Plan"}</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          {document.sectionCount} {document.sectionCount === 1 ? "section" : "sections"}
        </p>
      </header>
      {document.sections.map((section, index) => (
        <section key={sectionKeys[index]} className="flex flex-col gap-2">
          {section.kind === "markdown" && section.folded ? (
            <Fold summary={<span className="text-base font-medium">{section.heading}</span>}>
              <Markdown text={section.body} scope={scope} />
            </Fold>
          ) : (
            <>
              <h2 className="text-base font-medium text-foreground">{section.heading}</h2>
              <FactoryPlanSectionBody section={section} scope={scope} theme={resolvedTheme} />
            </>
          )}
        </section>
      ))}
    </div>
  );
});

/** What a reader needs before approving opens with the card; every other section waits folded. */
const PLAN_CARD_OPEN_SECTIONS: ReadonlySet<string> = new Set([
  "Context",
  "What we will build",
  FACTORY_PHASES_HEADING,
]);

/**
 * A whole plan inside its chat card: every level-two section in document order
 * as a fold, the approval-critical ones open, and each phase a fold whose
 * summary carries its title, criterion count and goal.
 */
export const FactoryPlanFolds = memo(function FactoryPlanFolds({
  markdown,
  environmentId,
  cwd,
  threadRef,
}: {
  markdown: string;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  /** The thread whose file panel opens the plan's file links. */
  threadRef: ScopedThreadRef | null;
}) {
  const { resolvedTheme } = useTheme();
  const document = useMemo(() => deriveFactoryPlanDocumentModel(markdown), [markdown]);
  const scope = useMemo(
    () => ({ environmentId, cwd, threadRef: threadRef ?? undefined }),
    [environmentId, cwd, threadRef],
  );
  const sectionKeys = useMemo(
    () => occurrenceKeys(document.sections.map((section) => section.heading)),
    [document],
  );
  return (
    <div className="flex flex-col gap-3">
      {document.sections.map((section, index) => {
        const summary = <span className="font-medium">{section.heading}</span>;
        const open = PLAN_CARD_OPEN_SECTIONS.has(section.heading);
        return (
          <Fold key={sectionKeys[index]} summary={summary} defaultOpen={open}>
            {section.kind === "phases" ? (
              <div className="flex flex-col gap-2">
                {section.phases.map((phase) => (
                  <Fold
                    key={phase.number}
                    summary={
                      <span className="flex flex-col">
                        <span>
                          <span className="mr-1.5 text-muted-foreground tabular-nums">
                            {phase.number}.
                          </span>
                          {phase.title}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {phase.acceptance.length}{" "}
                          {phase.acceptance.length === 1 ? "criterion" : "criteria"}
                          {phase.goal ? ` · ${phase.goal}` : null}
                        </span>
                      </span>
                    }
                  >
                    <FactoryPlanPhaseCardView phase={phase} scope={scope} theme={resolvedTheme} />
                  </Fold>
                ))}
              </div>
            ) : (
              <FactoryPlanSectionBody section={section} scope={scope} theme={resolvedTheme} />
            )}
          </Fold>
        );
      })}
    </div>
  );
});
