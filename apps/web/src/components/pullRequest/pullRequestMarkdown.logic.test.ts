import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";
import { remarkPullRequestAutolinks } from "./pullRequestMarkdown.logic";

describe("same-repository reference autolinks (issues phase 3 fence)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  function paragraph(...children: MarkdownNode[]): MarkdownNode {
    return { type: "root", children: [{ type: "paragraph", children }] };
  }

  function links(tree: MarkdownNode): Array<{ url: string | undefined; text: string }> {
    const found: Array<{ url: string | undefined; text: string }> = [];
    const visit = (node: MarkdownNode) => {
      if (node.type === "link") {
        found.push({
          url: node.url,
          text: (node.children ?? []).map((child) => child.value ?? "").join(""),
        });
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    return found;
  }

  it("issues phase 3 guard: pull request prose still links references and commits", () => {
    const tree = paragraph({ type: "text", value: `Fixes #7 in ${SHA}.` });
    remarkPullRequestAutolinks({ repositoryUrl: "https://github.com/acme/alpha/" })(tree);

    expect(links(tree)).toEqual([
      { url: "https://github.com/acme/alpha/issues/7", text: "#7" },
      { url: `https://github.com/acme/alpha/commit/${SHA}`, text: SHA.slice(0, 7) },
    ]);
  });

  it("issues phase 3 fence: agent prose links an explicit issue-number reference without linking commit hashes", () => {
    const tree = paragraph({ type: "text", value: `See #17402 after ${SHA} lands.` });
    remarkPullRequestAutolinks({
      repositoryUrl: "https://github.com/pingdotgg/t3code",
      commits: false,
    })(tree);

    expect(links(tree)).toEqual([
      { url: "https://github.com/pingdotgg/t3code/issues/17402", text: "#17402" },
    ]);
  });

  it("issues phase 3 guard: agent prose leaves code, authored links and lookalike numbers untouched", () => {
    const tree = paragraph(
      { type: "text", value: "Run " },
      { type: "inlineCode", value: "git log #7" },
      { type: "text", value: ", read " },
      { type: "link", url: "https://example.com/notes", children: [{ type: "text", value: "#8" }] },
      { type: "text", value: ", jump " },
      { type: "link", url: "#9", children: [{ type: "text", value: "section #9" }] },
      { type: "text", value: ", not abc#10, #11a or #0, but #12." },
    );
    remarkPullRequestAutolinks({ repositoryUrl: "https://github.com/acme/alpha", commits: false })(
      tree,
    );

    expect(links(tree)).toEqual([
      { url: "https://example.com/notes", text: "#8" },
      { url: "#9", text: "section #9" },
      { url: "https://github.com/acme/alpha/issues/12", text: "#12" },
    ]);
  });
});
