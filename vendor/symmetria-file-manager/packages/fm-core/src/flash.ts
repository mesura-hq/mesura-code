import { computeTextMatches } from "./search.ts";

export interface FlashTarget {
  readonly path: string;
  readonly name: string;
}
export interface FlashMatch extends FlashTarget {
  readonly label: string;
}
export interface FlashResult {
  readonly matches: readonly FlashMatch[];
  readonly continuations: ReadonlySet<string>;
  readonly needsRefinement: boolean;
}
const LABEL_CHARACTERS = "asdfghjklqwertyuiopzxcvbnm";

/** Continuations from every occurrence prevent a label from stealing query text. */
function continuationCharacters(query: string, targets: readonly FlashTarget[]): Set<string> {
  const characters = new Set(query);
  for (const target of targets) {
    const name = target.name.toLowerCase();
    let start = name.indexOf(query);
    while (start >= 0) {
      const character = name[start + query.length];
      if (character !== undefined) characters.add(character);
      start = name.indexOf(query, start + 1);
    }
  }
  return characters;
}

/** Equal-length labels remain prefix-free at every capacity. */
function labelsFor(count: number, available: readonly string[]): string[] {
  if (count <= available.length) return available.slice(0, count);
  if (available.length < 2) return [];
  let length = 1;
  while (available.length ** length < count) length++;
  return Array.from({ length: count }, (_, index) => {
    let label = "";
    for (let place = 0; place < length; place++) {
      label = available[index % available.length] + label;
      index = Math.floor(index / available.length);
    }
    return label;
  });
}

export function computeFlash(query: string, targets: readonly FlashTarget[]): FlashResult {
  const needle = query.toLowerCase();
  if (needle === "") return { matches: [], continuations: new Set(), needsRefinement: false };
  const matching = computeTextMatches(targets, needle, (target) => target.name, false).flatMap(
    (index) => (targets[index] ? [targets[index]] : []),
  );
  const continuations = continuationCharacters(needle, matching);
  const available = [...LABEL_CHARACTERS].filter((character) => !continuations.has(character));
  const labels = labelsFor(matching.length, available);
  return {
    matches: matching.map((target, index) => ({ ...target, label: labels[index] ?? "" })),
    continuations,
    needsRefinement: matching.length > labels.length,
  };
}

export type FlashTransition =
  | { readonly kind: "query"; readonly query: string }
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "select"; readonly path: string }
  | { readonly kind: "cancel" }
  | { readonly kind: "ignore" };

/** Resolve a key against one captured result set. */
export function flashTransition(
  query: string,
  prefix: string,
  key: string,
  result: FlashResult,
): FlashTransition {
  if (key === "Escape") return { kind: "cancel" };
  if (key === "Backspace") {
    if (prefix !== "") return { kind: "prefix", prefix: prefix.slice(0, -1) };
    return query === "" ? { kind: "cancel" } : { kind: "query", query: query.slice(0, -1) };
  }
  if ([...key].length !== 1) return { kind: "ignore" };
  const character = key.toLowerCase();
  const label = prefix + character;
  const chosen = result.matches.find((match) => match.label === label);
  if (chosen) return { kind: "select", path: chosen.path };
  if (result.matches.some((match) => match.label.startsWith(label)))
    return { kind: "prefix", prefix: label };
  if (prefix !== "") return { kind: "prefix", prefix: "" };
  if (query === "" || result.continuations.has(character) || result.needsRefinement)
    return { kind: "query", query: query + character };
  return { kind: "ignore" };
}
