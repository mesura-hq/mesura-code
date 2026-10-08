/** Copies a yank to the system clipboard; a denied write is not an error worth a toast. */
export function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}
