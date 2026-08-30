import type { DraftComposerAttachment } from "./composerImages";

const OWNED_ATTACHMENT_DIRECTORIES = [
  "composer-attachments",
  "t3-composer-paste",
  "incoming-share-files",
] as const;

export async function removeOwnedComposerAttachment(
  attachment: DraftComposerAttachment,
): Promise<void> {
  const uri = attachment.type === "image" ? attachment.previewUri : attachment.uri;
  if (!uri.startsWith("file:")) return;
  try {
    const { File } = await import("expo-file-system");
    const file = new File(uri);
    const owned = OWNED_ATTACHMENT_DIRECTORIES.some((directory) => uri.includes(`/${directory}/`));
    if (file.exists && owned) file.delete();
  } catch (error) {
    console.warn("[composer-attachments] failed to remove owned file", error);
  }
}
