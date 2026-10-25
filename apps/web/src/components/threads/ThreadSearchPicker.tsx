import type { RefObject } from "react";

import { AgentThreadSearch, type ThreadSearchBackHandler } from "./AgentThreadSearch";

/**
 * The command palette's `threads` mode: the agent search, where the user
 * describes a thread instead of typing its words. Finding a thread by its
 * words is the sidebar Search's job, which searches every project while it has
 * text; the palette's "Search threads" row moves focus there.
 */
export function ThreadSearchPicker(props: {
  readonly setOpen: (open: boolean) => void;
  /** Where the agent search offers the palette its own Escape step. */
  readonly backHandlerRef: RefObject<ThreadSearchBackHandler | null>;
}) {
  return <AgentThreadSearch backHandlerRef={props.backHandlerRef} setOpen={props.setOpen} />;
}
