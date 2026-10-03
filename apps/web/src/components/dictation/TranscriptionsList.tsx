import type { DictationJob, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { dictationEnvironment, useDictationJobs } from "~/state/dictation";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { MaterialDictationModeIcon } from "~/symmetria/MaterialDictationModeIcon";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** The server forgets jobs after this long; the list never shows older ones. */
const TRANSCRIPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The open request: `null` while closed, otherwise the environment the opener
 * is in (`null` when it has none). Set by the command palette, which closes the
 * moment its action runs, so the dialog lives in a host the palette always mounts.
 */
const transcriptionsListRequestAtom = Atom.make<{
  readonly environmentId: EnvironmentId | null;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("dictation:transcriptions-list-request"));

export function openTranscriptionsList(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(transcriptionsListRequestAtom, { environmentId });
}

export function closeTranscriptionsList(): void {
  appAtomRegistry.set(transcriptionsListRequestAtom, null);
}

export type TranscriptionsEnvironment =
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId }
  | {
      readonly kind: "choose";
      readonly options: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly label: string;
      }>;
    }
  | { readonly kind: "none" };

/**
 * Whose jobs the list shows: the opener's environment, else the primary one,
 * else the only connected one. Several connected environments and no context
 * (the hosted app outside a thread) leave the choice to the user.
 */
export function resolveTranscriptionsEnvironment(input: {
  readonly requested: EnvironmentId | null;
  readonly primary: EnvironmentId | null;
  readonly connected: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}): TranscriptionsEnvironment {
  const contextual = input.requested ?? input.primary;
  if (contextual !== null) return { kind: "environment", environmentId: contextual };
  const [only, ...rest] = input.connected;
  if (only === undefined) return { kind: "none" };
  if (rest.length === 0) return { kind: "environment", environmentId: only.environmentId };
  return { kind: "choose", options: input.connected };
}

/** Finished jobs (completed or failed) from the last 24 hours, in the atom's newest-first order. */
function recentFinishedJobs(jobs: ReadonlyArray<DictationJob>, now: number) {
  return jobs.filter(
    (job) =>
      job.status !== "transcribing" && now - Date.parse(job.createdAt) < TRANSCRIPTION_WINDOW_MS,
  );
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

function TranscriptionRow({
  job,
  onRetry,
}: {
  readonly job: DictationJob;
  readonly onRetry: (job: DictationJob) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "transcription" });
  const text = job.text ?? "";
  return (
    <li className="flex items-center gap-3 py-2">
      <MaterialDictationModeIcon
        mode={job.mode}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {job.status === "failed"
            ? `Failed: ${job.failure ?? "the transcription did not finish"}`
            : firstLine(text)}
        </p>
        <p className="text-xs text-muted-foreground">{formatRelativeTimeLabel(job.createdAt)}</p>
      </div>
      {text.length > 0 ? (
        <Button size="xs" variant="outline" onClick={() => copyToClipboard(text)}>
          {isCopied ? "Copied" : "Copy"}
        </Button>
      ) : null}
      {job.status === "failed" ? (
        <Button size="xs" variant="outline" onClick={() => onRetry(job)}>
          Retry
        </Button>
      ) : null}
    </li>
  );
}

export function TranscriptionsList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { jobs, loaded } = useDictationJobs(environmentId);
  const retry = useAtomCommand(dictationEnvironment.retry);
  // The dialog mounts on every open, so the window is measured from the moment it opened.
  const [openedAt] = useState(() => Date.now());
  const visibleJobs = useMemo(() => recentFinishedJobs(jobs, openedAt), [jobs, openedAt]);
  if (loaded && visibleJobs.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No transcriptions in the last 24 hours.
      </p>
    );
  }
  return (
    <ul data-testid="transcriptions-list" className="divide-y divide-border/60">
      {visibleJobs.map((job) => (
        <TranscriptionRow
          key={job.id}
          job={job}
          onRetry={(failed) => void retry({ environmentId, input: { jobId: failed.id } })}
        />
      ))}
    </ul>
  );
}

/** Mounted once beside the command palette; shows the requested environment's transcriptions. */
export function TranscriptionsListHost() {
  const request = useAtomValue(transcriptionsListRequestAtom);
  if (request === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeTranscriptionsList();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Transcriptions</DialogTitle>
          <DialogDescription>Dictation from the last 24 hours.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <TranscriptionsForEnvironment requested={request.environmentId} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function TranscriptionsForEnvironment({ requested }: { readonly requested: EnvironmentId | null }) {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const connected = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map(({ environmentId, label }) => ({ environmentId, label })),
    [environments],
  );
  const target = resolveTranscriptionsEnvironment({
    requested: requested ?? chosen,
    primary,
    connected,
  });
  if (target.kind === "environment") {
    return <TranscriptionsList environmentId={target.environmentId} />;
  }
  if (target.kind === "none") {
    return <p className="text-sm text-muted-foreground">Connect an environment to see them.</p>;
  }
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">Choose the environment to show.</p>
      <div className="flex flex-wrap gap-2">
        {target.options.map((option) => (
          <Button
            key={option.environmentId}
            size="xs"
            variant="outline"
            onClick={() => setChosen(option.environmentId)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
