import { describe, expect, it } from "vite-plus/test";

import manifest from "../../package.json" with { type: "json" };

import {
  matchesThreadTokens,
  normalizeThreadSearchText,
  scoreThreadTokenMatch,
  selectThreadContentToken,
  tokenizeThreadSearchQuery,
  type ThreadSearchFields,
} from "./threadTokenSearch.ts";

/** The thread the plan names as the headline case. */
const RENAME: ThreadSearchFields = {
  title: "Rename the sidebar",
  projectTitle: "Mesura Code",
  branch: "feat/rename-sidebar",
};

function matches(query: string, fields: ThreadSearchFields = RENAME): boolean {
  return matchesThreadTokens({ fields, tokens: tokenizeThreadSearchQuery(query) });
}

function score(fields: ThreadSearchFields, query: string): number {
  const value = scoreThreadTokenMatch({ fields, tokens: tokenizeThreadSearchQuery(query) });
  if (value === null) throw new Error(`expected ${query} to match`);
  return value;
}

// Criterion 1 — the module's surface.
describe("the module surface", () => {
  it("exposes the five things the plan names", () => {
    expect(typeof normalizeThreadSearchText).toBe("function");
    expect(typeof tokenizeThreadSearchQuery).toBe("function");
    expect(typeof scoreThreadTokenMatch).toBe("function");
    expect(typeof matchesThreadTokens).toBe("function");
    expect(typeof selectThreadContentToken).toBe("function");
  });
});

// Criterion 2 — the matching rule.
describe("the matching rule", () => {
  it("finds a thread from its project name plus a word of its title, in either order", () => {
    expect(matches("mesura rename")).toBe(true);
    expect(matches("rename mesura")).toBe(true);
  });

  it("requires every word to match at least one field", () => {
    expect(matches("mesura xyz")).toBe(false);
  });

  it("matches on the branch as well as the title and the project", () => {
    expect(matches("feat")).toBe(true);
    expect(matches("mesura feat sidebar")).toBe(true);
  });

  it("ignores case on both sides", () => {
    expect(matches("MESURA ReNaMe")).toBe(true);
  });

  it("ignores accents on both sides", () => {
    const accented: ThreadSearchFields = { title: "Añadir el índice", projectTitle: "Núcleo" };
    expect(matches("indice", accented)).toBe(true);
    expect(matches("nucleo índice", accented)).toBe(true);
  });

  it("keeps every thread when the query has no words", () => {
    expect(scoreThreadTokenMatch({ fields: RENAME, tokens: [] })).toBe(0);
  });

  it("normalises text to lowercase, unaccented and single-spaced", () => {
    expect(normalizeThreadSearchText("  Añadir   EL Índice ")).toBe("anadir el indice");
  });

  it("splits a query into its words and drops the empty ones", () => {
    expect(tokenizeThreadSearchQuery("  mesura   rename ")).toEqual(["mesura", "rename"]);
    expect(tokenizeThreadSearchQuery("   ")).toEqual([]);
  });
});

// Criterion 3 — the ranking.
describe("the ranking", () => {
  it("ranks a whole field above a prefix, a prefix above a word start, and that above a substring", () => {
    const whole = score({ title: "rename" }, "rename");
    const prefix = score({ title: "rename the sidebar" }, "rename");
    const wordStart = score({ title: "do rename now" }, "rename");
    const substring = score({ title: "prerename" }, "rename");

    expect(whole).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
  });

  it("ranks a hit in the title above the same hit in the project title, and that above the branch", () => {
    const inTitle = score({ title: "rename it", projectTitle: "other", branch: "other" }, "rename");
    const inProject = score(
      { title: "other", projectTitle: "rename it", branch: "other" },
      "rename",
    );
    const inBranch = score(
      { title: "other", projectTitle: "other", branch: "rename it" },
      "rename",
    );

    expect(inTitle).toBeGreaterThan(inProject);
    expect(inProject).toBeGreaterThan(inBranch);
  });
});

// Criterion 4 — what a server message hit may answer for.
describe("a message hit from the server", () => {
  const noFieldHit: ThreadSearchFields = { title: "Weekly sync", projectTitle: "Mesura Code" };

  it("satisfies the one word the server was asked about", () => {
    const tokens = tokenizeThreadSearchQuery("mesura rename");
    expect(matchesThreadTokens({ fields: noFieldHit, tokens })).toBe(false);
    expect(
      matchesThreadTokens({
        fields: noFieldHit,
        tokens,
        contentToken: "rename",
        hasContentMatch: true,
      }),
    ).toBe(true);
  });

  it("never satisfies a word the server was not asked about", () => {
    expect(
      matchesThreadTokens({
        fields: noFieldHit,
        tokens: tokenizeThreadSearchQuery("mesura unrelated"),
        contentToken: "rename",
        hasContentMatch: true,
      }),
    ).toBe(false);
  });

  it("scores below every field match, the branch included", () => {
    const tokens = tokenizeThreadSearchQuery("rename");
    const viaContent = scoreThreadTokenMatch({
      fields: { title: "Weekly sync" },
      tokens,
      contentToken: "rename",
      hasContentMatch: true,
    });
    const viaBranch = scoreThreadTokenMatch({
      fields: { title: "Weekly sync", branch: "feat/rename" },
      tokens,
    });

    expect(viaContent).not.toBeNull();
    expect(viaBranch).not.toBeNull();
    expect(viaContent ?? 0).toBeLessThan(viaBranch ?? 0);
  });

  it("answers for nothing when the caller reports no hit", () => {
    expect(
      matchesThreadTokens({
        fields: noFieldHit,
        tokens: tokenizeThreadSearchQuery("mesura rename"),
        contentToken: "rename",
        hasContentMatch: false,
      }),
    ).toBe(false);
  });
});

// Criterion 5 — choosing the word to send to the server.
describe("choosing the word sent to the server", () => {
  const PROJECTS = ["Mesura Code", "Other Tools"];

  it("sends the single word of a one-word query", () => {
    expect(selectThreadContentToken(["rename"], PROJECTS)).toBe("rename");
  });

  it("prefers a word that names no project", () => {
    expect(selectThreadContentToken(["mesura", "rename"], PROJECTS)).toBe("rename");
  });

  it("takes the longest of the words that name no project", () => {
    expect(selectThreadContentToken(["fix", "renaming"], PROJECTS)).toBe("renaming");
  });

  it("falls back to the longest word overall when every word names a project", () => {
    expect(selectThreadContentToken(["mesura", "code"], PROJECTS)).toBe("mesura");
  });

  it("never chooses a word below the server's two-character floor", () => {
    expect(selectThreadContentToken(["a"], PROJECTS)).toBeNull();
    expect(selectThreadContentToken(["a", "rename"], PROJECTS)).toBe("rename");
  });

  it("chooses nothing for an empty query", () => {
    expect(selectThreadContentToken([], PROJECTS)).toBeNull();
  });
});

// Guards. Each pins a defect the review of this change found, so that fixing
// it once is enough and it cannot come back unnoticed.
describe("guards", () => {
  it("weighs the best occurrence of a word, not merely the first", () => {
    // "rename" appears twice: buried inside "prerename", then starting a word.
    // Scoring the first hit and stopping under-ranks the field.
    const buriedOnly = score({ title: "prerename" }, "rename");
    const buriedThenWordStart = score({ title: "prerename call rename" }, "rename");
    const wordStartOnly = score({ title: "do rename now" }, "rename");

    expect(buriedThenWordStart).toBeGreaterThan(buriedOnly);
    expect(buriedThenWordStart).toBe(wordStartOnly);
  });

  it("does not let a repeated word weigh twice", () => {
    expect(score(RENAME, "rename rename")).toBe(score(RENAME, "rename"));
    expect(tokenizeThreadSearchQuery("rename rename")).toEqual(["rename"]);
  });

  it("treats a letter of any script as part of a word, not as a boundary", () => {
    // An ASCII-only boundary test counts the Cyrillic letter as a boundary and
    // scores the buried match as though it started a word.
    const buriedAfterCyrillic = score({ title: "проектrename" }, "rename");
    const afterASpace = score({ title: "проект rename" }, "rename");

    expect(buriedAfterCyrillic).toBeLessThan(afterASpace);
  });
});

// Criterion 6 — the package advertises the module.
describe("the package export map", () => {
  it("maps a subpath under ./state/ to this module", () => {
    // The module itself is proven to exist by this file importing it above:
    // a missing file fails every other test here before this one runs.
    const entry = Object.entries(manifest.exports).find(([, value]) =>
      value.default.endsWith("threadTokenSearch.ts"),
    );

    expect(entry, "no subpath export points at threadTokenSearch.ts").toBeDefined();
    const [subpath, value] = entry ?? ["", { types: "", default: "" }];
    expect(subpath.startsWith("./state/")).toBe(true);
    expect(value.types).toBe(value.default);
  });
});
