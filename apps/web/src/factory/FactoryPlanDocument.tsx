import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { CHAT_FILE_TAG_CHIP_CLASS_NAME, FileTagChipContent } from "../components/chat/FileTagChip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useTheme } from "../hooks/useTheme";
import {
  deriveFactoryPlanDocumentModel,
  type FactoryPlanPhaseCard,
  type FactoryPlanSectionModel,
} from "@t3tools/client-runtime/factory/plan-model";
import type { FactoryArchitecture } from "@t3tools/shared/factoryDocument";
import { MermaidDiagram } from "./MermaidDiagram";
import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";

export interface MarkdownScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
}

export function Markdown({ text, scope }: { text: string; scope: MarkdownScope }) {
  if (text.trim() === "") return null;
  return <ChatMarkdown text={text} cwd={scope.cwd} environmentId={scope.environmentId} />;
}

/** Closed until the reader opens it; the panel mounts its content only while open. */
export function Fold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left text-sm text-foreground/90">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0">{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-2 pl-5">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function PhaseCard({
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
              <TooltipTrigger render={<span className={CHAT_FILE_TAG_CHIP_CLASS_NAME} />}>
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

function SectionBody({
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
            <PhaseCard key={phase.number} phase={phase} scope={scope} theme={theme} />
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
}: {
  markdown: string;
  environmentId: EnvironmentId;
  cwd: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const document = useMemo(() => deriveFactoryPlanDocumentModel(markdown), [markdown]);
  const scope = useMemo(() => ({ environmentId, cwd }), [environmentId, cwd]);
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
              <SectionBody section={section} scope={scope} theme={resolvedTheme} />
            </>
          )}
        </section>
      ))}
    </div>
  );
});
