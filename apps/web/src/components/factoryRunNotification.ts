/**
 * Mesura: announces a Software Factory run that just recorded `run.finished`, through the thread
 * notifications `ThreadNotificationCoordinator` already shows. A `stopped` run is left out: it
 * already asks for the developer as Needs input.
 */
import { isFactoryRunFinished, type FactoryRunShellSummary } from "@t3tools/contracts";

export type FactoryRunFinish = "done" | "degraded";

/**
 * The finished status a thread's run reached since the previous observation, or null. A thread
 * first seen with a finished run, or without a run, announces nothing.
 */
export function factoryRunJustFinished(
  prior: Pick<FactoryRunShellSummary, "status"> | null | undefined,
  next: Pick<FactoryRunShellSummary, "status"> | null | undefined,
): FactoryRunFinish | null {
  if (prior == null || next == null || isFactoryRunFinished(prior.status)) return null;
  return next.status === "done" || next.status === "degraded" ? next.status : null;
}

export function factoryRunFinishedTitle(finish: FactoryRunFinish): string {
  return finish === "done" ? "Factory run finished" : "Factory run finished degraded";
}

/**
 * Holds each run finish until one notification announces it. The coordinator's turn usually
 * ends right after it appends `run.finished`, so the finish is carried by that turn's completion
 * notification instead of a second sound seconds earlier. A finish whose thread is not executing
 * has no completion coming, and is announced on its own.
 */
export function createFactoryRunFinishes<Key>() {
  const pending = new Map<Key, FactoryRunFinish>();
  const take = (key: Key): FactoryRunFinish | undefined => {
    const finish = pending.get(key);
    pending.delete(key);
    return finish;
  };
  return {
    /** Records a finish seen in this observation. */
    record(key: Key, finish: FactoryRunFinish | null): void {
      if (finish !== null) pending.set(key, finish);
    },
    /** The finish a completion notification of this thread should announce, taken once. */
    take,
    /**
     * After the gate saw the observation: a finish still pending on a thread with no completion
     * coming was not announced by one, and is taken to be announced on its own.
     */
    takeUnannounced(key: Key, completionComing: boolean): FactoryRunFinish | undefined {
      return completionComing ? undefined : take(key);
    },
    retain(keys: ReadonlySet<Key>): void {
      for (const key of pending.keys()) if (!keys.has(key)) pending.delete(key);
    },
  };
}
