import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { subscribe, type EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import { applyEditorSessionEvent, EMPTY_EDITOR_SESSION_STATE } from "./editorSessionFold.ts";

/**
 * The thread's embedded Neovim, as the web client sees it.
 *
 * Web-local rather than in the shared client package, for the same reason
 * `projectFileWatch` is: mobile has no Monaco, so a family defined in the
 * shared package would offer a client an editor it cannot draw.
 */

export {
  applyEditorSessionEvent,
  applyLinesEvent,
  EMPTY_EDITOR_SESSION_STATE,
  type EditorSessionState,
} from "./editorSessionFold.ts";

const editorThreadKey = ({
  environmentId,
  input,
}: {
  readonly environmentId: string;
  readonly input: { readonly threadId: string };
}) => JSON.stringify([environmentId, input.threadId]);

const keyScheduler = createAtomCommandScheduler();
const lifecycleScheduler = createAtomCommandScheduler();

/**
 * Keys go one at a time, in order, per thread.
 *
 * Not an optimisation — a correctness requirement. `d` and `w` are one command
 * and two messages; delivered out of order they are two commands, and the
 * second is a motion that moves the cursor rather than the operator's target.
 */
const serialPerThread = { mode: "serial" as const, key: editorThreadKey };

export const editorSessionAttach = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editor-session:attach",
  subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.editorSessionAttach>) =>
    subscribe(WS_METHODS.editorSessionAttach, input).pipe(
      Stream.scan(EMPTY_EDITOR_SESSION_STATE, applyEditorSessionEvent),
    ),
  // Long enough to survive the panel's per-file remount, short enough that a
  // closed file does not hold a Neovim's attention for minutes. The default of
  // five minutes would do exactly that.
  idleTtlMs: 5_000,
});

export const editorSessionOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:open",
  tag: WS_METHODS.editorSessionOpen,
  scheduler: lifecycleScheduler,
  concurrency: serialPerThread,
});

export const editorSessionInput = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:input",
  tag: WS_METHODS.editorSessionInput,
  scheduler: keyScheduler,
  concurrency: serialPerThread,
});

export const editorSessionViewport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:viewport",
  tag: WS_METHODS.editorSessionViewport,
  // Only the latest matters: a scroll that has been superseded is a frame
  // nobody will ever see.
  concurrency: { mode: "latest", key: editorThreadKey },
});

export const editorSessionSetCursor = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:set-cursor",
  tag: WS_METHODS.editorSessionSetCursor,
  scheduler: keyScheduler,
  concurrency: serialPerThread,
});

export const editorSessionReplaceText = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:replace-text",
  tag: WS_METHODS.editorSessionReplaceText,
  scheduler: keyScheduler,
  concurrency: serialPerThread,
});

export const editorSessionClose = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:close",
  tag: WS_METHODS.editorSessionClose,
  scheduler: lifecycleScheduler,
  concurrency: serialPerThread,
});
