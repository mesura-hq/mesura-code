import type { TransferOutcome } from "./mutate.ts";

/**
 * The file operations, as one surface — the TYPE only.
 *
 * Split from `index.ts` so a host can name the surface without importing the
 * Electron-backed implementation: `register.ts` takes an `Operations` from its
 * dependencies, and a server with no Electron must be able to type-check that
 * import. The implementation stays in `index.ts`.
 */

export interface TransferArguments {
  readonly sources: readonly string[];
  readonly destination: string;
  readonly mode: "copy" | "move";
  readonly overwrite: boolean;
  readonly transferId: string;
}

export interface Operations {
  transfer(
    args: TransferArguments,
    onProgress: (done: number, total: number) => void,
  ): Promise<TransferOutcome>;
  cancelTransfer(transferId: string): void;
  create(path: string, kind: "file" | "directory"): Promise<void>;
  rename(path: string, name: string): Promise<string>;
  trash(paths: readonly string[]): Promise<number>;
  open(path: string): Promise<"terminal" | "desktop">;
}
