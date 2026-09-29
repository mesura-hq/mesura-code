import { Suspense, use, useEffect, useState } from "react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { Button } from "../components/ui/button";
import { requestMermaidDiagram, type MermaidRenderResult } from "./mermaidLoader";

interface MermaidDiagramProps {
  readonly source: string;
  readonly theme: "light" | "dark";
}

/** The diagram's source with the reason it was not drawn. */
function MermaidSourceFallback({
  source,
  message,
  onRetry,
}: {
  source: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-destructive-foreground">{message}</p>
        <Button size="xs" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre font-mono text-xs text-muted-foreground">
        {source}
      </pre>
    </div>
  );
}

function MermaidSvg({
  result,
  onRetry,
}: {
  result: Promise<MermaidRenderResult>;
  onRetry: () => void;
}) {
  const settled = use(result);
  if (!settled.ok) {
    return (
      <MermaidSourceFallback source={settled.source} message={settled.message} onRetry={onRetry} />
    );
  }
  return (
    <div
      className="flex justify-center overflow-x-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full"
      // The SVG mermaid returns under `securityLevel: "strict"`, and nothing else.
      dangerouslySetInnerHTML={{ __html: settled.svg }}
    />
  );
}

/**
 * One render per mount: `use()` suspends on the same promise for the whole
 * mount, while the loader's cache is free to evict it. Unmounting releases the
 * render, so a queued one that nothing shows any more is skipped.
 */
function MermaidRender({ source, theme, onRetry }: MermaidDiagramProps & { onRetry: () => void }) {
  const [request] = useState(() => requestMermaidDiagram(source, theme));
  useEffect(() => request.retain(), [request]);
  return (
    <RenderErrorBoundary
      fallback={
        <MermaidSourceFallback
          source={source}
          message="The diagram could not be drawn."
          onRetry={onRetry}
        />
      }
    >
      <Suspense
        fallback={<p className="p-3 text-xs text-muted-foreground">Drawing the diagram…</p>}
      >
        <MermaidSvg result={request.result} onRetry={onRetry} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

/** A `mermaid` code block drawn as its diagram, in chat and in the Factory pane. */
export function MermaidDiagram({ source, theme }: MermaidDiagramProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <MermaidRender
      key={`${attempt}\n${theme}\n${source}`}
      source={source}
      theme={theme}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
