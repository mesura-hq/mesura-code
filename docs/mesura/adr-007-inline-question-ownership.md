# ADR-007 — Keep pending questions in conversation rows

**Status:** Accepted under the inline-question plan.

## Decision

Web and desktop use `InlinePendingUserInputCard` as the only pending-question UI.
Remove `ComposerPendingUserInputPanel` and the question-specific composer wiring.
Remove the unused dictation answer-submission and question-advance helpers.
Keep the shared option-and-note answer contract and the existing attachment upload queue.

An inactive copy of the composer panel would retain a second answer lifecycle. Its
focus, draft, attachment, and dictation paths could drift from the visible card.
The approved interaction requires a normal composer while all questions remain
visible in the conversation. Retaining that inactive lifecycle does not provide
an equally maintainable implementation.

## Accepted upstream merge cost

Measured with `git log --oneline --since="3 months ago" upstream/main -- <path>`
on 2026-09-23, under `apps/web/src/components/`:

| File                                     | Upstream commits |
| ---------------------------------------- | ---------------: |
| `ChatView.tsx`                           |              235 |
| `chat/ChatComposer.tsx`                  |              122 |
| `chat/ComposerPendingUserInputPanel.tsx` |               12 |
| `chat/MessagesTimeline.tsx`              |              129 |

Deleting the panel creates a modify/delete conflict when upstream edits it.
Removing composer wiring also expands the existing conflict surface in ChatView
and ChatComposer. This cost is accepted to keep one visible owner for answers.

## Rule for upstream sync

At sync, take applicable upstream panel fixes into `InlinePendingUserInputCard`
or drop them when they apply only to the retired one-question composer flow.
Do not restore the panel or automatic answer submission to resolve a conflict.
Apply attachment validation and preparation fixes in `composerAttachmentFiles.ts`,
which both the normal composer and question attachments use. Keep question
transport on the explicit request-wide Submit action.
