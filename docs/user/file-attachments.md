# File attachments

Use an attachment when the file is on the client device or outside the project workspace. The client uploads the file to the active remote environment. The agent receives a readable path on that environment.

Use `@` when the file already exists in the project workspace. An `@` mention identifies an existing workspace path. It does not copy the file between machines.

You can attach a file in these ways:

- Select the paperclip between the context meter and the send control.
- Run `/attach` in the composer.
- Press `Alt+A`.
- Drop files from the operating system onto the chat or the composer.
- Paste files from the clipboard.

The composer shows the state of each upload. Wait until all attachments show `Ready` before sending. Retry or remove a failed attachment. Removing an in-progress attachment cancels its upload.

Mesura Code uploads images, videos, PDFs, and other files in resumable chunks. A temporary connection failure resumes from the last server-confirmed byte. A message can contain up to eight attachments. Images can be up to 10 MB after image compression. Other files can be up to 2 GB.

Workspace explorer drags remain `@` mentions. Operating-system drags create attachments.

On Android and iOS, select the plus control or run `/attach` to open the system file picker. Mobile drafts keep selected files in app-owned storage. If the environment is offline, the outbox keeps the file URI and uploads the bytes when the connection returns. Large mobile files are not stored as base64 text.
