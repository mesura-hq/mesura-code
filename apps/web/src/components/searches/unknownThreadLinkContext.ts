import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, type ReactNode } from "react";

/**
 * Mesura: renders a thread link whose thread this client does not hold. The agent search
 * popup sets it so an archived result is a route link `ArchivedResultLinks` can unarchive;
 * everywhere else such a link stays upstream's unavailable chip.
 */
export const UnknownThreadLinkContext = createContext<
  ((thread: ScopedThreadRef, label: string) => ReactNode) | null
>(null);
