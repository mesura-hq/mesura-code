import { useSyncExternalStore } from "react";

function readTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function subscribe(listener: () => void) {
  // Intl has no zone-change event. Focus and visibility checks avoid a polling timer.
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}

export function useDeviceTimeZone() {
  // Read on render too: a reconnect can happen after travel without a focus event.
  return useSyncExternalStore(subscribe, readTimeZone, readTimeZone);
}
