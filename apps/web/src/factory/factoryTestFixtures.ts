import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { useMemo, useSyncExternalStore } from "react";
import { makeFenceThreadProjection } from "../test/fenceThreadShell";

export const factoryCoordinatorRunId = RunId.make("factory-coordinator-run");

export function makeFactoryMessageItem(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly createdAt: string;
  readonly text?: string;
  readonly threadId?: ThreadId;
  readonly runId?: RunId;
  readonly streaming?: boolean;
}) {
  const at = DateTime.makeUnsafe(input.createdAt);
  const base = {
    id: TurnItemId.make(input.id),
    threadId: input.threadId ?? ThreadId.make("factory-thread"),
    runId: input.runId ?? factoryCoordinatorRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    messageId: MessageId.make(input.id),
    text: input.text ?? (input.role === "user" ? "Build the approved plan" : "Presented"),
    attachments: [],
  };
  return input.role === "user"
    ? {
        ...base,
        type: "user_message" as const,
        inputIntent: "turn_start" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
      }
    : { ...base, type: "assistant_message" as const, streaming: input.streaming ?? false };
}

export function makeFactoryToolItem(id: string, createdAt: string): OrchestrationV2TurnItem {
  const at = DateTime.makeUnsafe(createdAt);
  return {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("factory-thread"),
    runId: factoryCoordinatorRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "command_execution",
    title: "Ran command",
    input: "echo done",
    exitCode: 0,
  };
}

const projectedByItem = new WeakMap<
  OrchestrationV2TurnItem,
  Map<number, OrchestrationV2ProjectedTurnItem>
>();

/** Keep the server sequence explicit. The client must not sort v2 rows by timestamps. */
export function projectFactoryTurnItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return items.map((item, position) => {
    let byPosition = projectedByItem.get(item);
    if (byPosition === undefined) {
      byPosition = new Map();
      projectedByItem.set(item, byPosition);
    }
    let row = byPosition.get(position);
    if (row === undefined) {
      row = {
        item,
        position,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      };
      byPosition.set(position, row);
    }
    return row;
  });
}

/** Projection records a fixture adds beside its turn items: requests, plans and runs. */
export type FactoryProjectionExtras = Partial<
  Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "plans" | "runs">
>;

export function makeFactoryThreadProjection(
  shell: EnvironmentThreadShell,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  extras: FactoryProjectionExtras = {},
): EnvironmentThread {
  return {
    environmentId: shell.environmentId,
    projection: {
      ...makeFenceThreadProjection(shell),
      ...extras,
      turnItems: items,
      visibleTurnItems: projectFactoryTurnItems(items),
      messages: items.flatMap((item) =>
        item.type === "user_message" || item.type === "assistant_message"
          ? [
              {
                id: item.messageId,
                threadId: item.threadId,
                runId: item.runId,
                nodeId: item.nodeId,
                role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
                text: item.text,
                attachments: item.attachments ?? [],
                streaming: item.type === "assistant_message" && item.streaming,
                createdBy: "user" as const,
                creationSource: "web" as const,
                createdAt: item.startedAt ?? item.updatedAt,
                updatedAt: item.updatedAt,
              },
            ]
          : [],
      ),
    },
  };
}

interface FactoryThreadFixture {
  readonly thread: EnvironmentThreadShell | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** Pending requests, plans or runs; most Factory fixtures have none. */
  readonly projectionExtras?: FactoryProjectionExtras;
  readonly threadListeners: Set<() => void>;
}
type FactoryFixtureSubscribe = (listener: () => void) => () => void;

const NO_PROJECTION_EXTRAS: FactoryProjectionExtras = {};

// Keep hooks at module scope. A nested hook factory lets React Compiler hoist
// fixture reads outside their closure, which produced "fixture is not defined".
function useFactoryFixtureThreadShell(
  fixture: FactoryThreadFixture,
  subscribe: FactoryFixtureSubscribe,
) {
  return useSyncExternalStore(subscribe, () => fixture.thread);
}

function useFactoryFixtureThreadProjection(
  fixture: FactoryThreadFixture,
  subscribe: FactoryFixtureSubscribe,
) {
  const shell = useFactoryFixtureThreadShell(fixture, subscribe);
  const items = useSyncExternalStore(subscribe, () => fixture.turnItems);
  const extras = useSyncExternalStore(
    subscribe,
    () => fixture.projectionExtras ?? NO_PROJECTION_EXTRAS,
  );
  return useMemo(
    () => (shell === null ? null : makeFactoryThreadProjection(shell, items, extras)),
    [shell, items, extras],
  );
}

const EMPTY_FACTORY_ITEMS: OrchestrationV2ProjectedTurnItem[] = [];

function useFactoryFixtureVisibleTurnItems(
  fixture: FactoryThreadFixture,
  subscribe: FactoryFixtureSubscribe,
) {
  return (
    useFactoryFixtureThreadProjection(fixture, subscribe)?.projection.visibleTurnItems ??
    EMPTY_FACTORY_ITEMS
  );
}

/** State boundaries shared by the Factory AppRoot fixtures. */
export function factoryThreadFixtureReads(fixture: FactoryThreadFixture) {
  const subscribe: FactoryFixtureSubscribe = (listener) => {
    fixture.threadListeners.add(listener);
    return () => {
      fixture.threadListeners.delete(listener);
    };
  };
  return {
    useThreadShell: useFactoryFixtureThreadShell.bind(null, fixture, subscribe),
    readThreadShell: () => fixture.thread,
    useThreadProjection: useFactoryFixtureThreadProjection.bind(null, fixture, subscribe),
    readThread: () =>
      fixture.thread === null
        ? null
        : makeFactoryThreadProjection(fixture.thread, fixture.turnItems),
    useThreadStatus: () => "live",
    useThreadVisibleTurnItems: useFactoryFixtureVisibleTurnItems.bind(null, fixture, subscribe),
  };
}
