/**
 * Lets the chat buffer cite its visual selection through the existing cite
 * pipeline in `AssistantSelectionToolbar`, which holds the thread ref and the
 * composer callback. The visual selection is the native selection; the
 * toolbar captures it and reports whether the composer took the citation.
 */

export interface ChatCiteRequest {
  cited: boolean;
}

const EVENT_NAME = "mesura:chat-cite-selection";

/** Dispatches synchronously, so the result is known on return. */
export function requestChatCite(): boolean {
  const request: ChatCiteRequest = { cited: false };
  window.dispatchEvent(new CustomEvent<ChatCiteRequest>(EVENT_NAME, { detail: request }));
  return request.cited;
}

export function subscribeChatCiteRequest(listener: (request: ChatCiteRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ChatCiteRequest>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
