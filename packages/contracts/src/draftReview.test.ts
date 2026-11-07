import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ThreadId } from "./baseSchemas.ts";
import {
  DraftReviewDefinition,
  draftReviewReply,
  draftReviewRequestId,
  reviewedDraft,
} from "./draftReview.ts";

const draft = {
  title: "Reply",
  channel: "custom",
  fields: [{ id: "subject", label: "Subject", value: "Original", required: true }],
  body: "Original",
};

it("preserves exact confirmed text and rejects malformed or incomplete replies", () => {
  const answers = { body: "  Hola 🙂\n\nBody.  ", "field:subject": " Revised " };
  const revised = reviewedDraft(draft, answers);
  const reply = draftReviewReply(revised);
  expect(JSON.parse(reply.slice(reply.indexOf("\n") + 1))).toEqual({
    ...draft,
    body: answers.body,
    fields: [{ ...draft.fields[0], value: answers["field:subject"] }],
  });
  for (const invalid of [
    { ...answers, body: " " },
    { ...answers, body: ["Text"] },
    { ...answers, "field:subject": "" },
    { body: "Text" },
    { ...answers, body: "x".repeat(100001) },
  ])
    expect(() => reviewedDraft(draft, invalid)).toThrow();
  expect(reviewedDraft(draft, { body: "", "field:subject": "" }, true).body).toBe("");
});

it("bounds extensible channels and field metadata and namespaces request keys", () => {
  const decode = Schema.decodeUnknownSync(DraftReviewDefinition);
  expect(decode(draft).channel).toBe("custom");
  for (const invalid of [
    { ...draft, fields: [...draft.fields, ...draft.fields] },
    { ...draft, title: " " },
    { ...draft, fields: [{ ...draft.fields[0], id: "body:other" }] },
    {
      ...draft,
      fields: Array.from({ length: 11 }, (_, i) => ({
        id: `field${i}`,
        label: "Field",
        value: "",
      })),
    },
  ])
    expect(() => decode(invalid)).toThrow();
  expect(draftReviewRequestId(ThreadId.make("thread:a"), "b")).not.toBe(
    draftReviewRequestId(ThreadId.make("thread"), "a:b"),
  );
  expect(draftReviewRequestId(ThreadId.make("thread"), "key:revision")).not.toBe(
    `${draftReviewRequestId(ThreadId.make("thread"), "key")}:revision`,
  );
});
