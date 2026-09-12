interface FileEditorDismissalOptions {
  root: HTMLElement;
  editor: {
    hasTextFocus: () => boolean;
    collapseSelection: () => void;
    blur: () => void;
  };
  isBlocked: () => boolean;
  onDismiss: () => void;
}

function dismissFileEditorInteraction({
  editor,
  onDismiss,
}: Pick<FileEditorDismissalOptions, "editor" | "onDismiss">): void {
  onDismiss();
  editor.collapseSelection();
  editor.blur();
}

export function installFileEditorDismissal({
  root,
  editor,
  isBlocked,
  onDismiss,
}: FileEditorDismissalOptions): () => void {
  const handlePointerDown = (event: PointerEvent) => {
    if (isBlocked() || event.composedPath().includes(root)) return;
    dismissFileEditorInteraction({ editor, onDismiss });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    // Capture phase, and stopped immediately: Monaco binds Escape itself, and
    // without taking it first the editor would keep focus after dismissing.
    if (event.key !== "Escape" || isBlocked() || !editor.hasTextFocus()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissFileEditorInteraction({ editor, onDismiss });
  };

  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("keydown", handleKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  };
}
