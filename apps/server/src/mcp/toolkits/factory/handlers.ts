import {
  CommandId,
  EventId,
  FACTORY_PLAN_ACTIVITY_KIND,
  type FactoryPlanActivityPayload,
  type ThreadId,
} from "@t3tools/contracts";
import { readFactoryPhases, splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as FactorySnapshotStore from "../../../factory/FactorySnapshotStore.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  FACTORY_DOCUMENT_MAX_BYTES,
  FACTORY_PLAN_METADATA_MAX_BYTES,
  FactoryPresentPlanError,
  FactoryPresentPlanFailedError,
  FactoryToolkit,
} from "./tools.ts";

/** Plans are titled `# Plan: …`; the card's summary adds its own `Plan: ` prefix once. */
export function factoryPlanSummary(title: string): string {
  return `Plan: ${title.replace(/^plan:\s*/i, "")}`;
}

/** UTF-8 bytes of the plan's strings that travel in its activity. */
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
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* FactorySnapshotStore.FactorySnapshotStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const sha256Hex = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map(Encoding.encodeHex), Effect.orDie);

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

  /** One activity per plan file in a thread: the id derives from the path, not the bytes. */
  const planActivityId = (threadId: ThreadId, planPath: string) =>
    sha256Hex(new TextEncoder().encode(planPath)).pipe(
      Effect.map((pathDigest) =>
        EventId.make(`factory-plan:${threadId}:${pathDigest.slice(0, 16)}`),
      ),
    );

  return FactoryToolkit.of({
    present_plan: ({ planPath, intentPath }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("factory");
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

        const now = DateTime.formatIso(yield* DateTime.now);
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
          presentedAt: now,
        };
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`server:factory-plan:${scope.threadId}:${uuid}`),
            threadId: scope.threadId,
            activity: {
              id: yield* planActivityId(scope.threadId, planPath),
              tone: "info",
              kind: FACTORY_PLAN_ACTIVITY_KIND,
              summary: factoryPlanSummary(document.title),
              payload,
              // No turn and the current time, so a presented plan sorts last.
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          })
          .pipe(Effect.mapError((cause) => new FactoryPresentPlanFailedError({ cause })));

        return { digest, intentDigest, title: document.title, phaseCount: phases.phases.length };
      }),
  });
});

export const FactoryToolkitHandlersLive = FactoryToolkit.toLayer(make);
