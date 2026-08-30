import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ClientOrchestrationCommand,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "./orchestration.ts";

const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeChatAttachment = Schema.decodeUnknownEffect(ChatAttachment);

const startTurn = (attachments: ReadonlyArray<unknown>) => ({
  type: "thread.turn.start",
  commandId: "command-1",
  threadId: "thread-1",
  message: {
    messageId: "message-1",
    role: "user",
    text: "Inspect these files",
    attachments,
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-08-29T00:00:00.000Z",
});

it.effect("accepts uploaded references and keeps legacy inline images during rollout", () =>
  Effect.gen(function* () {
    const uploaded = yield* decodeClientCommand(
      startTurn([{ type: "uploaded", uploadId: "upload-00000000-0000-4000-8000-000000000001" }]),
    );
    const legacy = yield* decodeClientCommand(
      startTurn([
        {
          type: "image",
          name: "legacy.png",
          mimeType: "image/png",
          sizeBytes: 1,
          dataUrl: "data:image/png;base64,AA==",
        },
      ]),
    );

    assert.strictEqual(uploaded.type, "thread.turn.start");
    assert.strictEqual(legacy.type, "thread.turn.start");
  }),
);

it.effect("persists generic file metadata without upload bytes or client paths", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeChatAttachment({
      type: "file",
      id: "thread-1-00000000-0000-4000-8000-000000000001",
      name: "recording.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
    });

    assert.strictEqual(attachment.type, "file");
    assert.isFalse("dataUrl" in attachment);
    assert.isFalse("path" in attachment);
  }),
);

it.effect("caps uploaded references at the message attachment limit", () =>
  Effect.gen(function* () {
    const attachments = Array.from(
      { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 },
      (_, index) => ({
        type: "uploaded",
        uploadId: `upload-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      }),
    );
    const result = yield* Effect.result(decodeClientCommand(startTurn(attachments)));

    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(PROVIDER_SEND_TURN_MAX_FILE_BYTES, 2 * 1024 * 1024 * 1024);
  }),
);
