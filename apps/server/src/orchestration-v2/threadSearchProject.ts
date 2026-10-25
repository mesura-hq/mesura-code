/**
 * Mesura: the hidden project that holds search conversations
 * (docs/mesura/adr-010-search-chats.md). It is an internal identity, not a
 * workspace: generic project deletion refuses it, so its stable creation
 * receipt stays valid, while each search is deleted as an ordinary thread.
 */
import { THREAD_SEARCH_PROJECT_ID, type ProjectId } from "@t3tools/contracts";

export const THREAD_SEARCH_PROJECT_DELETION_REFUSAL =
  "The internal search project cannot be deleted. Delete individual search conversations instead.";

export const isThreadSearchProject = (projectId: ProjectId) =>
  projectId === THREAD_SEARCH_PROJECT_ID;
