import { useEffect, useRef } from "react";

import { onOpenPath } from "./bridge.ts";

/**
 * A directory another program asked this one to show.
 *
 * The origin is outside both processes — the command-line tool, a desktop
 * entry, and later a portal request — so this is a push the interface receives
 * rather than an answer to anything it asked.
 *
 * **Subscribed exactly once, whatever identity the handler has.** The action it
 * calls is a fresh arrow on every render, like every other action the tab hook
 * returns, so an effect depending on it directly would re-subscribe on every
 * cursor move — and the preload's `listen` removes and re-adds a native IPC
 * listener on each subscribe, which is real churn on the hot render path.
 * Review traced it. The ref is written in an effect rather than during render,
 * for the reason `useTabs` records on `optionsRef`: React does not promise a
 * render it began is a render it keeps.
 *
 * Its own module rather than three hooks inline in the component, and the
 * reason is measured rather than aesthetic: inline, they took the component
 * past this project's hook-density bound. One call site costs one.
 */
export function useExternalOpen(openAt: (path: string) => void): void {
  const latest = useRef(openAt);

  useEffect(() => {
    latest.current = openAt;
  });

  useEffect(() => onOpenPath((path) => latest.current(path)), []);
}
