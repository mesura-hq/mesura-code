import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown } from "lucide-react";
import type { VoiceCaption } from "@t3tools/client-runtime/voice-conversation/captions";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

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
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const content = contentRef.current;
    if (!node || !content || !following || layout === "work") return;
    const scrollToLatest = () => node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    scrollToLatest();
    // Both live text and layout changes can move the bottom of the captions.
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(node);
    observer.observe(content);
    return () => observer.disconnect();
  }, [following, layout]);

  return (
    <section
      aria-label="Spoken conversation"
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
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onScroll={(event) => {
          if (layout === "work") return;
          const node = event.currentTarget;
          setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 64);
        }}
      >
        <div
          ref={contentRef}
          className={cn(
            "mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 pt-7 sm:gap-10 sm:px-8 sm:pt-9",
            layout === "split"
              ? "pb-6 lg:pb-[calc(var(--voice-composer-inset)+1.5rem)]"
              : "pb-[calc(var(--voice-composer-inset)+1.5rem)]",
          )}
        >
          {captions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <p className="text-lg">{active ? "Your conversation" : "Call ended"}</p>
              <p className="max-w-64 text-sm leading-relaxed text-muted-foreground">
                Your words and the spoken replies appear here.
              </p>
            </div>
          ) : (
            captions.map((caption) => (
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
                  className={cn(
                    "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
                    caption.role === "user"
                      ? "text-base leading-7 sm:text-lg sm:leading-8"
                      : "text-lg leading-8 sm:text-xl sm:leading-9",
                  )}
                >
                  {caption.text.trimStart()}
                </p>
              </article>
            ))
          )}
          {captions.length > 0 && !active && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Captions clear when you start another call, leave, or refresh.
            </p>
          )}
        </div>
      </div>
      {!following && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 flex justify-center",
            layout === "split"
              ? "bottom-3 lg:bottom-[calc(var(--voice-composer-inset)+0.75rem)]"
              : "bottom-[calc(var(--voice-composer-inset)+0.75rem)]",
          )}
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
