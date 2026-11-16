import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestCommentPreview,
  remarkPullRequestAutolinks,
  sameRepositoryReferenceAutolinker,
} from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

function links(
  markdown: string,
  autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!,
) {
  const tree = unified().use(remarkParse).parse(markdown) as Node;
  remarkPullRequestAutolinks({ autolinks })(tree as never);
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.type === "link") {
      found.push([
        node.children?.[0]?.value,
        node.url,
        node.data?.hProperties?.["dataPullRequestAutolink"],
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("remarkPullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in **abcdef1**. [#13](https://example.com) `#14`")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
});

describe("same-repository reference autolinks (issues phase 3 fence)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("issues phase 3 fence: agent prose links an explicit issue-number reference without linking commit hashes", () => {
    const autolinks = sameRepositoryReferenceAutolinker("https://github.com/pingdotgg/t3code");
    expect(links(`See #17402 after ${SHA} lands.`, autolinks)).toEqual([
      ["#17402", "https://github.com/pingdotgg/t3code/issues/17402", "reference"],
    ]);
  });

  it("issues phase 3 guard: agent prose leaves code, authored links and lookalike numbers untouched", () => {
    const autolinks = sameRepositoryReferenceAutolinker("https://github.com/acme/alpha");
    expect(
      links(
        "Run `git log #7`, read [#8](https://example.com/notes), jump [section #9](#9), not abc#10, #11a or #0, but #12.",
        autolinks,
      ),
    ).toEqual([
      ["#8", "https://example.com/notes", undefined],
      ["section #9", "#9", undefined],
      ["#12", "https://github.com/acme/alpha/issues/12", "reference"],
    ]);
  });
});

describe("pullRequestCommentPreview", () => {
  it.each([
    ["<!-- hidden -->\n> [!WARNING]\n**Guard** [this](https://example.com).", "Guard this."],
    [
      '<a href="https://example.com"><img src="badge.svg" /></a>\n<strong>Tasks keep the wrong computer</strong>',
      "Tasks keep the wrong computer",
    ],
    [
      "<details><summary>Review &amp; fixes</summary><p>First<br>Second</p></details>",
      "Review & fixes First Second",
    ],
    ['<p title="value > limit">Keep <strong>this</strong> readable.</p>', "Keep this readable."],
    [
      "Use `<div>` and `Promise<void>`.\n\n```html\n<span>example</span>\n```",
      "Use <div> and Promise<void>. <span>example</span>",
    ],
    ["![badge](https://example.com/badge.svg) **Review**", "badge Review"],
    ["```md\n[!TIP]\n> [!WARNING]\n```\n\n    [!NOTE]", "[!TIP] > [!WARNING] [!NOTE]"],
    [
      "Review :codex-file-citation{purpose='output'} safely.",
      "Review :codex-file-citation{purpose='output'} safely.",
    ],
    [":codex-followup[Prepare **print** version]", ":codex-followup[Prepare **print** version]"],
  ])("extracts readable text from %s", (body, expected) => {
    expect(pullRequestCommentPreview(body)).toBe(expected);
  });
});
