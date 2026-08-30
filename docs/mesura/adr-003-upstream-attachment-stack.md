# ADR-003 — Adopt upstream's attachment stack, retire the fork's

**Status:** Accepted, 2026-08-30.

**Scope:** how a user gets a file from a client into a turn, and which of two
implementations of that this fork carries.

## Decision

**Adopt T3 Code's attachment stack and retire this fork's.** Upstream's six
commits become the base; the work this fork shipped as PR #38 is removed rather
than merged with them.

**Carry exactly one thing forward**: the provider-path validation that `lstat`s
each attachment and rejects symlinks and non-regular files before provider work
starts. Upstream has no equivalent, it is small, and it guards a real boundary.

**Everything else in #38 goes**, including the resumable transport, the 2 GB
ceiling, the upload expiry sweep, and the fork's own upload route. The file
ceiling becomes upstream's 50 MB.

**The guard added in the 2026-W35 sync dies with it.** More on that below,
because it is the part a later reader will get wrong.

## They were never rival designs

Both sides grew from the same trunk. Upstream already had
`PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` at 10 MB and the whole `features/sharing/`
module before either change existed. This fork's #38 and upstream's six commits
extended that same foundation, in the same direction, during the same nine days
of 2026-08-21 to 2026-08-30 — independently, neither aware of the other.

That is why they collide so hard. Measured against `upstream/main` at the time
of this decision, a full merge conflicts in **92 files, and #38 accounts for 54
of them**. It is not that #38 is sprawling. It is that two people built the same
feature at once.

The sharpest single symptom: both independently added a constant with the same
name, `PROVIDER_SEND_TURN_MAX_FILE_BYTES`, at **2 GB here and 50 MB upstream** —
one line, guaranteed conflict, forty times apart in meaning.

## What each side is actually better at

This is not a case where one implementation dominates. They are ahead on
different axes, which is what made the decision worth recording.

**This fork was ahead on transport.** A dedicated tus-compatible HTTP endpoint
that **resumes at a byte offset**, a 2 GB ceiling, a disk-backed store with an
expiry sweep, and the `lstat` path check.

**Upstream is ahead on breadth and on hardening.** Their upload is an RPC
`attachments.createUploadUrl` returning a signed URL, then a single XHR — their
own queue says "Retry when the server reconnects", so an interrupted upload
**restarts**. But around it they have: RFC 6266 `Content-Disposition` with a
UTF-8 `filename*`, a `default-src 'none'; sandbox` content-security policy, and
a MIME allow-list that forces `octet-stream` for html and xml; HEIC to JPEG
conversion; video playback in chat; mobile pick, share and receive; and adapter
coverage across Claude, Codex, Cursor, Grok and OpenCode.

## Why upstream's wins anyway

Three reasons, in the order that decided it.

**The transport advantage does not apply to how this fork is used.** Resume
matters for large files over links that drop. The developer attaches small files
— screenshots, logs, short documents — usually over good links. Upstream's
restart-on-failure costs nothing at that size, and 50 MB is ample. We were
carrying a capability we do not exercise.

**Their download hardening is a gap we have today.** An attachment served
without the disposition header and the sandbox policy is a file a browser may
render instead of download. Switching is a net security gain, not a trade.

**Theirs is the one that keeps growing.** Upstream shipped six attachment
commits in nine days and will ship more. Every week we keep a parallel
implementation, we re-resolve the same collision and drift further from the code
those commits assume.

## What this costs, accepted knowingly

- **Resumable upload is gone.** If the developer's usage changes — large
  archives, recordings, or attaching from Android on mobile data — a 200 MB
  upload that restarts on every drop never finishes, and 50 MB blocks it
  outright. That is the condition that would reverse this decision, and it is
  worth naming precisely so it is recognised rather than rediscovered.
- **The upload expiry sweep is gone.** Upstream expires signed URLs instead;
  whether stale partial uploads accumulate on disk under their model is not
  something this decision verified.
- **Work is being thrown away.** #38 was 99 files. Deleting working code is
  unpleasant and it is still right: the cost of keeping it is paid every week
  and the benefit is one this fork does not collect.

## The guard that must die with it

The 2026-W35 sync added `tests/unit/upstream-sync-fork-edits.test.ts`, which
asserts that `attachmentPaths` still appears inside the retried
`generateThreadTitle` call. That guard exists because upstream's retry commit
conflicted with #38 there, and a future merge could silently drop the fork's
side.

**Retiring #38 makes that guard fail, correctly, for a reason it was not written
to express.** It catches an _accidental_ drop. This is a _deliberate_
retirement. Upstream passes `attachments` to title generation and does not pass
`attachmentPaths`; `resolveTextGenerationAttachmentPaths` came from #38 and goes
with it.

So the guard is deleted in the same commit that retires #38 — not repaired, and
not worked around. A later reader who finds it failing and "restores"
`attachmentPaths` to make it pass will have resurrected a fragment of a stack
this ADR removed on purpose.

## Relationship to the 2026-W35 sync

Pass 1 of that sync took 25 reliability fixes and deliberately took no
attachment work. This decision governs Pass 2, where the attachment commits sit
last by agreement, after the non-colliding fixes and the smaller keyboard and
sidebar collisions.

Nothing in Pass 1 depends on this decision except the guard named above.

## What would reverse this

One condition, stated so it can be recognised: **the developer starts attaching
files that are large, or attaching from a link that drops.** Then resume stops
being a capability we do not exercise and becomes the difference between an
upload that completes and one that never does.

The reversal is not "re-apply #38". It is "port resume onto upstream's base",
which is a different and smaller piece of work — their design is a single XHR to
a signed URL, so resume is a graft onto that, not a return to a parallel stack.
