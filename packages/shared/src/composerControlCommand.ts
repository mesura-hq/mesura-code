export type ComposerControlCommand = "compact-context";

export interface NativeComposerControlCommandItem {
  readonly command: "compact";
  readonly label: "/compact";
  readonly description: "Compact this chat's context";
}

export function buildNativeComposerControlCommands(input: {
  readonly nativeContextCompaction: boolean | undefined;
  readonly hasExistingSession: boolean;
}): ReadonlyArray<NativeComposerControlCommandItem> {
  return input.nativeContextCompaction === true && input.hasExistingSession
    ? [
        {
          command: "compact",
          label: "/compact",
          description: "Compact this chat's context",
        },
      ]
    : [];
}

export function classifyComposerControlSubmission(input: {
  readonly text: string;
  readonly attachmentCount: number;
  readonly hasSupplementalContext: boolean;
}): ComposerControlCommand | null {
  return input.text.trim() === "/compact" &&
    input.attachmentCount === 0 &&
    !input.hasSupplementalContext
    ? "compact-context"
    : null;
}
