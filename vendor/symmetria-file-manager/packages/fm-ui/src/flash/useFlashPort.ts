import { useCallback, useRef, useState } from "react";
export interface FlashPort {
  connect(handler: (event: KeyboardEvent) => boolean): () => void;
  setActive(active: boolean): void;
}
export function useFlashPort() {
  const [active, setActive] = useState(false);
  const handler = useRef<(event: KeyboardEvent) => boolean>(() => true);
  const connect = useCallback((next: (event: KeyboardEvent) => boolean) => {
    handler.current = next;
    return () => {
      if (handler.current === next) handler.current = () => true;
    };
  }, []);
  return {
    active,
    onKey: (event: KeyboardEvent) => handler.current(event),
    port: { connect, setActive },
  };
}
