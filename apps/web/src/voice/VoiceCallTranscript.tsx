import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown } from "lucide-react";
import type { VoiceCaption } from "@t3tools/client-runtime/voice-conversation/captions";
import { Button } from "~/components/ui/button";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import "./voiceCallTranscript.css";

export type VoiceCallLayout = "call" | "split" | "work";

export function VoiceCallTranscript({
  captions,
  active,
  layout,
  bottomInset,
}: {
  captions: ReadonlyArray<VoiceCaption>;
  active: boolean;
  layout: VoiceCallLayout;
  bottomInset: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  // oxlint-disable-next-line t3code/react-effect-budget -- follows the latest caption as the DOM resizes
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const content = contentRef.current;
    if (!node || !content || !following || layout === "work") return;
    const scrollToLatest = () => node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    scrollToLatest();
    // Both live text and layout changes can move the bottom of the captions.
    return observeResize([node, content], scrollToLatest);
  }, [following, layout]);

  return (
    <section
      aria-label="Spoken conversation"
      data-voice-layout={layout}
      className="relative flex min-h-0 flex-1 flex-col"
      style={{ "--voice-composer-inset": `${bottomInset}px` } as CSSProperties}
    >
      {layout === "split" && (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3 text-xs text-muted-foreground">
          <span className="font-medium">Call</span>
          <span>{active ? "Live" : "Call ended"}</span>
        </header>
      )}
      <div
        ref={scrollRef}
        role="region"
        aria-label="Spoken captions"
        tabIndex={0}
        className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onScroll={(event) => {
          if (layout === "work") return;
          const node = event.currentTarget;
          setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 64);
        }}
      >
        <div
          ref={contentRef}
          data-voice-captions-content
          className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 pt-7 sm:gap-10 sm:px-8 sm:pt-9"
        >
          {/* Only provider captions: the view stays blank until the first one arrives. */}
          {captions.map((caption) => (
            <article
              key={caption.id}
              data-voice-caption-role={caption.role}
              aria-label={caption.role === "user" ? "You" : "Voice"}
              className={cn(
                "min-w-0",
                caption.role === "user"
                  ? "ml-8 self-end rounded-2xl bg-muted/70 px-4 py-3"
                  : "w-full",
              )}
            >
              <p
                data-voice-caption-text
                // Neutral provider captions, larger than Work's text: 18px narrow, 20px wide.
                className="text-lg leading-8 whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere] sm:text-xl sm:leading-9"
              >
                {caption.text.trimStart()}
              </p>
            </article>
          ))}
        </div>
      </div>
      {!following && (
        <div
          data-voice-latest-captions
          className="pointer-events-none absolute inset-x-0 flex justify-center"
        >
          <Button
            variant="glass"
            size="xs"
            className="pointer-events-auto"
            onClick={() => setFollowing(true)}
          >
            <ArrowDown className="size-3" aria-hidden /> Latest captions
          </Button>
        </div>
      )}
    </section>
  );
}
