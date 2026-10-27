import { FileIcon, ImageIcon } from "lucide-react";
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  cloneElement,
  useRef,
} from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Android Chrome opens the system photo picker only for an input whose every
 * accepted type is `image/*` or `video/*` and that has no `capture` attribute
 * (Chromium `SelectFileDialog.shouldUsePhotoPicker`). An input that accepts
 * anything opens the generic chooser instead, where the gallery is a scroll
 * and a further tap away. Videos are offered only where the attachment target
 * takes non-image files, because a video is staged as a file attachment.
 */
function mediaPickerAccept(includeVideos: boolean): string {
  return includeVideos ? "image/*,video/*" : "image/*";
}

function takePickedFiles(input: HTMLInputElement): File[] {
  const files = Array.from(input.files ?? []);
  // Cleared so picking the same file again still fires `change`.
  input.value = "";
  return files;
}

/**
 * The attach control shared by the composer and question fields. A fine
 * pointer keeps the single tap to the file dialog. A touch device gets a menu
 * whose first item opens the media picker directly; "Files" keeps the broad
 * input, which also carries the camera and the document chooser.
 */
export function AttachmentPicker({
  label,
  includeVideos,
  disabled = false,
  keepFocusOnPress = false,
  trigger,
  popupProps,
  onFilesPicked,
  children,
}: {
  /** Accessible name of the trigger. Keyboard commands find the trigger by it. */
  readonly label: string;
  readonly includeVideos: boolean;
  readonly disabled?: boolean;
  /**
   * Keeps focus where it is (the composer's editor) when the button opens the
   * file dialog. Applied only without the menu: Base UI opens a menu on
   * `mousedown`, which preventing `pointerdown` suppresses, so the menu would
   * never open.
   */
  readonly keepFocusOnPress?: boolean;
  /** The trigger element; this component supplies its label and press behaviour. */
  readonly trigger: ReactElement<{ disabled?: boolean }>;
  readonly popupProps?: Omit<ComponentProps<typeof MenuPopup>, "children">;
  readonly onFilesPicked: (files: File[]) => void;
  /** The trigger's icon. */
  readonly children: ReactNode;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const offersMediaPicker = useMediaQuery({ pointer: "coarse" });
  // A tooltip trigger's own `disabled` only silences the tooltip; the button
  // itself has to carry the attribute.
  const triggerElement = cloneElement(trigger, { disabled });
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      hidden
      onChange={(event) => onFilesPicked(takePickedFiles(event.currentTarget))}
    />
  );

  if (!offersMediaPicker) {
    return (
      <>
        {fileInput}
        <Tooltip>
          <TooltipTrigger
            render={triggerElement}
            aria-label={label}
            onPointerDown={keepFocusOnPress ? (event) => event.preventDefault() : undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            {children}
          </TooltipTrigger>
          <TooltipPopup>Attach files</TooltipPopup>
        </Tooltip>
      </>
    );
  }

  const mediaLabel = includeVideos ? "Photos and videos" : "Photos";
  return (
    <>
      {fileInput}
      <input
        ref={mediaInputRef}
        type="file"
        accept={mediaPickerAccept(includeVideos)}
        multiple
        hidden
        data-attachment-media-input=""
        onChange={(event) => onFilesPicked(takePickedFiles(event.currentTarget))}
      />
      <Menu>
        <MenuTrigger render={triggerElement} aria-label={label} disabled={disabled}>
          {children}
        </MenuTrigger>
        <MenuPopup align="start" side="top" {...popupProps}>
          <MenuItem density="touch" onClick={() => mediaInputRef.current?.click()}>
            <ImageIcon />
            <MenuItemLabel>{mediaLabel}</MenuItemLabel>
          </MenuItem>
          <MenuItem density="touch" onClick={() => fileInputRef.current?.click()}>
            <FileIcon />
            <MenuItemLabel>Files</MenuItemLabel>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
