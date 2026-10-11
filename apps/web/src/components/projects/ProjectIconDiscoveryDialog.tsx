import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type ProjectIconDiscoveryPreview,
  type ProjectIconDiscoveryState,
  type ProjectIconDiscoveryStatus,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { newCommandId } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { projectIconDiscoverCommand, projectIconPreviewCommand } from "../../state/projectIcons";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

interface DiscoveryTarget {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  title?: string;
}
const dialogAtom = Atom.make<DiscoveryTarget | null>(null).pipe(Atom.keepAlive);

export function openProjectIconDiscoveryDialog(target: DiscoveryTarget): void {
  appAtomRegistry.set(dialogAtom, target);
}

export function closeProjectIconDiscoveryDialog(): void {
  appAtomRegistry.set(dialogAtom, null);
}

export function ProjectIconDiscoveryDialogHost() {
  const target = useAtomValue(dialogAtom);
  return target ? (
    <ProjectIconDiscoveryDialog
      key={`${target.environmentId}:${target.projectId ?? "batch"}`}
      target={target}
    />
  ) : null;
}

const TERMINAL_STATUSES: ReadonlySet<ProjectIconDiscoveryStatus> = new Set([
  "selected",
  "none",
  "existing",
  "empty",
  "superseded",
  "failed",
  "interrupted",
  "unavailable",
]);

const OUTCOME_LABELS: Record<ProjectIconDiscoveryStatus, string> = {
  pending: "Waiting",
  running: "Checking",
  selected: "Saved",
  none: "No match",
  existing: "Skipped",
  empty: "Skipped",
  superseded: "Changed during the search",
  failed: "Failed",
  interrupted: "Interrupted",
  unavailable: "Unavailable",
};

interface AcceptedJob {
  readonly jobToken: CommandId;
  readonly generation: number;
}

type JobOutcome = Pick<ProjectIconDiscoveryState, "status" | "path" | "reason">;

const SUPERSEDED_REASON = "A newer search or icon change replaced this search.";

/**
 * The terminal outcome of the accepted job, or null while it runs. A newer
 * generation under another token means the job was replaced, possibly after a
 * terminal update this client never saw; the newer job's result is not its own.
 */
function outcomeForJob(
  job: AcceptedJob,
  project: { readonly iconDiscovery?: ProjectIconDiscoveryState | null | undefined } | undefined,
): JobOutcome | null {
  if (project === undefined) {
    return { status: "failed", path: null, reason: "The project was removed." };
  }
  const state = project.iconDiscovery ?? null;
  if (state === null) return null;
  if (state.jobToken === job.jobToken) return TERMINAL_STATUSES.has(state.status) ? state : null;
  return state.generation > job.generation
    ? { status: "superseded", path: null, reason: SUPERSEDED_REASON }
    : null;
}

/**
 * Runs the confirmed projects one at a time. The dialog submits a project, waits
 * for that job's outcome to arrive on the project itself (matched by job token),
 * and only then submits the next one. The unstarted projects live only here, so
 * Stop, closing the client or losing the connection leaves them unstarted.
 */
function ProjectIconDiscoveryDialog({ target }: { target: DiscoveryTarget }) {
  const environment = useEnvironment(target.environmentId);
  const projects = useProjects();
  const preview = useAtomCommand(projectIconPreviewCommand, { reportFailure: false });
  const discover = useAtomCommand(projectIconDiscoverCommand, { reportFailure: false });
  const [previews, setPreviews] = useState<ReadonlyArray<ProjectIconDiscoveryPreview> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"preview" | "running" | "finished">("preview");
  const [confirmed, setConfirmed] = useState<ReadonlyArray<ProjectId>>([]);
  // Submitted projects in order, each with its accepted job once the server answers.
  const [jobs, setJobs] = useState<ReadonlyMap<ProjectId, AcceptedJob | null>>(() => new Map());
  // Outcomes are kept once seen: the project's state moves on with later searches.
  const [outcomes, setOutcomes] = useState<ReadonlyMap<ProjectId, JobOutcome>>(() => new Map());
  const [stopping, setStopping] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const stopRequested = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void preview({
      environmentId: target.environmentId,
      input: target.projectId ? { projectIds: [target.projectId] } : {},
    }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setPreviews(result.value);
      else setError(failureMessage(result, "Could not inspect the projects."));
    });
    return () => {
      cancelled = true;
    };
  }, [preview, target]);

  const submit = useCallback(
    async (projectId: ProjectId) => {
      setJobs((previous) => new Map(previous).set(projectId, null));
      const result = await discover({
        environmentId: target.environmentId,
        input: { projectId, requestId: newCommandId() },
      });
      if (!alive.current) return;
      if (result._tag === "Success") {
        const { jobToken, generation } = result.value;
        setJobs((previous) => new Map(previous).set(projectId, { jobToken, generation }));
        return;
      }
      setError(failureMessage(result, "The search could not start."));
      setPhase("finished");
    },
    [discover, target.environmentId],
  );

  const environmentProjects = new Map(
    projects
      .filter((project) => project.environmentId === target.environmentId)
      .map((project) => [project.id, project]),
  );
  const currentProjectId = phase === "running" ? [...jobs.keys()].at(-1) : undefined;
  const currentJob = currentProjectId === undefined ? null : (jobs.get(currentProjectId) ?? null);
  const currentOutcome =
    currentProjectId === undefined || currentJob === null
      ? null
      : outcomeForJob(currentJob, environmentProjects.get(currentProjectId));

  // Losing the selected environment's connection ends the batch for good: the
  // started job stays visible, but a reconnect never submits the rest.
  const connected = environment?.connection.phase === "connected";
  // Recorded while rendering, React's pattern for state that follows a prop,
  // so the advance below already sees it in the same commit.
  if (phase === "running" && !connected && !connectionLost) setConnectionLost(true);

  const advanceAfter = useCallback(
    (projectId: ProjectId, outcome: JobOutcome) => {
      setOutcomes((previous) => new Map(previous).set(projectId, outcome));
      const next = confirmed[confirmed.indexOf(projectId) + 1];
      if (next === undefined || stopRequested.current || connectionLost) {
        setPhase("finished");
      } else {
        void submit(next);
      }
    },
    [confirmed, connectionLost, submit],
  );
  // Each accepted job advances the batch once, however often its outcome re-renders.
  const advancedJob = useRef<CommandId | null>(null);
  useEffect(() => {
    if (currentProjectId === undefined || currentJob === null || currentOutcome === null) return;
    if (advancedJob.current === currentJob.jobToken) return;
    advancedJob.current = currentJob.jobToken;
    advanceAfter(currentProjectId, currentOutcome);
  }, [advanceAfter, currentJob, currentOutcome, currentProjectId]);

  const ready = previews?.filter((project) => project.status === "ready") ?? [];
  const shown = target.projectId
    ? previews
    : previews
        ?.filter((project) => project.status !== "existing")
        .toSorted(
          (left, right) => Number(right.status === "ready") - Number(left.status === "ready"),
        );
  const running = phase === "running";
  const finished = phase === "finished";
  const start = () => {
    // The confirmed list is fixed here; a project that becomes eligible later
    // waits for the next explicit search.
    const projectIds = ready.map((project) => project.projectId);
    const first = projectIds[0];
    if (first === undefined) return;
    stopRequested.current = false;
    setStopping(false);
    setError(null);
    setConfirmed(projectIds);
    setJobs(new Map());
    setOutcomes(new Map());
    setPhase("running");
    void submit(first);
  };
  const currentTitle =
    currentProjectId === undefined
      ? null
      : (previews?.find((project) => project.projectId === currentProjectId)?.title ?? null);
  const saved = [...outcomes.values()].filter((outcome) => outcome.status === "selected").length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) closeProjectIconDiscoveryDialog();
      }}
    >
      <DialogPopup showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>
            {target.projectId ? "Find project icon" : "Find missing project icons"}
          </DialogTitle>
          <DialogDescription>
            {target.title ?? environment?.label ?? "Selected environment"}. The agent chooses an
            existing local image. It never downloads or creates images.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[min(55vh,28rem)] space-y-4 overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            {previews === null && !error
              ? "Checking local images…"
              : finished
                ? `${saved} ${saved === 1 ? "icon" : "icons"} saved. ${outcomes.size} ${outcomes.size === 1 ? "search" : "searches"} completed.`
                : `${ready.length} ${ready.length === 1 ? "project has" : "projects have"} images to check. Projects with icons or no candidates need no agent call.`}
          </p>
          {running && currentTitle ? (
            <p role="status" className="text-sm">
              The agent is checking {currentTitle}…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {connectionLost ? (
            <p role="alert" className="text-sm text-destructive">
              The connection to this environment dropped. Projects not yet started will not run.
            </p>
          ) : null}
          <ul className="space-y-3">
            {shown?.map((project) => {
              const outcome = outcomes.get(project.projectId);
              return (
                <li key={project.projectId} className="rounded-lg border p-3">
                  <p className="break-words text-sm font-medium">{project.title}</p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {outcome
                      ? `${OUTCOME_LABELS[outcome.status]}: ${outcome.path ?? outcome.reason}`
                      : project.reason}
                  </p>
                </li>
              );
            })}
          </ul>
          {previews && shown?.length === 0 ? (
            <p className="text-sm">Every project already has an icon.</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {running ? (
            <Button
              variant="outline"
              disabled={stopping}
              onClick={() => {
                stopRequested.current = true;
                setStopping(true);
              }}
            >
              {stopping ? "Stopping after this project…" : "Stop after this project"}
            </Button>
          ) : (
            <Button variant="outline" onClick={closeProjectIconDiscoveryDialog}>
              {finished ? "Close" : "Cancel"}
            </Button>
          )}
          {phase === "preview" ? (
            <Button
              disabled={previews === null || ready.length === 0 || error !== null}
              onClick={start}
            >
              {target.projectId
                ? "Find with agent"
                : previews === null
                  ? "Checking images…"
                  : `Find icons for ${ready.length} ${ready.length === 1 ? "project" : "projects"}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : fallback;
}
