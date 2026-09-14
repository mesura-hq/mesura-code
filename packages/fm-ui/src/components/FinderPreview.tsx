/**
 * The file manager's answer to the finder's `renderPreview`.
 *
 * The finder ships in a package that must not import this one — that is what
 * lets a host mount it without the file manager — so it owns the information
 * panel's layout and takes the preview renderer as a prop. This is the file
 * manager's renderer, and it is deliberately three lines of wiring around the
 * hooks the main window already uses.
 *
 * **Every preview type therefore arrives at once**, and nothing is re-routed
 * here: images, documents, video, audio, code with highlighting, archives,
 * spreadsheets, markdown and directory listings all come from the same router
 * the pane uses. The Qt tree states the same rule for the same reason — one
 * router, two consumers — and a type added there appears in both.
 *
 * **The debounce lives inside `usePreview`**, at the 150 ms this would
 * otherwise have used. The finder deliberately adds no second stage in front of
 * it; see `FinderInfoPanel`'s header.
 */

import { usePreviewPane } from "../usePreview.ts";
import { PreviewPane } from "./preview/PreviewPane.tsx";

export interface FinderPreviewProps {
  readonly path: string;
  readonly renderDocuments: boolean;
}

export function FinderPreview({ path, renderDocuments }: FinderPreviewProps) {
  const previewing = usePreviewPane(path, renderDocuments);
  return <PreviewPane {...previewing.pane} />;
}
