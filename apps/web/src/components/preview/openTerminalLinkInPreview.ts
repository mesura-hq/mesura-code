import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import {
  openThreadLinkInPreview,
  type AllocateThreadLink,
} from "~/browser/openThreadLinkInPreview";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";

const terminalLinkErrorContext = {
  environmentId: Schema.String,
  threadId: Schema.String,
  targetOrigin: Schema.String,
  cause: Schema.Defect(),
};

export class TerminalLinkPreviewOpenError extends Schema.TaggedError<TerminalLinkPreviewOpenError>()(
  "TerminalLinkPreviewOpenError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    return `Failed to open terminal link ${this.targetOrigin} in preview for thread ${this.threadId}.`;
  }
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
  readonly allocate: AllocateThreadLink<E>;
  readonly ownerSignal?: AbortSignal;
  readonly fallbackToBrowser: () => void;
  readonly forceBrowser: boolean;
}

export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  const result = await openThreadLinkInPreview({
    threadRef: input.threadRef,
    url: input.url,
    allocate: input.allocate,
    event: { metaKey: input.forceBrowser, ctrlKey: false },
    ...(input.ownerSignal === undefined ? {} : { ownerSignal: input.ownerSignal }),
  });
  if (result._tag === "System") {
    input.fallbackToBrowser();
    return;
  }
  const errorContext = {
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    targetOrigin: new URL(input.url).origin,
  };
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const error = squashAtomCommandFailure(result);
    if (error instanceof BrowserSettingsReadError) throw error.cause;
    console.error(
      new TerminalLinkPreviewOpenError({
        ...errorContext,
        cause: result.cause,
      }),
    );
    input.fallbackToBrowser();
    return;
  }
}
