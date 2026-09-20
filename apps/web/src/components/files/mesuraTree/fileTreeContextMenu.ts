import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";

/**
 * The row's right-click menu: the two things a file is for in a chat.
 *
 * Native on the desktop, a DOM fallback in the browser; both through the local
 * API so the tree never knows which. The mention format is the composer's own.
 */
export async function showFileTreeContextMenu(input: {
  readonly relativePath: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly composer: ChatComposerHandle | null;
}): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const { relativePath, composer } = input;
  const mention = serializeComposerFileLink(relativePath);
  try {
    const clicked = await api.contextMenu.show(
      [
        { id: "copy-mention", label: "Copy mention" },
        { id: "add-to-chat", label: "Add to chat" },
      ],
      input.position,
    );
    if (clicked === "copy-mention") {
      try {
        await writeTextToClipboard(mention);
        toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to copy mention",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return;
    }
    if (clicked === "add-to-chat") {
      if (!composer) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "Open a chat for this project and try again.",
        });
        return;
      }
      const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "The chat isn't ready to accept input right now.",
        });
      }
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to open the menu",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  } finally {
    await api.contextMenu.close();
  }
}
