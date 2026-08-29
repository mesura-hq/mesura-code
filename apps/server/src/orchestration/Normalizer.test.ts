import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeAttachmentUploadStore } from "../attachmentUploadStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  canonicalizeClientCommandTimestamps,
  commitDispatchCommandAttachments,
  normalizeDispatchCommand,
  rollbackDispatchCommandAttachments,
} from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

const normalizationTestConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-normalizer-test-",
});
const normalizationTestLayer = Layer.mergeAll(
  normalizationTestConfigLayer,
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

describe("normalizeDispatchCommand attachments", () => {
  it.effect("claims a completed upload before dispatching the turn", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const store = yield* makeAttachmentUploadStore({
        uploadsDir: config.attachmentUploadsDir,
        attachmentsDir: config.attachmentsDir,
      });
      const threadId = ThreadId.make("thread-uploaded-attachment");
      const upload = yield* store.create({
        threadId,
        kind: "file",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      });
      yield* store.append({
        uploadId: upload.uploadId,
        offsetBytes: 0,
        body: Stream.make(new Uint8Array([1, 2, 3, 4])),
      });

      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-uploaded-attachment"),
        threadId,
        message: {
          messageId: MessageId.make("message-uploaded-attachment"),
          role: "user",
          text: "Read the attachment",
          attachments: [{ type: "uploaded", uploadId: upload.uploadId }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      const normalized = yield* normalizeDispatchCommand(command);

      expect(normalized.type).toBe("thread.turn.start");
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command");
      }
      expect(normalized.message.attachments).toEqual([
        expect.objectContaining({
          type: "file",
          name: "notes.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        }),
      ]);
      expect((yield* store.inspect(upload.uploadId)).status).toBe("claimed");
      yield* commitDispatchCommandAttachments(command);
      expect((yield* store.inspect(upload.uploadId)).status).toBe("committed");
    }).pipe(Effect.scoped, Effect.provide(normalizationTestLayer)),
  );

  it.effect("releases a claimed upload when dispatch rejects the command", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const store = yield* makeAttachmentUploadStore({
        uploadsDir: config.attachmentUploadsDir,
        attachmentsDir: config.attachmentsDir,
      });
      const threadId = ThreadId.make("thread-rejected-attachment");
      const upload = yield* store.create({
        threadId,
        kind: "file",
        name: "rejected.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
      });
      yield* store.append({
        uploadId: upload.uploadId,
        offsetBytes: 0,
        body: Stream.make(new Uint8Array([1])),
      });
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-rejected-attachment"),
        threadId,
        message: {
          messageId: MessageId.make("message-rejected-attachment"),
          role: "user",
          text: "Reject this turn",
          attachments: [{ type: "uploaded", uploadId: upload.uploadId }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      yield* normalizeDispatchCommand(command);
      yield* rollbackDispatchCommandAttachments(command);

      expect(yield* store.inspect(upload.uploadId)).toMatchObject({
        status: "ready",
        offsetBytes: 1,
      });
    }).pipe(Effect.scoped, Effect.provide(normalizationTestLayer)),
  );

  it.effect("releases earlier claims when a later attachment cannot be normalized", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const store = yield* makeAttachmentUploadStore({
        uploadsDir: config.attachmentUploadsDir,
        attachmentsDir: config.attachmentsDir,
      });
      const threadId = ThreadId.make("thread-invalid-later-attachment");
      const upload = yield* store.create({
        threadId,
        kind: "file",
        name: "recoverable.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
      });
      yield* store.append({
        uploadId: upload.uploadId,
        offsetBytes: 0,
        body: Stream.make(new Uint8Array([1])),
      });
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-invalid-later-attachment"),
        threadId,
        message: {
          messageId: MessageId.make("message-invalid-later-attachment"),
          role: "user",
          text: "Reject the second attachment",
          attachments: [
            { type: "uploaded", uploadId: upload.uploadId },
            {
              type: "image",
              name: "invalid.png",
              mimeType: "image/png",
              sizeBytes: 1,
              dataUrl: "not-a-data-url",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      expect((yield* normalizeDispatchCommand(command).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* store.inspect(upload.uploadId)).toMatchObject({
        status: "ready",
        offsetBytes: 1,
      });
    }).pipe(Effect.scoped, Effect.provide(normalizationTestLayer)),
  );
});
