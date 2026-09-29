import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";
import {
  deriveFactoryPlanDocumentModel,
  type FactoryPlanPhaseCard,
  type FactoryPlanSectionModel,
} from "@t3tools/client-runtime/factory/plan-model";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Markdown } from "react-native-nitro-markdown";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import type { FactoryArchitecture } from "@t3tools/shared/factoryDocument";
import { MermaidWebView } from "./MermaidWebView";

/** A plan section reads like a markdown file preview: links open outside the app. */
export function FactoryMarkdown(props: { readonly text: string }) {
  const styles = useMarkdownPreviewStyles();
  const onLinkPress = useCallback((href: string) => {
    void tryOpenExternalUrl(href, "markdown-link");
  }, []);
  if (props.text.trim() === "") return null;
  return hasNativeSelectableMarkdownText() ? (
    <SelectableMarkdownText
      markdown={props.text}
      onLinkPress={onLinkPress}
      textStyle={styles.nativeTextStyle}
    />
  ) : (
    <Markdown
      options={{ gfm: true }}
      renderers={styles.renderers}
      styles={styles.styles}
      theme={styles.theme}
    >
      {props.text}
    </Markdown>
  );
}

/** Closed until the reader opens it; the content mounts only while open. */
export function Fold(props: { readonly summary: ReactNode; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="min-h-9 flex-row items-center gap-1.5 active:opacity-65"
        onPress={() => setOpen((current) => !current)}
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        {props.summary}
      </Pressable>
      {open ? <View className="pl-4">{props.children}</View> : null}
    </View>
  );
}

function PhaseCard(props: { readonly phase: FactoryPlanPhaseCard }) {
  const { phase } = props;
  const fileKeys = occurrenceKeys(phase.files);
  const criterionKeys = occurrenceKeys(phase.acceptance);
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="gap-0.5">
        <Text className="text-xs text-foreground-muted tabular-nums">Phase {phase.number}</Text>
        <Text className="font-t3-bold text-sm text-foreground">{phase.title}</Text>
      </View>
      {phase.goal ? <Text className="text-sm text-foreground">{phase.goal}</Text> : null}
      {phase.files.length > 0 ? (
        <View className="flex-row flex-wrap gap-1">
          {phase.files.map((file, index) => (
            <Text
              key={fileKeys[index]}
              className="rounded-md bg-subtle px-1.5 py-0.5 font-mono text-xs text-foreground-muted"
            >
              {file}
            </Text>
          ))}
        </View>
      ) : null}
      <View className="gap-1.5">
        {phase.acceptance.map((criterion, index) => (
          <View key={criterionKeys[index]} className="flex-row gap-2">
            <Text className="min-w-5 text-sm text-foreground-muted tabular-nums">{index + 1}.</Text>
            <View className="min-w-0 flex-1">
              <FactoryMarkdown text={criterion} />
            </View>
          </View>
        ))}
      </View>
      {phase.detail ? (
        <Fold summary={<Text className="text-sm text-foreground">How, in detail</Text>}>
          <FactoryMarkdown text={phase.detail} />
        </Fold>
      ) : null}
    </View>
  );
}

function SectionBody(props: { readonly section: FactoryPlanSectionModel }) {
  const { section } = props;
  switch (section.kind) {
    case "markdown":
      return <FactoryMarkdown text={section.body} />;
    case "phases":
      return (
        <View className="gap-3">
          {section.phases.map((phase) => (
            <PhaseCard key={phase.number} phase={phase} />
          ))}
        </View>
      );
    case "decisions": {
      const decisionKeys = occurrenceKeys(section.decisions.map((entry) => entry.verdict));
      return (
        <View className="gap-3">
          {section.decisions.map((decision, index) => (
            <View key={decisionKeys[index]} className="gap-1">
              <FactoryMarkdown text={decision.verdict} />
              {decision.argument === "" ? null : (
                <Fold summary={<Text className="text-xs text-foreground-muted">Why</Text>}>
                  <FactoryMarkdown text={decision.argument} />
                </Fold>
              )}
            </View>
          ))}
        </View>
      );
    }
    case "architecture":
      return <ArchitectureBody architecture={section} />;
  }
}

/** An Architecture section of a plan or a report: the diagram drawn, its reading, its legend. */
export function ArchitectureBody(props: { readonly architecture: FactoryArchitecture }) {
  const { architecture } = props;
  return (
    <View className="gap-3">
      {architecture.diagram !== null ? (
        <View className="overflow-hidden rounded-2xl border border-border bg-card">
          <MermaidWebView source={architecture.diagram} />
        </View>
      ) : null}
      <FactoryMarkdown text={architecture.body} />
      {architecture.legend.length > 0 ? (
        <View className="gap-1">
          {architecture.legend.map((entry) => (
            <View key={entry.id} className="flex-row gap-2">
              <Text className="font-mono text-xs text-foreground">{entry.id}</Text>
              <View className="min-w-0 flex-1">
                <FactoryMarkdown text={entry.text} />
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A whole plan, every level-two section in document order: the phases as
 * cards, the decisions with their arguments folded, the architecture drawn.
 * The same model the web's Factory pane renders.
 */
export const FactoryPlanDocument = memo(function FactoryPlanDocument(props: {
  readonly markdown: string;
}) {
  const document = useMemo(() => deriveFactoryPlanDocumentModel(props.markdown), [props.markdown]);
  const sectionKeys = useMemo(
    () => occurrenceKeys(document.sections.map((section) => section.heading)),
    [document],
  );
  return (
    <View className="gap-6">
      <View className="gap-1">
        <Text accessibilityRole="header" className="font-t3-bold text-lg text-foreground">
          {document.title || "Plan"}
        </Text>
        <Text className="text-xs text-foreground-muted tabular-nums">
          {document.sectionCount} {document.sectionCount === 1 ? "section" : "sections"}
        </Text>
      </View>
      {document.sections.map((section, index) => (
        <View key={sectionKeys[index]} className="gap-2">
          {section.kind === "markdown" && section.folded ? (
            <Fold
              summary={
                <Text
                  accessibilityRole="header"
                  className="font-t3-medium text-base text-foreground"
                >
                  {section.heading}
                </Text>
              }
            >
              <FactoryMarkdown text={section.body} />
            </Fold>
          ) : (
            <>
              <Text accessibilityRole="header" className="font-t3-medium text-base text-foreground">
                {section.heading}
              </Text>
              <SectionBody section={section} />
            </>
          )}
        </View>
      ))}
    </View>
  );
});
