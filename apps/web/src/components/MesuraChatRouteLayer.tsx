import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";

import { MesuraFileManagerLayer } from "~/components/files/mesuraFileManager/MesuraFileManagerLayer";
import { useFileTreeShortcut } from "~/components/files/mesuraTree/useFileTreeShortcut";
import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { usePaneNavigation } from "~/lib/usePaneNavigation";
import { useQuietThreadShell } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";

/** The fork's chat-route keys and the file manager, mounted while no modal page covers the chat. */
export function MesuraChatRouteLayer() {
  const routeThreadRef = useThreadRouteRef();
  const activeThread = useQuietThreadShell(routeThreadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useFileTreeShortcut(routeThreadRef);
  // Claimed in the capture phase, ahead of every chord scope and every pane,
  // so a pane chord means one thing wherever it is typed. The thread ref names
  // the open thread's row as the way into the sidebar.
  usePaneNavigation(keybindings, routeThreadRef ? scopedThreadKey(routeThreadRef) : null);
  return <MesuraFileManagerLayer routeThreadRef={routeThreadRef} activeThread={activeThread} />;
}
