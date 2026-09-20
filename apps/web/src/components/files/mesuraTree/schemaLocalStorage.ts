import type * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

/**
 * Local storage behind a schema, for state that must never throw at the
 * caller: a missing, corrupt or over-quota storage reads as `null` and writes
 * as `false`, each logged once with the caller's label.
 */
export function createSchemaLocalStorage<T, E>(schema: Schema.Codec<T, E>, label: string) {
  return {
    read(key: string): T | null {
      try {
        return getLocalStorageItem(key, schema);
      } catch (error) {
        console.error(`[${label}] Could not read ${key} from local storage.`, error);
        return null;
      }
    },
    write(key: string, value: T): boolean {
      try {
        setLocalStorageItem(key, value, schema);
        return true;
      } catch (error) {
        console.error(`[${label}] Could not write ${key} to local storage.`, error);
        return false;
      }
    },
  };
}
