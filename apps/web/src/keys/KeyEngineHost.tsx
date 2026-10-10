import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { displayToken } from "@mesura/keys/keyToken";

import { useClientSettings } from "~/hooks/useSettings";
import { registerPaneEntry } from "~/lib/paneFocus";
import { cn } from "~/lib/utils";

import { clearChatSurfacePaint, chatSurface, setChatThreadKey } from "./chat/chatSurface";
import {
  composerCursorLine,
  composerProjectedText,
  composerSurface,
} from "./composer/composerSurface";
import {
  collapseComposer,
  subscribeComposerLayout,
  useComposerExpanded,
} from "./composer/composerExpanded";
import { caretRectAt } from "./composer/composerProjection";
import { useCursorOverlays, type CursorGlyph, type CursorOverlay } from "./cursorOverlayStore";
import { composerEditorElement } from "./focusScope";
import { configureKeyEngine, registerKeySurface } from "./keyEngine";
import { useKeyEngineSnapshot } from "./keyEngineStore";
import { useFlashSnapshot } from "./flashStore";

/**
 * Turns the modal key engine on from the `vimMode` setting and draws what it
 * shows: the which-key popup, the mode indicator and the flash labels. All
 * three are static — no transition, no animation — and absent on touch
 * screens, where there is no keyboard to drive them.
 */
export function KeyEngineHost() {
  const vimMode = useClientSettings((settings) => settings.vimMode);

  // The engine is global and installed once, but only the chat layout mounts
  // this host: leaving it (Settings, the pull requests page) turns the engine
  // off, so a key there is never read against the chat's remembered scope.
  useEffect(() => {
    configureKeyEngine({ enabled: vimMode });
    return () => configureKeyEngine({ enabled: false });
  }, [vimMode]);

  useEffect(() => {
    if (!vimMode) return;
    const disposeChat = registerKeySurface(chatSurface);
    const disposeComposer = registerKeySurface(composerSurface);
    // Entering the chat by a pane chord is entering the chat buffer in normal
    // mode, not the composer: the keyboard goes to <body>, and `focusPane`
    // records the chat as the last pane, which is where body focus resolves.
    const disposeChatEntry = registerPaneEntry("chat", enterChatBuffer);
    document.documentElement.dataset.mesuraVimMode = "on";
    return () => {
      disposeChat();
      disposeComposer();
      disposeChatEntry();
      clearChatSurfacePaint();
      collapseComposer();
      delete document.documentElement.dataset.mesuraVimMode;
    };
  }, [vimMode]);

  // The chat cursor is remembered per thread, keyed by the route's ids.
  const threadKey = useChatThreadKey();
  useEffect(() => {
    if (vimMode) setChatThreadKey(threadKey);
  }, [threadKey, vimMode]);

  const mainPanel = useMainPanelElement(vimMode);

  if (!vimMode) return null;
  return (
    <>
      {mainPanel ? createPortal(<ModeIndicator />, mainPanel) : null}
      {createPortal(
        <>
          <WhichKeyPopup />
          <FlashLabels />
          <BlockCursor />
        </>,
        document.body,
      )}
      <ComposerLineNumbers />
    </>
  );
}

function enterChatBuffer(): boolean {
  (document.activeElement as HTMLElement | null)?.blur?.();
  // A chat left in VISUAL or mid-sequence comes back in NORMAL; the cursor stays.
  chatSurface.reset();
  return true;
}

/** The open thread's key from the chat route's params, or `null` off a thread. */
function useChatThreadKey(): string | null {
  const { environmentId, threadId, draftId } = useParams({ strict: false });
  if (environmentId && threadId) return `${environmentId}/${threadId}`;
  return draftId ? `draft/${draftId}` : null;
}

/**
 * The route's main panel (`SidebarInset`), the chat column's container. Each
 * route renders its own, and a lazily loaded route replaces it after the
 * location has already changed, so it is looked up after every finished
 * router render rather than on the location change.
 */
function useMainPanelElement(enabled: boolean): HTMLElement | null {
  const router = useRouter();
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const find = () =>
      setElement(document.querySelector<HTMLElement>('main[data-slot="sidebar-inset"]'));
    find();
    return router.subscribe("onRendered", find);
  }, [enabled, router]);
  return element;
}

const TOUCH_HIDDEN = "[@media(hover:none)]:hidden";

function ModeIndicator() {
  const snapshot = useKeyEngineSnapshot();
  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-2 left-2 z-[60] flex items-center gap-2 rounded-md border border-border bg-popover/95 px-2 py-0.5 font-mono text-[11px] text-muted-foreground shadow-sm",
        TOUCH_HIDDEN,
      )}
      data-mesura-mode={snapshot.mode}
    >
      <span
        className={cn(
          "font-semibold",
          snapshot.mode === "INSERT" && "text-emerald-500",
          (snapshot.mode === "VISUAL" || snapshot.mode === "V-LINE") && "text-amber-500",
          snapshot.mode === "FLASH" && "text-(--mesura-flash-accent)",
          snapshot.mode === "NORMAL" && "text-sky-500",
          snapshot.mode === "PANE" && "text-violet-400",
        )}
      >
        {snapshot.mode}
      </span>
      {snapshot.mode === "PANE" ? (
        <span className="text-foreground">h j k l move border · = reset · Esc</span>
      ) : null}
      <span>{snapshot.scope}</span>
      {snapshot.pending.length > 0 ? (
        <span className="text-foreground">
          {snapshot.pending.map((token) => displayToken(token)).join("")}
        </span>
      ) : null}
      {snapshot.notice ? <span className="text-foreground">{snapshot.notice}</span> : null}
    </div>
  );
}

function WhichKeyPopup() {
  const { whichKey } = useKeyEngineSnapshot();
  if (whichKey === null) return null;
  return (
    <div
      className={cn(
        "pointer-events-none fixed right-3 bottom-10 z-[60] max-h-[60vh] w-[min(34rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border bg-popover/97 p-3 shadow-lg",
        TOUCH_HIDDEN,
      )}
      role="status"
      aria-label={`Keys after ${whichKey.title}`}
    >
      <div className="mb-2 font-medium text-foreground text-xs">{whichKey.title}</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {whichKey.rows.map((row) => (
          <div key={row.token} className="flex min-w-0 items-baseline gap-2 text-xs">
            <kbd className="min-w-5 shrink-0 rounded bg-muted px-1 text-center font-mono text-foreground">
              {displayToken(row.token)}
            </kbd>
            <span
              className={cn("truncate", row.isGroup ? "text-sky-500" : "text-muted-foreground")}
            >
              {row.isGroup ? `+${row.label ?? "more"}` : (row.label ?? row.command)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlashLabels() {
  const flash = useFlashSnapshot();
  if (!flash.active) return null;
  return (
    <>
      {flash.labels.map((label) => (
        <span
          key={label.id}
          className="pointer-events-none fixed z-[61] rounded-sm bg-(--mesura-flash-accent) px-0.5 font-mono text-[11px] font-bold leading-4 text-(--mesura-flash-ink)"
          style={{ left: label.left, top: label.top }}
        >
          {label.label}
        </span>
      ))}
      <div
        className={cn(
          "pointer-events-none fixed bottom-2 left-1/2 z-[61] -translate-x-1/2 rounded-md border border-(--mesura-flash-accent)/50 bg-popover px-2 py-0.5 font-mono text-xs",
          TOUCH_HIDDEN,
        )}
      >
        {flash.hint ?? `flash: ${flash.pattern || "…"}`}
      </div>
    </>
  );
}

/**
 * The block cursors a highlight cannot paint (`blockCursor.ts`): an empty
 * line's, fixed to the viewport; and a narrow glyph's, widened to half an em
 * with the glyph redrawn inside in its own font, drawn in the glyph's own
 * container so it is clipped and covered where the glyph is. The widened
 * cursor's colours live in `mesura.css` with the highlight cursor's.
 */
function BlockCursor() {
  const overlays = useCursorOverlays();
  return [...overlays].map(([owner, overlay]) =>
    overlay.glyph && overlay.container ? (
      createPortal(
        <WidenedCursor overlay={overlay} glyph={overlay.glyph} />,
        overlay.container,
        owner,
      )
    ) : (
      <span
        key={owner}
        aria-hidden
        className="pointer-events-none fixed z-[61] w-[0.6em] bg-sky-500/80"
        style={{ left: overlay.left, top: overlay.top, height: overlay.height }}
      />
    ),
  );
}

/**
 * An out-of-flow anchor at its static position in the container, with the
 * cursor placed from it: the anchor's box turns the viewport coordinates into
 * the container's, whatever positioned ancestor the anchor resolves against.
 * Placed in the commit, before paint.
 */
function WidenedCursor({ overlay, glyph }: { overlay: CursorOverlay; glyph: CursorGlyph }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const cursor = cursorRef.current;
    if (!anchor || !cursor) return;
    cursor.style.left = `${overlay.left - anchor.left}px`;
    cursor.style.top = `${overlay.top - anchor.top}px`;
  }, [overlay]);
  return (
    <span ref={anchorRef} aria-hidden className="pointer-events-none absolute">
      <span
        ref={cursorRef}
        data-mesura-block-cursor="glyph"
        className="pointer-events-none absolute select-none overflow-hidden whitespace-pre text-center"
        style={{
          width: overlay.width,
          height: overlay.height,
          // The glyph's box is its font's content area: a line exactly that
          // high puts the redrawn glyph where the original one is.
          lineHeight: `${overlay.height}px`,
          fontFamily: glyph.fontFamily,
          fontSize: glyph.fontSize,
          fontWeight: glyph.fontWeight,
          fontStyle: glyph.fontStyle,
          clipPath: overlay.clip,
        }}
      >
        {glyph.text}
      </span>
    </span>
  );
}

interface GutterLine {
  readonly number: number;
  readonly top: number;
  readonly current: boolean;
}

/**
 * The expanded composer's line numbers: hybrid, as Neovim's `number` plus
 * `relativenumber`. In normal mode the cursor's line shows its number and the
 * others their distance from it, which is the count a `5j` needs; in insert
 * mode every line shows its number. Re-measured only when the composer's
 * layout version moves, on input, or on the editor's own scroll.
 */
function ComposerLineNumbers() {
  const expanded = useComposerExpanded();
  const [gutter, setGutter] = useState<{ host: HTMLElement; lines: GutterLine[] } | null>(null);

  useLayoutEffect(() => {
    if (!expanded) return;
    const editor = composerEditorElement();
    const host = editor?.parentElement;
    if (!editor || !host) return;
    let frame = 0;
    const measure = () => {
      const text = composerProjectedText();
      if (text === null) return;
      const hostBox = host.getBoundingClientRect();
      const editorBox = editor.getBoundingClientRect();
      const cursorLine = composerCursorLine();
      const lines: GutterLine[] = [];
      let offset = 0;
      text.split("\n").forEach((line, index) => {
        const rect = caretRectAt(editor, offset);
        offset += line.length + 1;
        if (!rect || rect.bottom < editorBox.top || rect.top > editorBox.bottom) return;
        const number =
          cursorLine === null || index === cursorLine ? index + 1 : Math.abs(index - cursorLine);
        lines.push({ number, top: rect.top - hostBox.top, current: index === cursorLine });
      });
      setGutter({ host, lines });
    };
    // The prompt reaches the composer's state after the input event, so the
    // gutter measures on the next frame.
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    const unsubscribe = subscribeComposerLayout(schedule);
    editor.addEventListener("input", schedule);
    editor.addEventListener("scroll", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      unsubscribe();
      editor.removeEventListener("input", schedule);
      editor.removeEventListener("scroll", schedule);
    };
  }, [expanded]);

  if (!expanded || gutter === null) return null;
  return createPortal(
    <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3ch]">
      {gutter.lines.map((line) => (
        <span
          key={`${line.top}:${line.number}`}
          className={cn(
            "absolute right-1 font-mono text-[11px] leading-[inherit] tabular-nums",
            line.current ? "text-foreground" : "text-muted-foreground/70",
          )}
          style={{ top: line.top }}
        >
          {line.number}
        </span>
      ))}
    </div>,
    gutter.host,
  );
}
