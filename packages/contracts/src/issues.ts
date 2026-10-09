import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const IssueState = Schema.Literals(["open", "closed", "all"]);
export type IssueState = typeof IssueState.Type;

export const IssueSummary = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  assignees: Schema.Array(Schema.Struct({ login: Schema.String })),
  labels: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type IssueSummary = typeof IssueSummary.Type;

export const IssueDetail = Schema.Struct({
  ...IssueSummary.fields,
  body: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
      body: Schema.String,
      createdAt: Schema.String,
      url: Schema.String,
    }),
  ),
});
export type IssueDetail = typeof IssueDetail.Type;

export const IssueListInput = Schema.Struct({
  projectId: ProjectId,
  state: IssueState,
  query: Schema.String.check(Schema.isMaxLength(500)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type IssueListInput = typeof IssueListInput.Type;

export const IssueListResult = Schema.Struct({
  repository: Schema.String,
  repositoryUrl: Schema.String,
  issues: Schema.Array(IssueSummary),
  hasMore: Schema.Boolean,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueDetailInput = Schema.Struct({ projectId: ProjectId, number: PositiveInt });
export type IssueDetailInput = typeof IssueDetailInput.Type;

export class IssueReadError extends Schema.TaggedError<IssueReadError>()("IssueReadError", {
  message: TrimmedNonEmptyString,
}) {}
