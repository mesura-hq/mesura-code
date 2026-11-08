/**
 * Coalesces storage writes behind a short delay. The file manager reports view state on
 * every cursor move and scroll frame as if writes were free; here each is a synchronous
 * local-storage call, so only the burst's last value is written, or at once on page hide.
 */
export function createWriteCoalescer(write: () => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    write();
  };
  return {
    schedule() {
      if (timer === null) timer = setTimeout(flush, wait);
    },
    flush,
  };
}

/** Flushes the coalescer when the page hides, for the page's lifetime. */
export function flushOnPageHide(coalescer: { flush(): void }): void {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", () => coalescer.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") coalescer.flush();
  });
}
