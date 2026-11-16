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
  root,
  editor,
  onDismiss,
}: Pick<FileEditorDismissalOptions, "root" | "editor" | "onDismiss">): void {
  const selection = root.ownerDocument.getSelection();
  const outsideRange =
    selection !== null &&
    !selection.isCollapsed &&
    selection.rangeCount === 1 &&
    !selection.getRangeAt(0).intersectsNode(root)
      ? selection.getRangeAt(0).cloneRange()
      : null;
  const backwards =
    selection !== null &&
    outsideRange !== null &&
    selection.anchorNode === outsideRange.endContainer &&
    selection.anchorOffset === outsideRange.endOffset;
  onDismiss();
  editor.collapseSelection();
  editor.blur();
  // Collapsing an editor selection can also move the document selection. Restore only
  // an outside range, so dismissal never revives the file selection it just collapsed.
  if (outsideRange?.startContainer.isConnected && outsideRange.endContainer.isConnected) {
    const { startContainer, startOffset, endContainer, endOffset } = outsideRange;
    selection?.setBaseAndExtent(
      backwards ? endContainer : startContainer,
      backwards ? endOffset : startOffset,
      backwards ? startContainer : endContainer,
      backwards ? startOffset : endOffset,
    );
  }
}

export function installFileEditorDismissal({
  root,
  editor,
  isBlocked,
  onDismiss,
}: FileEditorDismissalOptions): () => void {
  const handlePointerDown = (event: PointerEvent) => {
    if (isBlocked() || event.composedPath().includes(root)) return;
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    // Capture phase, and stopped immediately: Monaco binds Escape itself, and
    // without taking it first the editor would keep focus after dismissing.
    if (event.key !== "Escape" || isBlocked() || !editor.hasTextFocus()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };

  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("keydown", handleKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  };
}
