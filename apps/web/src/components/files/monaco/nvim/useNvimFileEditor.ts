import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EditorTextEdit, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type * as monaco from "monaco-editor";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { resolveShortcutCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  editorKeyLane,
  editorKeysDeliveryAtom,
  editorSessionAttach,
  editorSessionOpen,
  editorSessionReplaceText,
  editorSessionSetCursor,
  editorSessionViewport,
  EMPTY_EDITOR_SESSION_STATE,
  type EditorKeysDelivery,
  type EditorSessionState,
} from "~/state/editorSession";
import { fallbackFromCause, isSessionMissing, type NvimFallback } from "./nvimFallback.ts";
import { decideSessionRecovery } from "./nvimSessionRecovery.ts";
import type { NvimViewport } from "./nvimViewport.ts";
import { useNvimDriver, type NvimDriverResult } from "./useNvimDriver.ts";
import { APP_SHORTCUTS_THAT_OUTRANK_NEOVIM } from "./appShortcutsThatOutrankNeovim";

/**
 * Binds the thread's editor session to a Monaco editor. The wire lives here and Monaco lives in
 * `useNvimDriver`, so the driver's key race, undo stack and composition read without an atom
 * runtime in the way.
 */

const IDLE_SESSION_ATOM = Atom.make(AsyncResult.initial<EditorSessionState, never>(false)).pipe(
  Atom.withLabel("editor-session:idle"),
);

export interface NvimFileEditorResult extends NvimDriverResult {
  /** Why Neovim is not running, when the developer asked for it and it is not. */
  readonly fallback: NvimFallback | null;
  /** Tries again, after the setting that broke it has been fixed. */
  readonly retry: () => void;
  /** Whether typed keys are reaching Neovim; see `editorKeyLane`. */
  readonly keysDelivery: EditorKeysDelivery;
  /**
   * Whether an Escape typed now is Neovim's rather than the panel's. The panel takes it only when
   * both the last batch's answer (`restsInNormalMode`) and the attach stream show plain normal
   * mode: the stream alone lags a round trip, so `A x Escape` on a remote host left Neovim in insert.
   */
  readonly escapeGoesToNeovim: () => boolean;
}

export interface NvimFileEditorInput {
  readonly editor: monaco.editor.IStandaloneCodeEditor | null;
  readonly model: monaco.editor.ITextModel | null;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly enabled: boolean;
  /** The surface's own "this edit is not the developer typing" flag. */
  readonly externalEdits: {
    readonly isApplying: () => boolean;
    readonly run: (body: () => void) => void;
  };
  /** Writes the pending save now, which is what `:w` means. */
  readonly flushSave: () => void;
}

export function useNvimFileEditor(input: NvimFileEditorInput): NvimFileEditorResult {
  const { editor, model, environmentId, threadRef, cwd, relativePath } = input;
  const threadId = threadRef.threadId;

  /**
   * Why Neovim is not running. Held here, not in the driver, because it decides whether the
   * driver runs at all: a session that could not start leaves the plain editor.
   */
  const [fallback, setFallback] = useState<NvimFallback | null>(null);
  /**
   * Raised to make the driver open the file again (Retry, or a lost session). REGRESSION: Retry
   * first smuggled this into `openFile`'s `useCallback` list, but the React Compiler drops a
   * dependency the body never reads, so nothing reopened. Keep it a value the open effect reads.
   */
  const [openGeneration, setOpenGeneration] = useState(0);
  const enabled = input.enabled && fallback === null;

  // Not subscribed at all while modal editing is off, so a developer who does
  // not use it never starts a Neovim.
  const atom = useMemo(
    () =>
      enabled ? editorSessionAttach({ environmentId, input: { threadId } }) : IDLE_SESSION_ATOM,
    [enabled, environmentId, threadId],
  );
  const result = useAtomValue(atom);
  const state = sessionStateOf(result);

  // Recovering a session that is gone: see `nvimSessionRecovery.ts` for what
  // is decided, and why in that order. What follows is the bookkeeping.
  const refreshAttach = useAtomRefresh(atom);
  // A ref, so a new refresh function never makes `openFile` a new callback:
  // the driver opens the file again whenever that identity changes.
  const refreshAttachRef = useRef(refreshAttach);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-ref, so a new refresh function never gives `openFile` a new identity
  useEffect(() => {
    refreshAttachRef.current = refreshAttach;
  }, [refreshAttach]);
  /** Attach again once the next open lands. Taken by whichever open lands first. */
  const reattachPendingRef = useRef(false);
  const opensInFlightRef = useRef(0);
  const reopensInARowRef = useRef(0);
  const mountedRef = useRef(true);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: tracks mount so async open results never touch an unmounted editor
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Nothing opens while the driver is off, so a pending reattach would wait
  // for an open that is not coming.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: drops a pending reattach when the driver turns off, since no open will land
  useEffect(() => {
    if (!enabled) reattachPendingRef.current = false;
  }, [enabled]);

  // Judged on the settled failure, not the one a refresh leaves behind while
  // it waits: that one is the old stream's, and it flips back and forth, which
  // is what lets a second identical failure be noticed at all.
  const attachFoundNoSession =
    enabled && AsyncResult.isFailure(result) && !result.waiting && isSessionMissing(result.cause);
  const ended = enabled ? state.ended : null;

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: reacts to the attach stream's ended/missing state, which no handler owns
  useEffect(() => {
    const action = decideSessionRecovery({
      ended,
      attachFoundNoSession,
      reattachPending: reattachPendingRef.current,
      openInFlight: opensInFlightRef.current > 0,
      reopensInARow: reopensInARowRef.current,
    });
    switch (action.kind) {
      case "none":
        return;
      case "reattach":
        refreshAttachRef.current();
        return;
      case "reattach-after-open":
        reattachPendingRef.current = true;
        return;
      case "reopen":
        reopensInARowRef.current += 1;
        reattachPendingRef.current = true;
        setOpenGeneration((generation) => generation + 1);
        return;
      case "fallback":
        setFallback(action.fallback);
        return;
    }
  }, [ended, attachFoundNoSession]);

  // A session that answers resets the count: the next loss is a new one.
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: resets the reopen count when the external session answers with a snapshot
  useEffect(() => {
    if (state.latestEvent?.type === "snapshot") reopensInARowRef.current = 0;
  }, [state.latestEvent]);

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isAppShortcut = useCallback(
    (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: false },
      });
      return command !== null && APP_SHORTCUTS_THAT_OUTRANK_NEOVIM.has(command);
    },
    [keybindings],
  );

  const openCommand = useAtomCommand(editorSessionOpen, "editor session open");
  // Keys, clicks and an agent's edits share one lane per thread: see
  // `editorKeyLane` for the coalescing and the re-sends.
  const registry = useContext(RegistryContext);
  // The driver applies text and caret from here, as each event arrives.
  const stateSource = useMemo(
    () => ({
      get: () => sessionStateOf(registry.get(atom)),
      subscribe: (listener: (state: EditorSessionState) => void) =>
        registry.subscribe(atom, (next) => listener(sessionStateOf(next))),
    }),
    [registry, atom],
  );
  const keyLane = useMemo(
    () => editorKeyLane(registry, { environmentId, threadId }),
    [registry, environmentId, threadId],
  );
  const keysDelivery = useAtomValue(editorKeysDeliveryAtom({ environmentId, threadId }));
  const setCursorCommand = useAtomCommand(editorSessionSetCursor, "editor session set cursor");
  const viewportCommand = useAtomCommand(editorSessionViewport, "editor session viewport");
  const replaceTextCommand = useAtomCommand(
    editorSessionReplaceText,
    "editor session replace text",
  );

  const openFile = useCallback(
    (lines: ReadonlyArray<string>) => {
      opensInFlightRef.current += 1;
      const openMark = keyLane.openBegins();
      return openCommand({
        environmentId,
        input: { threadId, cwd, relativePath, lines: [...lines] },
      }).then((result) => {
        opensInFlightRef.current -= 1;
        // The lane belongs to the thread, not this view, so the answer is
        // taken even if the view went away meanwhile.
        if (result._tag === "Success") keyLane.takeOpenAnswer(openMark, result.value.escape);
        if (!mountedRef.current) return null;
        // After the open, not alongside it: an attachment that reaches the
        // server first finds no session and fails again. Refreshed whether or
        // not the open worked — one that failed leaves an attach that fails
        // again, and that is what counts it against the reopen limit.
        if (reattachPendingRef.current) {
          reattachPendingRef.current = false;
          refreshAttachRef.current();
        }
        if (result._tag === "Success") return result.value.lines;
        if (result._tag === "Failure") {
          const failure = fallbackFromCause(result.cause);
          if (failure !== null) setFallback(failure);
        }
        return null;
      });
    },
    [openCommand, keyLane, environmentId, threadId, cwd, relativePath],
  );

  const retry = useCallback(() => {
    reopensInARowRef.current = 0;
    reattachPendingRef.current = true;
    setFallback(null);
    setOpenGeneration((generation) => generation + 1);
  }, []);

  const sendKeys = useCallback((keys: string) => keyLane.keys(keys), [keyLane]);

  const setCursor = useCallback(
    (line: number, col: number) => {
      keyLane.call(() => setCursorCommand({ environmentId, input: { threadId, line, col } }));
    },
    [keyLane, setCursorCommand, environmentId, threadId],
  );

  const sendViewport = useCallback(
    (viewport: NvimViewport) => {
      void viewportCommand({
        environmentId,
        input: {
          threadId,
          topline: viewport.topline,
          rows: viewport.rows,
          cols: viewport.cols,
          ...(viewport.source === undefined ? {} : { source: viewport.source }),
        },
      });
    },
    [viewportCommand, environmentId, threadId],
  );

  const replaceText = useCallback(
    (edits: ReadonlyArray<EditorTextEdit>) => {
      keyLane.call(() =>
        replaceTextCommand({ environmentId, input: { threadId, edits: [...edits] } }),
      );
    },
    [keyLane, replaceTextCommand, environmentId, threadId],
  );

  const driverState = useMemo(
    () => ({
      relativePath: state.relativePath,
      lines: state.lines,
      cursor: state.cursor,
      mode: state.mode,
      jumping: state.jumping,
      topline: state.topline,
      cmdline: state.cmdline,
      message: state.message,
      decorations: state.decorations,
      hlDefs: state.hlDefs,
      visual: state.visual,
      writeRequests: state.writeRequests,
      latestEvent: state.latestEvent,
      sequence: state.sequence,
      snapshots: state.snapshots,
      snapshotLines: state.snapshotLines,
    }),
    [state],
  );

  const driver = useNvimDriver({
    editor,
    model,
    environmentId,
    threadRef,
    cwd,
    relativePath,
    enabled,
    sendKeys,
    openFile,
    openGeneration,
    setCursor,
    sendViewport,
    flushSave: input.flushSave,
    externalEdits: input.externalEdits,
    replaceText,
    isAppShortcut,
    state: driverState,
    stateSource,
  });

  const escapeGoesToNeovim = useCallback(
    () => !keyLane.restsInNormalMode() || driver.mode !== "n" || driver.jumping,
    [keyLane, driver.mode, driver.jumping],
  );

  return { ...driver, fallback, retry, keysDelivery, escapeGoesToNeovim };
}

function sessionStateOf(
  result: AsyncResult.AsyncResult<EditorSessionState, unknown>,
): EditorSessionState {
  return Option.getOrNull(AsyncResult.value(result)) ?? EMPTY_EDITOR_SESSION_STATE;
}
