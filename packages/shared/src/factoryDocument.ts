/**
 * Reads the Software Factory's markdown documents (a plan, later a report) the
 * way the server and both clients need them: the title, every level-two
 * section in document order, and the plan's phase list.
 *
 * Pure and Hermes-safe: the phone imports it, so no Node APIs and no ES2023
 * array methods.
 */

export interface FactoryDocumentSection {
  readonly heading: string;
  readonly body: string;
}

export interface FactoryDocument {
  /** The first `# ` line, verbatim; empty when the document has none. */
  readonly title: string;
  readonly sections: ReadonlyArray<FactoryDocumentSection>;
}

export interface FactoryPhase {
  readonly title: string;
  readonly goal?: string;
  readonly files: ReadonlyArray<string>;
  readonly acceptance: ReadonlyArray<string>;
  readonly detail?: string;
  readonly validationSuggested?: string;
}

export type FactoryPhasesResult =
  | { readonly ok: true; readonly phases: ReadonlyArray<FactoryPhase> }
  | { readonly ok: false; readonly reason: string };

export const FACTORY_PHASES_HEADING = "The phases";

interface OpenFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fence a line opens, or null. A backtick fence's info string may not hold a backtick. */
function fenceOpenedBy(line: string): (OpenFence & { readonly info: string }) | null {
  const match = FENCE_PATTERN.exec(line);
  if (!match) return null;
  const run = match[1]!;
  const info = match[2]!.trim();
  const marker = run[0] === "`" ? "`" : "~";
  if (marker === "`" && info.includes("`")) return null;
  return { marker, length: run.length, info };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = FENCE_PATTERN.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === fence.marker && run.length >= fence.length && match[2]!.trim() === "";
}

interface ScannedLine {
  readonly text: string;
  /** True for fence delimiters and every line between them. */
  readonly fenced: boolean;
}

/** Marks which lines belong to fenced code blocks, so their `#` lines are never headings. */
function scanLines(markdown: string): ReadonlyArray<ScannedLine> {
  const scanned: Array<ScannedLine> = [];
  let open: OpenFence | null = null;
  for (const text of markdown.split(/\r?\n/)) {
    if (open !== null) {
      if (closesFence(text, open)) open = null;
      scanned.push({ text, fenced: true });
      continue;
    }
    const opened = fenceOpenedBy(text);
    if (opened !== null) {
      open = opened;
      scanned.push({ text, fenced: true });
      continue;
    }
    scanned.push({ text, fenced: false });
  }
  return scanned;
}

/**
 * Splits a document on its `## ` lines outside fenced code blocks. Every
 * section is kept in document order, known heading or not; text before the
 * first section belongs to no section.
 */
export function splitFactoryDocument(markdown: string): FactoryDocument {
  let title: string | null = null;
  const sections: Array<FactoryDocumentSection> = [];
  let heading: string | null = null;
  let bodyLines: Array<string> = [];
  const closeSection = () => {
    if (heading !== null) sections.push({ heading, body: bodyLines.join("\n") });
  };
  for (const line of scanLines(markdown)) {
    if (!line.fenced && line.text.startsWith("## ")) {
      closeSection();
      heading = line.text.slice(3).trim();
      bodyLines = [];
      continue;
    }
    if (!line.fenced && title === null && line.text.startsWith("# ")) {
      title = line.text.slice(2).trim();
    }
    if (heading !== null) bodyLines.push(line.text);
  }
  closeSection();
  return { title: title ?? "", sections };
}

/** The contents of the first fenced block whose info string starts with `json`. */
function firstJsonFence(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const fence = fenceOpenedBy(lines[index]!);
    if (fence === null) continue;
    const isJson = fence.info.split(/\s+/)[0]!.toLowerCase() === "json";
    const contents: Array<string> = [];
    for (index += 1; index < lines.length && !closesFence(lines[index]!, fence); index += 1) {
      contents.push(lines[index]!);
    }
    if (isJson) return contents.join("\n");
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function readPhase(value: unknown, position: number): FactoryPhase | string {
  if (!isRecord(value)) return `Phase ${position} is not an object.`;
  const { title, goal, files, acceptance, detail, validationSuggested } = value;
  if (typeof title !== "string" || title.trim() === "") return `Phase ${position} has no title.`;
  if (!isStringArray(acceptance)) {
    return `Phase ${position} has no acceptance list of strings.`;
  }
  if (files !== undefined && !isStringArray(files)) {
    return `Phase ${position} has a files entry that is not a list of strings.`;
  }
  return {
    title,
    files: files ?? [],
    acceptance,
    ...(typeof goal === "string" ? { goal } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof validationSuggested === "string" ? { validationSuggested } : {}),
  };
}

/**
 * Reads the phase list from the first fenced `json` block of the section
 * headed `The phases`. Never throws: a plan that does not parse yields the
 * reason, worded for the agent that wrote the plan.
 */
export function readFactoryPhases(
  sections: ReadonlyArray<FactoryDocumentSection>,
): FactoryPhasesResult {
  const section = sections.find((entry) => entry.heading === FACTORY_PHASES_HEADING);
  if (section === undefined) {
    return { ok: false, reason: `The plan has no "## ${FACTORY_PHASES_HEADING}" section.` };
  }
  const json = firstJsonFence(section.body);
  if (json === null) {
    return {
      ok: false,
      reason: `The "${FACTORY_PHASES_HEADING}" section has no fenced json block.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `The phases json block does not parse: ${detail}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "The phases json block is not a list of phases." };
  }
  const phases: Array<FactoryPhase> = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const phase = readPhase(parsed[index], index + 1);
    if (typeof phase === "string") return { ok: false, reason: phase };
    phases.push(phase);
  }
  return { ok: true, phases };
}
