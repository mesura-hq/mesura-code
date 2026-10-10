# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

## Attach files

Attach up to eight files per message. Images can be up to 10 MB; other files can
be up to 50 MB, subject to the environment's upload support and limit. The agent
receives them on the environment's machine.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to T3 Code through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, a message sent during a running turn waits at the end of the conversation as a
dashed bubble. It goes out on its own when the agent finishes its next tool
call, or when the turn ends. Use the arrow under the bubble to send it right
away, or the X to move it back into the composer. Stop returns every queued
message to the composer.

In **Settings → General → Follow-up behavior**, choose **Queue** to keep this
behavior or **Steer** to send new messages immediately. This setting applies to
the current client. Messages already queued keep their place.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message now. Change `thread.steerQueuedMessage` in
**Settings → Keybindings** to use another shortcut. It leaves the current draft
in the composer and waits if the agent needs an approval or an answer.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

T3 Code remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to restore them as well.
The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Answering an agent's questions

On web and desktop, each pending request appears as a card in the conversation. All questions stay
visible together. Choose options and add a note below each question. The answer includes both the
selected options and your note. Choice-only questions require a listed option.

Use **Submit** once to send the whole request. If an answer is missing, Submit focuses that question
and keeps every draft editable. Failed responses keep the drafts and offer **Retry**. The normal
composer stays separate: it sends or queues a normal message, never a question answer.

Use the microphone beside a question's text field to dictate into that answer. The text lands at
the field's caret. In Send mode, the request is submitted once the text lands; otherwise use
**Submit** when the complete request is ready. Files belong to their own question; wait for uploads
to finish or retry or remove a failed upload.

On mobile, pending requests appear as cards in the conversation, with all questions in each request
together. Dictation fills an answer but never submits it. Submit sends the complete request. The regular message composer stays separate. The web
and desktop keyboard shortcuts do not apply to mobile.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice dictation

Mesura Code transcribes on its server with your OpenAI key. Set the key once in **Settings →
Dictation**; every device connected to that server uses it. The same page takes vocabulary hints,
one name or term per line, for words the transcription should spell correctly.

Select the microphone beside Send to start recording. The strip above the composer shows the
elapsed time, a live waveform, and pause, restart, cancel and stop. Stop and transcribe ends the
recording; the composer stays editable the whole time.

The mode button cycles through three modes:

- **Copy** copies the text to the clipboard and leaves the draft alone.
- **Insert** puts the text in the draft.
- **Send** puts the text in the draft and sends the message.

While a recording or its transcription is in progress, Alt+S selects Copy, Alt+I selects Insert
and Alt+Enter selects Send. These keys only choose the mode; they do not stop the recording.

When you stop, a small marker with a moving wave appears where your caret is. Keep typing, move the
caret, record again, or open another chat: the text replaces its marker when it arrives, even in a
chat you are not looking at. If you delete a marker, its text stays in the Transcriptions list. A
failed marker offers **Retry** and **Discard**.

A message in Send mode goes out once its last marker is filled. Pressing Send while a marker is
still waiting does the same, and a banner says the message will send when the text lands. Choose
**Don't send** to keep the text without sending. A message with dictated text starts with one
`[voiced]` tag.

**Transcriptions** in the command palette lists recent dictation on the server, to copy or retry.
The server keeps it for a day, and a server restart clears it.

### Dictation on a phone

On a phone, open Mesura Code in the browser and dictate the same way: the browser asks once for the
microphone, and the marker, modes and send-when-ready work as on the desktop.

### Dictate from another app on Hyprland

With Mesura Code running, sending `toggle` to its dictation socket starts a recording, and sending
it again stops it. The transcript goes to the last chat you had open. To use it from any app, install
`socat` and add a bind to your Hyprland config, with your user id in the path (`id -u`):

```
bind = SUPER ALT, M, exec, printf 'toggle\n' | socat -u - UNIX-CONNECT:/run/user/1000/mesura-code/dictation.sock 2>/dev/null || mesura-code --dictation toggle
```

The socket answers in milliseconds. The part after `||` starts Mesura Code when it is not running,
which takes a few seconds. That path belongs to the installed app; a development build or one run
with its own `XDG_CONFIG_HOME` listens elsewhere, so this bind reaches it only through the slower
fallback. Any free key works. Symmetria Shell's own dictation key stays as it is for
other apps.

While a recording or its transcription is in progress, Mesura Code binds Alt+S (copy), Alt+I
(insert), Alt+Enter (send), Alt+Space (pause), Alt+R (restart) and Alt+X (cancel), and releases them
when it ends.

A small widget at the bottom of the screen shows the recording while another app has focus. Add these
window rules so it floats on every workspace and never takes focus:

```
windowrule = float on, match:title ^(mesura-dictation-overlay)$
windowrule = pin on, match:title ^(mesura-dictation-overlay)$
windowrule = no_initial_focus on, match:title ^(mesura-dictation-overlay)$
windowrule = no_focus on, match:title ^(mesura-dictation-overlay)$
```

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

Provider commands must start the message to run. T3 Code commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete T3 Code tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your T3 Code session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
