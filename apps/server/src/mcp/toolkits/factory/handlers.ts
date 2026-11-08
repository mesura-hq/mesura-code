import {
  CommandId,
  factoryPlanCardId,
  type FactoryPlanActivityPayload,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { readFactoryPhases, splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as FactoryRunTracker from "../../../factory/FactoryRunTracker.ts";
import * as FactorySnapshotStore from "../../../factory/FactorySnapshotStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  FACTORY_DOCUMENT_MAX_BYTES,
  FACTORY_PLAN_METADATA_MAX_BYTES,
  FactoryPresentPlanError,
  FactoryPresentPlanFailedError,
  FactoryToolkit,
  type PresentPlanInput,
} from "./tools.ts";

/** UTF-8 bytes of the plan's strings that travel in its card. */
function planMetadataBytes(
  title: string,
  headings: ReadonlyArray<string>,
  phaseTitles: ReadonlyArray<string>,
): number {
  const encoder = new TextEncoder();
  let total = encoder.encode(title).byteLength;
  for (const text of [...headings, ...phaseTitles]) total += encoder.encode(text).byteLength;
  return total;
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const snapshots = yield* FactorySnapshotStore.FactorySnapshotStore;
  const runTracker = yield* FactoryRunTracker.FactoryRunTracker;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const sha256Hex = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode), Effect.orDie);

  /** Reads an absolute path to a regular file of at most 1 MiB, or names why not. */
  const readDocument = Effect.fn("FactoryToolkit.readDocument")(function* (documentPath: string) {
    const refuse = (reason: FactoryPresentPlanError["reason"], cause?: unknown) =>
      new FactoryPresentPlanError({ reason, path: documentPath, cause });
    if (!path.isAbsolute(documentPath)) return yield* refuse("relative-path");
    const info = yield* fileSystem
      .stat(documentPath)
      .pipe(
        Effect.mapError((cause) =>
          refuse(cause.reason._tag === "NotFound" ? "not-found" : "read-failed", cause),
        ),
      );
    if (info.type !== "File") return yield* refuse("not-regular-file");
    if (Number(info.size) > FACTORY_DOCUMENT_MAX_BYTES) return yield* refuse("too-large");
    const bytes = yield* fileSystem
      .readFile(documentPath)
      .pipe(Effect.mapError((cause) => refuse("read-failed", cause)));
    // The file can grow between the stat and the read.
    if (bytes.byteLength > FACTORY_DOCUMENT_MAX_BYTES) return yield* refuse("too-large");
    return bytes;
  });

  /** One card per plan file in a thread: the id derives from the path, not the bytes. */
  const planCardId = (threadId: ThreadId, planPath: string) =>
    sha256Hex(new TextEncoder().encode(planPath)).pipe(
      Effect.map((pathDigest) => TurnItemId.make(factoryPlanCardId(threadId, pathDigest))),
    );

  /** The calling thread: both tools act on the thread whose agent called them. */
  const callingThread = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("factory");
    const caller = yield* McpInvocationContext.requireThreadScope(
      scope,
      "This Software Factory tool",
    );
    return caller.thread.threadId;
  });

  const presentPlan = Effect.fn("FactoryToolkit.presentPlan")(function* ({
    planPath,
    intentPath,
  }: PresentPlanInput) {
    const threadId = yield* callingThread;
    const planBytes = yield* readDocument(planPath);
    const intentBytes = yield* readDocument(intentPath);

    const document = splitFactoryDocument(new TextDecoder().decode(planBytes));
    if (document.title === "") {
      return yield* new FactoryPresentPlanError({
        reason: "invalid-plan",
        path: planPath,
        detail: 'The plan has no "# " title line.',
      });
    }
    const phases = readFactoryPhases(document.sections);
    if (!phases.ok) {
      return yield* new FactoryPresentPlanError({
        reason: "invalid-plan",
        path: planPath,
        detail: phases.reason,
      });
    }

    const headings = document.sections.map((section) => section.heading);
    const metadataBytes = planMetadataBytes(
      document.title,
      headings,
      phases.phases.map((phase) => phase.title),
    );
    if (metadataBytes > FACTORY_PLAN_METADATA_MAX_BYTES) {
      return yield* new FactoryPresentPlanError({
        reason: "metadata-too-large",
        path: planPath,
        detail: `${metadataBytes} bytes`,
      });
    }

    const [digest, intentDigest] = yield* Effect.all([
      snapshots.put(planBytes),
      snapshots.put(intentBytes),
    ]).pipe(Effect.mapError((cause) => new FactoryPresentPlanFailedError({ cause })));

    const payload: FactoryPlanActivityPayload = {
      digest,
      intentDigest,
      planPath,
      intentPath,
      title: document.title,
      phases: phases.phases.map((phase) => ({
        title: phase.title,
        acceptanceCount: phase.acceptance.length,
      })),
      headings,
      presentedAt: DateTime.formatIso(yield* DateTime.now),
    };
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    // The orchestrator anchors the card to the thread's active run and keeps
    // its place when the same plan file is presented again.
    yield* orchestrator
      .dispatch({
        type: "factory_card.record",
        commandId: CommandId.make(`server:factory-plan:${threadId}:${uuid}`),
        threadId,
        turnItemId: yield* planCardId(threadId, planPath),
        card: { kind: "plan", payload },
      })
      .pipe(Effect.mapError((cause) => new FactoryPresentPlanFailedError({ cause })));

    return { digest, intentDigest, title: document.title, phaseCount: phases.phases.length };
  });

  return {
    present_plan: McpToolAccess.actsAsCaller(presentPlan),
    attach_factory_run: McpToolAccess.actsAsCaller(({ runDir }) =>
      Effect.gen(function* () {
        const threadId = yield* callingThread;
        return yield* runTracker.attach(threadId, runDir);
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof FactoryToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoryToolkit, make);
