type Mermaid = typeof import("mermaid").default;

export type MermaidRenderResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly source: string; readonly message: string };

/** Bytes of settled source and SVG kept for diagrams that are shown again. */
export const MERMAID_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const MERMAID_CACHE_MAX_ENTRIES = 64;
/** Renders waiting for their turn; a message with more fences waits for a retry. */
export const MERMAID_MAX_QUEUED_RENDERS = 24;
const QUEUE_FULL_MESSAGE = "Too many diagrams are waiting to be drawn. Try again.";

let mermaidPromise: Promise<Mermaid> | null = null;

/**
 * Mermaid is about 3 MB, so it loads on the first diagram shown, never with
 * the chat. The import is cached; a failed load is retried on the next call.
 */
export function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(
    (module) => module.default,
    (error: unknown) => {
      mermaidPromise = null;
      throw error;
    },
  );
  return mermaidPromise;
}

interface RenderEntry {
  readonly key: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly result: Promise<MermaidRenderResult>;
  readonly settle: (result: MermaidRenderResult) => void;
  settled: MermaidRenderResult | null;
  /** Mounted diagrams holding this render. */
  refs: number;
  everRetained: boolean;
  bytes: number;
}

// Map order is recency: a request moves its entry to the end.
const cache = new Map<string, RenderEntry>();
let cachedBytes = 0;
const queue: RenderEntry[] = [];
let draining = false;
let nextDiagramId = 0;

const byteSize = (text: string) => text.length * 2;

function forget(entry: RenderEntry): void {
  if (cache.get(entry.key) !== entry) return;
  cache.delete(entry.key);
  cachedBytes -= entry.bytes;
}

/** Drops the least recent settled renders until the cache is inside its budget. */
function evictSettled(): void {
  for (const entry of cache.values()) {
    if (cachedBytes <= MERMAID_CACHE_MAX_BYTES && cache.size <= MERMAID_CACHE_MAX_ENTRIES) return;
    if (entry.settled !== null) forget(entry);
  }
}

async function renderNow(source: string, theme: "light" | "dark"): Promise<MermaidRenderResult> {
  try {
    const mermaid = await loadMermaid();
    // Strict: mermaid escapes labels and disables click handlers, so the SVG
    // it returns is safe to inject.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
    });
    nextDiagramId += 1;
    const { svg } = await mermaid.render(`mesura-mermaid-${nextDiagramId}`, source);
    return { ok: true, svg };
  } catch (error) {
    return { ok: false, source, message: error instanceof Error ? error.message : String(error) };
  }
}

function settle(entry: RenderEntry, result: MermaidRenderResult): void {
  entry.settled = result;
  entry.settle(result);
  // A failure is never reused, so showing the diagram again retries it.
  if (!result.ok) {
    forget(entry);
    return;
  }
  if (cache.get(entry.key) === entry) {
    cachedBytes += byteSize(result.svg);
    entry.bytes += byteSize(result.svg);
    evictSettled();
  }
}

// `initialize` is global, so renders run one at a time with their own theme.
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      // Every diagram that held this render has unmounted: skip the work.
      if (entry.everRetained && entry.refs === 0) {
        forget(entry);
        continue;
      }
      settle(entry, await renderNow(entry.source, entry.theme));
    }
  } finally {
    draining = false;
  }
}

export interface MermaidRenderRequest {
  /** Stable for the request's life, so `use()` can suspend on it. */
  readonly result: Promise<MermaidRenderResult>;
  /** Called while a diagram shows this render; returns its release. */
  readonly retain: () => () => void;
}

/** Asks for a diagram. Renders are shared per source and theme, and never reject. */
export function requestMermaidDiagram(
  source: string,
  theme: "light" | "dark",
): MermaidRenderRequest {
  const key = `${theme}\n${source}`;
  let entry = cache.get(key);
  if (entry !== undefined) {
    cache.delete(key);
    cache.set(key, entry);
  } else {
    let settleResult: (result: MermaidRenderResult) => void = () => {};
    const result = new Promise<MermaidRenderResult>((resolve) => {
      settleResult = resolve;
    });
    entry = {
      key,
      source,
      theme,
      result,
      settle: settleResult,
      settled: null,
      refs: 0,
      everRetained: false,
      bytes: byteSize(source),
    };
    if (queue.length >= MERMAID_MAX_QUEUED_RENDERS) {
      settle(entry, { ok: false, source, message: QUEUE_FULL_MESSAGE });
    } else {
      cache.set(key, entry);
      cachedBytes += entry.bytes;
      queue.push(entry);
      void drain();
    }
  }
  const held = entry;
  return {
    result: held.result,
    retain: () => {
      held.refs += 1;
      held.everRetained = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.refs -= 1;
      };
    },
  };
}
