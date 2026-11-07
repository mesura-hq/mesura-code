import { RuntimeRequestId, TrimmedNonEmptyString, type ThreadId } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";

const label = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const fieldId = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/));
export const DraftReviewDefinition = Schema.Struct({
  title: label,
  channel: label,
  channelLabel: Schema.optional(label),
  fields: Schema.Array(
    Schema.Struct({
      id: fieldId,
      label,
      value: Schema.String.check(Schema.isMaxLength(4000)),
      required: Schema.optional(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(10)),
  body: Schema.String.check(Schema.isMaxLength(100000)),
}).check(
  Schema.makeFilter(
    (draft) =>
      new Set(draft.fields.map((field) => field.id)).size === draft.fields.length ||
      "Draft field IDs must be unique.",
  ),
);
export type DraftReviewDefinition = typeof DraftReviewDefinition.Type;

// draftReview owns the original values; questions identify replies without duplicating the body.
export function draftReviewQuestions(draft: DraftReviewDefinition) {
  return [
    ...draft.fields.map((field) => ({
      id: `field:${field.id}`,
      header: field.label,
      question: field.label,
      required: field.required ?? false,
      options: [],
      allowCustomAnswer: true,
    })),
    {
      id: "body",
      header: "Draft",
      question: "Draft text",
      required: true,
      options: [],
      allowCustomAnswer: true,
    },
  ];
}

/** Validate the reply without normalizing the text the user approved. */
export function reviewedDraft(
  draft: DraftReviewDefinition,
  answers: Readonly<Record<string, unknown>>,
  allowEmpty = false,
) {
  const body = answers.body;
  if (typeof body !== "string" || (!allowEmpty && !body.trim()) || body.length > 100000)
    throw new Error("Enter the draft text before confirming.");
  const fields = draft.fields.map((field) => {
    const value = answers[`field:${field.id}`];
    if (
      typeof value !== "string" ||
      value.length > 4000 ||
      (!allowEmpty && field.required && !value.trim())
    )
      throw new Error(`Enter a valid ${field.label}.`);
    return { ...field, value };
  });
  return { ...draft, body, fields };
}

export function draftReviewReply(draft: DraftReviewDefinition) {
  return `The user confirmed this draft. Use this exact version. Confirmation returns the text for review; it does not authorize sending or publishing it.\n${JSON.stringify(draft)}`;
}

export function draftReviewRequestId(threadId: ThreadId, requestKey: string) {
  return RuntimeRequestId.make(
    `draft:${encodeURIComponent(threadId)}:${encodeURIComponent(requestKey)}`,
  );
}
