import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";

import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

describe("pull request body segmentation", () => {
  it("keeps a plain body as a single markdown run", () => {
    expect(splitPullRequestBody("## What changed\n\nSome prose.")).toEqual([
      { id: "markdown:0", kind: "markdown", text: "## What changed\n\nSome prose." },
    ]);
  });

  // GitHub writes a dropped image into the body as an `<img>` tag, so a bare attachment link on
  // its own line is the shape it uses for a video — every one sampled in the wild was one.
  it("lifts a dropped video out and keeps the prose around it", () => {
    expect(
      splitPullRequestBody(
        "Before\n\nhttps://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456\n\nAfter",
      ),
    ).toEqual([
      { id: "markdown:0", kind: "markdown", text: "Before" },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456",
        media: "video",
      },
      { id: "markdown:2", kind: "markdown", text: "After" },
    ]);
  });

  it("names a bare link to a video file a video", () => {
    expect(splitPullRequestBody("https://example.com/demo.mp4?raw=1")).toEqual([
      {
        id: "attachment:0",
        kind: "attachment",
        url: "https://example.com/demo.mp4?raw=1",
        media: "video",
      },
    ]);
  });

  it("reads the source out of a video tag, including a multi-line one", () => {
    expect(
      splitPullRequestBody(
        '<video controls>\n  <source src="https://example.com/a.webm">\n</video>',
      ),
    ).toEqual([
      {
        id: "attachment:0",
        kind: "attachment",
        url: "https://example.com/a.webm",
        media: "video",
      },
    ]);
  });

  it("leaves a dropped image as markdown so it still renders as an image", () => {
    const body = "![shot](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-ab)";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves the img tag GitHub writes for a dropped image as markdown", () => {
    const body =
      '<img width="1414" alt="image" src="https://github.com/user-attachments/assets/7195f963-51a9-4331-be74-3e06be760422" />';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an ordinary link alone, whether it is bare or written as markdown", () => {
    const body = "https://example.com/page\n\n[the docs](https://example.com/docs)";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("never lifts a link inside fenced code out of it", () => {
    const body = "```\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("does not let a different fence marker close an open fence", () => {
    const body = "```\n~~~\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("keeps a video tag that shares its line with prose as markdown", () => {
    const body = 'Before <video src="https://example.com/a.mp4"></video> after';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("keeps the indentation that opens a code block", () => {
    const body = "    const answer = 42;";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("treats an info-string fence as a nested opener, not a close", () => {
    const body = "```\n```javascript\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an indented code line alone even when it is only a video link", () => {
    const body = "    https://example.com/demo.mp4";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an unclosed video tag as prose without eating the rest of the body", () => {
    const body = ['<video src="https://example.com/a.mp4">', "still prose", "more prose"].join(
      "\n",
    );
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("stays linear when the body is full of unclosed video tags", () => {
    const body = Array.from(
      { length: 4_000 },
      () => '<video src="https://example.com/a.mp4">',
    ).join("\n");
    const startedAt = performance.now();
    expect(splitPullRequestBody(body)).toHaveLength(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("refuses a non-http source rather than making a link out of it", () => {
    const body = '<video src="javascript:alert(1)"></video>';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });
});

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
