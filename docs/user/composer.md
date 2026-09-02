# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Answering an agent's questions

On the desktop app and in the browser, the composer shows one question at a time. Choose an option,
or type your own answer in the composer, and the button below moves you to the next question. A
question cannot be passed over unanswered: every answer in the set is sent together.

The button on the last question sends all of them. If an earlier answer is still missing, the button
names that question instead — press it to go back and answer it.

The mobile app lists every question of the set in one card, and its button sends them once they all
have an answer.

## Voice dictation

The Linux desktop app can use Symmetria Shell for voice dictation. The microphone beside Send starts
one Shell recording for the chat that is open at that moment. Mesura Code keeps that chat as the
destination if you open another chat while recording or transcription continues.

The strip above the composer shows elapsed time, a high-contrast center-out live waveform, and the
recording controls. The mode button cycles through Copy, Insert, and Send. You can change the mode
while recording, while processing, and during the three-second delay before delivery.

Mesura Code shows the strip only while its window is focused on the destination chat. Symmetria Shell
shows its recorder widget everywhere else. The two surfaces control the same recording.

If Mesura cannot reserve the chat, Symmetria Shell shows an error but keeps recording and
transcribing. It copies the result to the clipboard for manual paste and does not send it to another
chat.

Symmetria Shell always reports the final result. A send success means Mesura Code confirmed that the
dictated user message started the matching provider turn. If the destination no longer exists,
Symmetria Shell keeps the transcript available for clipboard recovery and does not send it to the
chat that happens to be open.
You can attach images up to 10 MB. On servers that support file uploads, you can also
attach text files, PDFs, ZIP archives, and other files. Each file can be up to the limit advertised
by the server, capped at 50 MB. Each message can contain up to eight attachments in total. Files
upload directly to the environment, where your agent can read, copy, or edit them by their file path.

On web and desktop, attachments upload as soon as you add them. The send button becomes available
after every upload finishes. Failed uploads can be retried or removed. On mobile, the **+** control
offers Photos, and adds Files when the connected server supports file uploads. You can share a file
into T3 Code from any app through the system share sheet. Mobile uploads happen when the message
sends, so queued messages keep their files until they deliver. Select a received file on mobile
to save it or open it in another app through the system share sheet.

On web and desktop, select a video attachment before or after sending to play it with the browser's
built-in controls. Playback depends on the video formats and codecs that the browser supports.

On web and desktop, if you reload before a file finishes uploading, the draft keeps the file's name
and shows **Attach again** next to it. Attach the file again or remove it, then send.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Prompt stash

Use the default shortcut, `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux, to stash the current
prompt and its attachments after all file uploads finish. Restore the entry later from the stash
menu. Stashes that contain files must be restored in the environment where those files were
uploaded. Stashed files stay uploaded on the server for 24 hours. If you restore an entry after
that, the file comes back with **Attach again** next to it. Attach the file again or remove it, then
send.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are available on the **New task** screen before you start a thread. They
use the skills and commands from the selected environment and provider.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.
