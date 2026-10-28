import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@t3tools/contracts";
import {
  embeddedReaderActivateMessage,
  embeddedReaderModeMessage,
  embeddedReaderPaintMessage,
  readEmbeddedReaderMessage,
} from "@t3tools/shared/embeddedDocument";
import { keyTokenOf, parseKeySequence } from "@mesura/keys/keyToken";
import { TextBuffer, createInitialContext, type VimContext } from "@vimee/core";

import { chatScroller, chatViewport, readingBounds } from "../chat/chatBuffer";
import { revealChatSpan } from "../chat/chatSurface";
import { copyToClipboard } from "../clipboard";
import { appendBlockToComposer } from "../composer/composerSurface";
import { DEFAULT_KEYMAP } from "../defaultKeymap";
import { FRAME_READER_ATTRIBUTE } from "../focusScope";
import { refreshModeIndicator, type KeySurface } from "../keyEngine";
import { updateKeyEngineSnapshot, type EngineModeLabel } from "../keyEngineStore";
import {
  isVisualContext,
  stepReadOnlyVim,
  visualBounds,
  vimModeLabel,
  type BufferPosition,
} from "../readOnlyVim";

/**
 * A read-only Vim over the text of the page in a focused frame (an HTML render, an MCP app). The
 * page's agent (`EMBEDDED_DOCUMENT_AGENT_SCRIPT`) reports its text and posts its keys; Vim runs
 * here, and the page paints the cursor and the selection it is told. The page is untrusted code
 * that can post any message, so a message counts only from the focused frame, a key only with
 * the user's activation, and no key reaches the app's keymap: the page's leader cites, nothing else.
 */

/** Frames that run the agent: the chat's HTML renders and MCP apps, also full screen. */
const READER_FRAME_SELECTOR = "[data-mesura-chat-object-entry]";
const INTERACT_KEYS = new Set(["i", "a", "I", "A"]);
const CITE_SEQUENCE = citeSequence();

interface ReaderSession {
  readonly frame: HTMLIFrameElement;
  /** The page's text revision; 0 until the page first reports its text. */
  revision: number;
  text: string;
  lines: readonly string[];
  lineStarts: readonly number[];
  buffer: TextBuffer;
  context: VimContext;
  mode: "read" | "interact";
  /** The keys typed after the leader, while a page sequence is pending. */
  leader: string[] | null;
  activating: boolean;
}

let session: ReaderSession | null = null;
/** Each frame's last cursor offset, while the frame stays mounted. */
const rememberedOffsets = new WeakMap<HTMLIFrameElement, number>();
let installed = false;

function citeSequence(): readonly string[] {
  const binding = DEFAULT_KEYMAP.bindings.find((entry) => entry.command === "chat.cite");
  return binding ? parseKeySequence(binding.keys, DEFAULT_KEYMAP.leader) : [];
}

/** The reader's window listeners; installed by the first frame it reads. */
export function installFrameReader(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("message", onMessage);
  // The app's window takes focus back when the frame loses it.
  window.addEventListener("focus", () => {
    if (session && document.activeElement !== session.frame) endFrameReader();
  });
}

function post(frame: HTMLIFrameElement, message: object): void {
  frame.contentWindow?.postMessage(message, "*");
}

function setMode(current: ReaderSession, mode: ReaderSession["mode"]): void {
  current.mode = mode;
  current.frame.setAttribute(FRAME_READER_ATTRIBUTE, mode);
}

/** Starts reading the page in `frame`, which has just taken focus. */
export function startFrameReader(frame: HTMLIFrameElement): void {
  if (!frame.matches(READER_FRAME_SELECTOR)) return;
  installFrameReader();
  if (session?.frame === frame) return;
  endFrameReader();
  const empty = new TextBuffer("");
  session = {
    frame,
    revision: 0,
    text: "",
    lines: [""],
    lineStarts: [0],
    buffer: empty,
    context: createInitialContext({ line: 0, col: 0 }),
    mode: "read",
    leader: null,
    activating: false,
  };
  setMode(session, "read");
  post(frame, embeddedReaderModeMessage("read", visibleTopOf(frame)));
}

/** Lets go of the page's keys; the page keeps its own once it has focus again. */
export function endFrameReader(): void {
  const current = session;
  if (!current) return;
  session = null;
  current.frame.removeAttribute(FRAME_READER_ATTRIBUTE);
  post(current.frame, embeddedReaderModeMessage("off"));
  updateKeyEngineSnapshot({ pending: [] });
}

/** How far down the frame the chat's reading area starts, so a fresh cursor starts on screen. */
function visibleTopOf(frame: HTMLIFrameElement): number {
  const viewport = chatViewport();
  const scroller = viewport?.contains(frame) ? chatScroller(viewport) : null;
  return scroller
    ? Math.max(0, readingBounds(scroller).top - frame.getBoundingClientRect().top)
    : 0;
}

function onMessage(event: MessageEvent): void {
  const current = session;
  const frame = document.activeElement;
  if (!(frame instanceof HTMLIFrameElement) || event.source !== frame.contentWindow) return;
  const message = readEmbeddedReaderMessage(event.data);
  if (!message) return;
  if (message.kind === "ready") {
    // A focused frame reloaded its page, which starts with no reader.
    if (current?.frame === frame) {
      endFrameReader();
      startFrameReader(frame);
    }
    return;
  }
  if (current?.frame !== frame) return;
  switch (message.kind) {
    case "text":
      receiveText(current, message.revision, message.text, message.firstVisible);
      return;
    case "key": {
      // A page can post keys of its own; the user's keydown in the frame activates this window too.
      if (navigator.userActivation?.isActive === false) return;
      const token = keyTokenOf({
        key: message.key,
        code: message.code,
        shiftKey: message.shiftKey,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        altGraph: false,
      });
      if (token !== null) handleToken(current, token);
      refreshModeIndicator();
      return;
    }
    case "cursor": {
      if (message.revision !== current.revision) return;
      if (!chatViewport()?.contains(frame)) return;
      const top = frame.getBoundingClientRect().top;
      revealChatSpan(top + message.top, top + message.bottom);
      return;
    }
    case "select":
      if (message.revision !== current.revision || current.mode !== "read") return;
      adoptSelection(current, message.anchor, message.focus);
      refreshModeIndicator();
      return;
    case "state":
      setMode(current, message.mode);
      if (current.activating && !message.activated) {
        updateKeyEngineSnapshot({ notice: "nothing to activate under the cursor" });
      }
      current.activating = false;
      if (message.mode === "read") paint(current, false);
      refreshModeIndicator();
      return;
  }
}

function receiveText(
  current: ReaderSession,
  revision: number,
  text: string,
  firstVisible: number,
): void {
  const fresh = current.revision === 0;
  const offset = fresh
    ? (rememberedOffsets.get(current.frame) ?? firstVisible)
    : offsetAt(current, current.context.cursor);
  current.revision = revision;
  current.text = text;
  current.lines = text.split("\n");
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  current.lineStarts = starts;
  current.buffer = new TextBuffer(text);
  const cursor = clamp(current, positionAt(current, offset));
  current.context = isVisualContext(current.context)
    ? { ...current.context, cursor, visualAnchor: clamp(current, current.context.visualAnchor) }
    : createInitialContext(cursor);
  paint(current, fresh);
}

function clamp<Position extends BufferPosition | null>(
  current: ReaderSession,
  position: Position,
): Position {
  if (!position) return position;
  const line = Math.min(position.line, current.lines.length - 1);
  return {
    line,
    col: Math.min(position.col, Math.max(0, current.lines[line]!.length - 1)),
  } as Position;
}

function positionAt(current: ReaderSession, offset: number): BufferPosition {
  const starts = current.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, col: offset - starts[low]! };
}

function offsetAt(current: ReaderSession, position: BufferPosition): number {
  return (current.lineStarts[position.line] ?? 0) + position.col;
}

function paint(current: ReaderSession, reveal: boolean): void {
  if (current.revision === 0) return;
  const cursor = offsetAt(current, current.context.cursor);
  rememberedOffsets.set(current.frame, cursor);
  const bounds = visualBounds(current.context, current.lines);
  post(
    current.frame,
    embeddedReaderPaintMessage({
      revision: current.revision,
      cursor,
      visual: bounds ? [offsetAt(current, bounds.from), offsetAt(current, bounds.to)] : null,
      reveal,
    }),
  );
}

function handleToken(current: ReaderSession, token: string): void {
  if (current.mode !== "read" || current.revision === 0) return;
  if (current.leader) {
    const typed = [...current.leader, token];
    const matches = typed.every((key, index) => CITE_SEQUENCE[index] === key);
    current.leader = matches && typed.length < CITE_SEQUENCE.length ? typed : null;
    updateKeyEngineSnapshot({ pending: current.leader ?? [] });
    if (!matches) updateKeyEngineSnapshot({ notice: `${typed.join("")} is not mapped in a page` });
    else if (current.leader === null) cite(current);
    return;
  }
  const idle = current.context.phase === "idle" && current.context.count === 0;
  if (idle && token === CITE_SEQUENCE[0]) {
    current.leader = [token];
    updateKeyEngineSnapshot({ pending: current.leader });
    return;
  }
  if (idle && !isVisualContext(current.context)) {
    if (token === "<Esc>") {
      post(current.frame, embeddedReaderModeMessage("leave"));
      return;
    }
    if (INTERACT_KEYS.has(token)) {
      setMode(current, "interact");
      post(current.frame, embeddedReaderModeMessage("interact"));
      return;
    }
    if (token === "<CR>") {
      current.activating = true;
      post(
        current.frame,
        embeddedReaderActivateMessage(current.revision, offsetAt(current, current.context.cursor)),
      );
      return;
    }
  }
  const step = stepReadOnlyVim(token, current.context, current.buffer);
  current.context = step.context;
  for (const action of step.actions) {
    if (action.type !== "yank") continue;
    copyToClipboard(action.text);
    updateKeyEngineSnapshot({ notice: `yanked ${action.text.length} characters` });
  }
  paint(current, true);
}

/** A mouse selection becomes the visual selection, and a click places the cursor. */
function adoptSelection(current: ReaderSession, anchor: number, focus: number): void {
  const last = Math.max(0, current.text.length - 1);
  if (anchor === focus) {
    current.context = createInitialContext(positionAt(current, Math.min(anchor, last)));
  } else {
    const forward = anchor < focus;
    const anchorAt = positionAt(current, Math.min(forward ? anchor : anchor - 1, last));
    const head = positionAt(current, Math.min(forward ? focus - 1 : focus, last));
    current.context = { ...createInitialContext(head), mode: "visual", visualAnchor: anchorAt };
  }
  paint(current, false);
}

function cite(current: ReaderSession): void {
  const bounds = visualBounds(current.context, current.lines);
  if (!bounds) {
    updateKeyEngineSnapshot({ notice: "select the text to cite with v first" });
    return;
  }
  const text = current.text.slice(offsetAt(current, bounds.from), offsetAt(current, bounds.to));
  if (text.trim().length === 0) {
    updateKeyEngineSnapshot({ notice: "the selection has no text to cite" });
    return;
  }
  if (text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) {
    updateKeyEngineSnapshot({
      notice: `a cite holds ${ASSISTANT_CITATION_MAX_TEXT_LENGTH} characters at most`,
    });
    return;
  }
  current.context = stepReadOnlyVim("<Esc>", current.context, current.buffer).context;
  paint(current, false);
  const cited = appendBlockToComposer(pageQuote(current.frame.title, text));
  updateKeyEngineSnapshot({
    notice: cited ? "quoted into the composer" : "the composer is not ready for a quote",
  });
}

/**
 * The quote a page cite appends: the page's title, then the text as a Markdown block quote, then
 * an empty line for the comment.
 */
export function pageQuote(title: string, text: string): string {
  const quoted = text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
    .join("\n");
  return `From the page "${title.trim() || "Untitled"}":\n${quoted}\n`;
}

export const frameSurface: KeySurface = {
  scope: "frame",
  mode: () => "normal",
  label(): EngineModeLabel {
    if (!session) return "NORMAL";
    return session.mode === "interact" ? "INSERT" : vimModeLabel(session.context);
  },
  isPending: () => false,
  // The page's keys arrive as messages; a keydown here is the app's own, replayed by the page.
  handleKey: () => false,
  focusIn(target) {
    if (target instanceof HTMLIFrameElement) startFrameReader(target);
  },
  reset: endFrameReader,
};
