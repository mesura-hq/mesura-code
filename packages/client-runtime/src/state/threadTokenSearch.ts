/**
 * Word-at-a-time matching for "find that thread".
 *
 * The command palette joins a thread's title, project and branch into one
 * string and asks whether the query appears contiguously inside it. That fails
 * the way people actually remember a thread — roughly the project, roughly the
 * title — because those two words come from two different fields and often in
 * the wrong order. `mesura rename` never finds `Rename the sidebar` in
 * `Mesura Code`.
 *
 * Here every word of the query has to match some field and the order does not
 * matter. Web and mobile both search threads, which is why this lives in
 * client-runtime rather than beside either one's search UI.
 */

/** The text a thread is found by. Listed in the order they are worth. */
export interface ThreadSearchFields {
  readonly title: string;
  readonly projectTitle?: string | null;
  readonly branch?: string | null;
}

/** A word found in the title beats the same word found in the project name,
    which beats the branch. Multiplied out so the field always outranks how
    well the word sat inside it. */
const FIELD_WEIGHT = { title: 3, projectTitle: 2, branch: 1 } as const;
const FIELD_WEIGHT_STEP = 10;

/** How well one word sits inside one field. */
const WHOLE_FIELD = 4;
const FIELD_PREFIX = 3;
const WORD_START = 2;
const SUBSTRING = 1;

/** A word the server found inside the thread's messages. Deliberately below
    the weakest field match — a passing mention is the last resort, never the
    first — and above zero, so it still separates a hit from a miss. */
const CONTENT_HIT = 0.5;

/** `OrchestrationSearchThreadsInput` refuses a query under two characters, so
    a shorter word can never be the one sent to the server. */
const MIN_SERVER_WORD_LENGTH = 2;

/**
 * Lowercase, unaccented, single-spaced.
 *
 * Accents come off both the query and the field, so a title written with them
 * is still found by a query typed without.
 */
export function normalizeThreadSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The query as the words that all have to match.
 *
 * Repeats are dropped: the words are a set, and letting one count twice would
 * silently weigh it double against the others in the score.
 */
export function tokenizeThreadSearchQuery(query: string): ReadonlyArray<string> {
  const normalized = normalizeThreadSearchText(query);
  return normalized.length === 0 ? [] : [...new Set(normalized.split(" "))];
}

function startsAWord(character: string | undefined): boolean {
  return character === undefined || /[^\p{L}\p{N}]/u.test(character);
}

/**
 * How well one word sits in one already-normalised field, or null when the
 * field lacks it.
 *
 * Every occurrence is weighed, not just the first: in "prerename call rename"
 * the first hit is buried inside another word while a later one starts a word,
 * and reporting the buried one would under-rank the field.
 */
function scoreInField(normalizedField: string, word: string): number | null {
  if (normalizedField.length === 0) return null;
  if (normalizedField === word) return WHOLE_FIELD;

  let best: number | null = null;
  for (
    let at = normalizedField.indexOf(word);
    at !== -1;
    at = normalizedField.indexOf(word, at + 1)
  ) {
    // Whole-field is already ruled out, so a prefix is the best still possible.
    if (at === 0) return FIELD_PREFIX;
    const quality = startsAWord(normalizedField[at - 1]) ? WORD_START : SUBSTRING;
    if (best === null || quality > best) best = quality;
  }
  return best;
}

/**
 * A thread's fields normalised once, with the weight each carries.
 *
 * Normalising is NFKD plus two regexes plus a lowercase, and both callers of
 * this module search as the user types. Doing it once per field per query
 * rather than once per field per word is what keeps a keystroke cheap on a long
 * thread list.
 */
function weighFields(fields: ThreadSearchFields): ReadonlyArray<readonly [string, number]> {
  const weighed: Array<readonly [string, number]> = [];
  for (const name of ["title", "projectTitle", "branch"] as const) {
    const value = fields[name];
    if (value == null) continue;
    const normalized = normalizeThreadSearchText(value);
    if (normalized.length === 0) continue;
    weighed.push([normalized, FIELD_WEIGHT[name] * FIELD_WEIGHT_STEP] as const);
  }
  return weighed;
}

/** The best any field does with this word, weighted by which field it was, or
    null when no field has it at all. */
function scoreAcrossFields(
  weighedFields: ReadonlyArray<readonly [string, number]>,
  word: string,
): number | null {
  let best: number | null = null;
  for (const [normalizedField, weight] of weighedFields) {
    const quality = scoreInField(normalizedField, word);
    if (quality === null) continue;
    const weighted = weight + quality;
    if (best === null || weighted > best) best = weighted;
  }
  return best;
}

export interface ThreadTokenMatchInput {
  readonly fields: ThreadSearchFields;
  readonly tokens: ReadonlyArray<string>;
  /**
   * The one word the server was asked to look for inside the messages, and
   * whether it found it in this thread. Only that word can be answered for by
   * content: it is the only one the server actually searched.
   */
  readonly contentToken?: string | null;
  readonly hasContentMatch?: boolean;
}

/**
 * What this thread is worth for this query, or null when some word matches
 * nothing at all.
 *
 * Higher is better. A caller that sorts on it must break ties by input
 * position, so threads of equal relevance keep the recency order they arrived
 * in.
 */
export function scoreThreadTokenMatch(input: ThreadTokenMatchInput): number | null {
  if (input.tokens.length === 0) return 0;

  const weighedFields = weighFields(input.fields);
  let total = 0;
  for (const word of input.tokens) {
    const fieldScore = scoreAcrossFields(weighedFields, word);
    if (fieldScore !== null) {
      total += fieldScore;
      continue;
    }
    if (input.hasContentMatch === true && input.contentToken === word) {
      total += CONTENT_HIT;
      continue;
    }
    return null;
  }
  return total;
}

/** Whether the thread matches at all, for callers that do not rank. */
export function matchesThreadTokens(input: ThreadTokenMatchInput): boolean {
  return scoreThreadTokenMatch(input) !== null;
}

/**
 * The one word to send to the server's message search.
 *
 * The server matches a contiguous `LIKE`, so a multi-word query finds nothing
 * inside messages and only one word can usefully be asked for. Prefer a word
 * that names no project: that is the one saying what the thread is about
 * rather than where it lives. The longest such word wins, because a longer
 * word is the more specific one.
 *
 * This is a heuristic. It serves "roughly the project, roughly what was said",
 * and it degrades to the whole query when there is only one word.
 */
export function selectThreadContentToken(
  tokens: ReadonlyArray<string>,
  projectTitles: ReadonlyArray<string>,
): string | null {
  const eligible = tokens.filter((word) => word.length >= MIN_SERVER_WORD_LENGTH);
  if (eligible.length === 0) return null;

  const normalizedTitles = projectTitles
    .map(normalizeThreadSearchText)
    .filter((title) => title.length > 0);
  const namesNoProject = eligible.filter(
    (word) => !normalizedTitles.some((title) => title.includes(word)),
  );

  const pool = namesNoProject.length > 0 ? namesNoProject : eligible;
  return pool.reduce((longest, word) => (word.length > longest.length ? word : longest));
}
