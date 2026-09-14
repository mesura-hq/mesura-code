import {
  computeFlash,
  type FlashResult,
  type FlashTransition,
  flashTransition,
} from "@symmetria/fm-core/flash";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FlashSceneAdapter } from "../overview/flashTargets.ts";
import { type FlashScene, positionFlashLabels, readFlashScene } from "../overview/flashTargets.ts";
import { measureFlashMatches } from "../overview/flashTextGeometry.ts";
import type { FlashPort } from "./useFlashPort.ts";

interface FlashSession {
  readonly scene: FlashScene;
  readonly generation: string;
  readonly query: string;
  readonly prefix: string;
}
export interface FlashOptions {
  readonly viewport: RefObject<HTMLDivElement | null>;
  readonly generation: string;
  readonly port: { flash?: FlashPort | undefined } | undefined;
  readonly adapter?: FlashSceneAdapter;
  readonly stopCamera: () => void;
  readonly select: (path: string) => void;
}
const EMPTY_TARGETS: readonly never[] = [];

export function useViewportFlash(options: FlashOptions) {
  const { viewport, generation, port } = options;
  const [session, setSession] = useState<FlashSession | null>(null);
  const cancel = useCallback(() => setSession(null), []);
  const scene = session?.scene;
  const query = session?.query ?? "";
  const result = useMemo(
    () => computeFlash(query, scene?.targets ?? EMPTY_TARGETS),
    [query, scene],
  );
  const queries = useMemo(
    () => (scene ? measureFlashMatches(scene, result.matches, query) : []),
    [scene, result, query],
  );
  const labels = useMemo(
    () => (scene ? positionFlashLabels(scene, result.matches, queries) : []),
    [scene, result, queries],
  );
  const resolved = resolveVisibleLabels(result, labels !== null);
  const latest = useRef({ options, session, resolved });
  latest.current = { options, session, resolved };
  const onKey = useCallback(
    (event: KeyboardEvent) => handleFlashKey(event, latest.current, cancel, setSession),
    [cancel],
  );
  useFlashRegistration(port?.flash, session !== null, onKey);
  useFlashInvalidation(options, session, generation, cancel);
  return {
    active: session !== null,
    query: session?.query ?? "",
    prefix: session?.prefix ?? "",
    count: result.matches.length,
    empty: session?.scene.targets.length === 0,
    needsRefinement: resolved.needsRefinement,
    labels: labels ?? [],
    queries,
    matches: useMemo(() => new Set(result.matches.map((match) => match.path)), [result]),
    cancel,
    open: () => {
      options.stopCamera();
      const node = viewport.current;
      if (!node) return;
      focusFlash(options);
      setSession({
        scene: readFlashScene(node, options.adapter),
        generation,
        query: "",
        prefix: "",
      });
    },
  };
}

interface FlashCurrent {
  readonly options: FlashOptions;
  readonly session: FlashSession | null;
  readonly resolved: FlashResult;
}
function sceneIsCurrent(
  session: FlashSession,
  generation: string,
  node: HTMLElement | null,
  adapter?: FlashSceneAdapter,
) {
  return (
    node !== null &&
    session.generation === generation &&
    readFlashScene(node, adapter).token === session.scene.token
  );
}
function handleFlashKey(
  event: KeyboardEvent,
  current: FlashCurrent,
  cancel: () => void,
  update: (session: FlashSession) => void,
): boolean {
  const { session, options, resolved } = current;
  if (!session) return true;
  if (!sceneIsCurrent(session, options.generation, options.viewport.current, options.adapter)) {
    cancel();
    return true;
  }
  if (event.isComposing) {
    cancel();
    return true;
  }
  if (event.repeat || MODIFIER_KEYS.has(event.key)) return true;
  if (isShortcut(event)) {
    cancel();
    return false;
  }
  const transition = flashTransition(session.query, session.prefix, event.key, resolved);
  applyTransition(transition, session, options, cancel, update);
  return true;
}
function applyTransition(
  transition: FlashTransition,
  session: FlashSession,
  options: FlashOptions,
  cancel: () => void,
  update: (session: FlashSession) => void,
) {
  switch (transition.kind) {
    case "cancel":
      cancel();
      break;
    case "query":
      update({ ...session, query: transition.query, prefix: "" });
      break;
    case "prefix":
      update({ ...session, prefix: transition.prefix });
      break;
    case "select": {
      cancel();
      options.select(transition.path);
      focusFlash(options);
      break;
    }
  }
}
const MODIFIER_KEYS = new Set(["Control", "Alt", "Meta", "Shift", "AltGraph"]);
function isShortcut(event: KeyboardEvent) {
  return !event.getModifierState("AltGraph") && (event.ctrlKey || event.metaKey || event.altKey);
}
function useFlashRegistration(
  port: FlashPort | undefined,
  active: boolean,
  onKey: (event: KeyboardEvent) => boolean,
) {
  const connect = port?.connect;
  const reportActive = port?.setActive;
  useEffect(() => connect?.(onKey), [connect, onKey]);
  useLayoutEffect(() => {
    reportActive?.(active);
  }, [reportActive, active]);
  useEffect(() => () => reportActive?.(false), [reportActive]);
}
function useFlashInvalidation(
  options: FlashOptions,
  session: FlashSession | null,
  generation: string,
  cancel: () => void,
) {
  const { viewport, adapter } = options;
  useLayoutEffect(() => {
    if (session && !sceneIsCurrent(session, generation, viewport.current, adapter)) cancel();
  });
  const active = session !== null;
  useEffect(() => {
    if (!active) return;
    const outside = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !(
          viewport.current &&
          (
            adapter?.owner(viewport.current) ?? viewport.current.closest('[role="dialog"]')
          )?.contains(event.target)
        )
      )
        cancel();
    };
    const node = viewport.current;
    node?.addEventListener("scroll", cancel);
    node?.addEventListener("wheel", cancel);
    node?.addEventListener("compositionstart", cancel);
    window.addEventListener("resize", cancel);
    document.addEventListener("focusin", outside);
    document.addEventListener("pointerdown", cancel, true);
    return () => {
      node?.removeEventListener("scroll", cancel);
      node?.removeEventListener("wheel", cancel);
      node?.removeEventListener("compositionstart", cancel);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("pointerdown", cancel, true);
    };
  }, [active, viewport, adapter, cancel]);
}

function resolveVisibleLabels(result: FlashResult, visible: boolean): FlashResult {
  return visible
    ? result
    : {
        ...result,
        needsRefinement: true,
        matches: result.matches.map((match) => ({ ...match, label: "" })),
      };
}

function focusFlash(options: FlashOptions) {
  const node = options.viewport.current;
  if (!node) return;
  const target =
    options.adapter?.focus?.(node) ??
    options.adapter?.owner(node) ??
    node.closest<HTMLElement>('[role="dialog"]');
  target?.focus({ preventScroll: true });
}
