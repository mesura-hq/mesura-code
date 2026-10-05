# Dictation

Mesura Code owns dictation end to end. A client records audio, the server transcribes it, and the
client that holds the draft places the text. Web and desktop use the same path, and a phone uses it
through the web app in its browser; this fork has no native mobile client (ADR-008).

## The server job

Transcription runs only on the server, in [`DictationJobs`](../../apps/server/src/dictation/DictationJobs.ts).
A client uploads the recording through the existing signed `file` upload, then starts a job that
names the upload, the recording length, the mode and the target. The server calls OpenAI with the
key from server settings and pushes every job's state and text to subscribed clients.

The server owns transcription for two reasons:

- A phone browser has no reliable transcription engine, and every device must give the same
  quality in Spanish and English.
- The OpenAI key is set once per host, in Settings, and every client of that host uses it. The
  key stays in the secret store and never reaches a client.

Jobs live in memory for 24 hours. A server restart forgets them, including text not yet
delivered. The engine choice in [`openAiTranscription.ts`](../../apps/server/src/dictation/openAiTranscription.ts)
matches Symmetria Shell's: `gpt-4o-transcribe` silently truncates long audio, so recordings over
420 s use `whisper-1`. No language parameter is sent, because the user mixes Spanish and English.

## The marker token

When a recording stops, the client drops a marker into the draft at the caret. The marker is an
ordinary context link, `[Transcribing](t3-context://v1/dictation/<jobId>)`, defined in
[`dictationSlots.ts`](../../packages/shared/src/dictationSlots.ts). It is text in the prompt, not an
editor node, so a draft that is not mounted can still be filled: another thread, a reloaded tab, or
another device.

Two traps follow from that choice:

- The link never has a context record. Code that walks context links must skip the `dictation`
  kind, or it reports a missing record or sends the link to a provider. The send state refuses a
  prompt that still holds a marker.
- The web editor draws the marker as the stepped wave.

## Filling is idempotent by job id

A completed job replaces the marker whose id is its job id. A filled marker is gone, so a second
fill for the same job finds nothing and reports `missing`. Every tab and every device can
therefore fill wherever its own copy of the draft still holds the marker, with no coordination.

The one-off effects of a job happen once per client, through the delivery ledger in
[`session.ts`](../../packages/client-runtime/src/dictation/session.ts). These effects are the
clipboard copy in save mode, the send, and the notice for a deleted marker. A job whose marker the
user deleted keeps its text in the Transcriptions list.

## Send when ready

A draft is armed in two ways: a recording stops in send mode, or the user presses Send while a
marker is pending. An armed draft stays editable. After every fill, discard or deleted marker, the
client checks the draft: with no marker left, it sends. The marker count in the text decides, not
the job list. A failed marker keeps the draft armed and unsent until a retry fills it or the user
discards it.

A sent message gets one `[voiced] ` prefix when any part of it was dictated, never one per
insertion. Mid-sentence insertions would otherwise scatter tags through the message.

A draft for a thread that is not on screen sends through the directed submission path in
[`directedComposerSubmission.ts`](../../apps/web/src/dictation/directedComposerSubmission.ts). That
path refuses to send while a button approval is pending, because free text cannot answer one.

## The desktop widget

When another app has focus, a small Electron window titled `mesura-dictation-overlay` shows the
recording and its transcription. The main window's renderer publishes the state, so the widget
opens no server connection of its own. Without the four Hyprland window rules in the composer user
guide (`float`, `pin`, `no_initial_focus`, `no_focus`), Hyprland focuses the window and keeps it on
one workspace. The plan supplies the rules, and the user's dotfiles hold them.

While a recording or its transcription exists, the desktop binds Alt+S, Alt+I, Alt+Enter,
Alt+Space, Alt+R and Alt+X through `hyprctl`. Every session start unbinds before it binds, so binds
that leaked after a crash cannot stack.

## Why the Symmetria Shell link was removed

Desktop dictation used to be a protocol between two processes. Shell recorded and transcribed, and
a broker in Electron main reserved a composer target and applied the transcript. The link existed
only on the laptop, so the phone had no dictation. Its timeouts turned any delay into a silent
clipboard fallback, which lost automatic sends. Mesura now records itself, so the broker, its two
sockets, the renderer bridge and the persisted command ledger are gone.
[`symmetria-dictation-integration.test.ts`](../../tests/unit/symmetria-dictation-integration.test.ts)
fails if any of them returns. The Symmetria thread feed is a separate socket and stays.

Shell still records for other apps. When Mesura does not answer on the old socket, Shell copies the
transcript to the clipboard.
