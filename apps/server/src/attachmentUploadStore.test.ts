import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  ATTACHMENT_UPLOAD_EXPIRY_MS,
  type AttachmentUploadStore,
  makeAttachmentUploadStore,
} from "./attachmentUploadStore.ts";

const withStore = <A, E, R>(
  run: (
    store: AttachmentUploadStore,
    paths: { readonly attachmentsDir: string; readonly uploadsDir: string },
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "mesura-upload-store-" });
      const paths = {
        attachmentsDir: path.join(root, "attachments"),
        uploadsDir: path.join(root, "uploads"),
      };
      const store = yield* makeAttachmentUploadStore(paths);
      return yield* run(store, paths);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const createVideo = (store: AttachmentUploadStore) =>
  store.create({
    threadId: ThreadId.make("thread-1"),
    name: "recording.mp4",
    mimeType: "video/mp4",
    kind: "file",
    sizeBytes: 6,
  });
const claimToken = CommandId.make("command-claim-attachment");

describe("AttachmentUploadStore", () => {
  it.effect("resumes a disk-backed upload after the store is reconstructed", () =>
    withStore((store, paths) =>
      Effect.gen(function* () {
        const created = yield* createVideo(store);
        yield* store.append({
          uploadId: created.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1, 2, 3])),
        });

        const restarted = yield* makeAttachmentUploadStore(paths);
        const inspected = yield* restarted.inspect(created.uploadId);
        expect(inspected).toMatchObject({ offsetBytes: 3, sizeBytes: 6, status: "uploading" });

        const ready = yield* restarted.append({
          uploadId: created.uploadId,
          offsetBytes: 3,
          body: Stream.make(new Uint8Array([4, 5, 6])),
        });
        expect(ready.status).toBe("ready");
      }),
    ),
  );

  it.effect("claims a ready upload atomically under a server-owned attachment path", () =>
    withStore((store, paths) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const created = yield* createVideo(store);
        yield* store.append({
          uploadId: created.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])),
        });

        const attachment = yield* store.claim({
          uploadId: created.uploadId,
          threadId: ThreadId.make("thread-1"),
          claimToken,
        });
        const resolved = yield* store.resolveClaimedPath(created.uploadId);

        expect(attachment).toMatchObject({
          type: "file",
          name: "recording.mp4",
          mimeType: "video/mp4",
          sizeBytes: 6,
        });
        expect(path.relative(paths.attachmentsDir, resolved)).not.toMatch(/^\.\./);
        expect(path.extname(resolved)).toBe(".bin");
        expect(Array.from(yield* fileSystem.readFile(resolved))).toEqual([1, 2, 3, 4, 5, 6]);
      }),
    ),
  );

  it.effect("rejects incomplete uploads and uploads owned by another thread", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const created = yield* createVideo(store);

        const incompleteError = yield* store
          .claim({
            uploadId: created.uploadId,
            threadId: ThreadId.make("thread-1"),
            claimToken,
          })
          .pipe(Effect.flip);
        expect(incompleteError.reason).toBe("incomplete");

        yield* store.append({
          uploadId: created.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])),
        });
        const foreignThreadError = yield* store
          .claim({
            uploadId: created.uploadId,
            threadId: ThreadId.make("thread-2"),
            claimToken,
          })
          .pipe(Effect.flip);
        expect(foreignThreadError.reason).toBe("thread-mismatch");
      }),
    ),
  );

  it.effect("serializes concurrent claims across reconstructed store instances", () =>
    withStore((store, paths) =>
      Effect.gen(function* () {
        const created = yield* createVideo(store);
        yield* store.append({
          uploadId: created.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])),
        });
        const reconstructed = yield* makeAttachmentUploadStore(paths);

        const [first, second] = yield* Effect.all(
          [
            store.claim({
              uploadId: created.uploadId,
              threadId: ThreadId.make("thread-1"),
              claimToken,
            }),
            reconstructed.claim({
              uploadId: created.uploadId,
              threadId: ThreadId.make("thread-1"),
              claimToken,
            }),
          ],
          { concurrency: 2 },
        );

        expect(second).toEqual(first);
        expect((yield* store.inspect(created.uploadId)).status).toBe("claimed");
      }),
    ),
  );

  it.effect("does not block one upload while another upload streams", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const first = yield* createVideo(store);
        const second = yield* createVideo(store);
        const streamEntered = yield* Deferred.make<void>();
        const releaseStream = yield* Deferred.make<Uint8Array>();
        const appendFiber = yield* store
          .append({
            uploadId: first.uploadId,
            offsetBytes: 0,
            body: Stream.fromEffect(
              Deferred.succeed(streamEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStream)),
              ),
            ),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(streamEntered);

        expect(yield* store.inspect(second.uploadId)).toMatchObject({ status: "uploading" });

        yield* Deferred.succeed(releaseStream, new Uint8Array([1, 2, 3, 4, 5, 6]));
        yield* Fiber.await(appendFiber);
      }),
    ),
  );

  it.effect("reconciles expired claims with durable command acceptance", () =>
    withStore((store, paths) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const accepted = yield* createVideo(store);
        yield* store.append({
          uploadId: accepted.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])),
        });
        yield* store.claim({
          uploadId: accepted.uploadId,
          threadId: ThreadId.make("thread-1"),
          claimToken,
        });
        const acceptedPath = yield* store.resolveClaimedPath(accepted.uploadId);

        const abandoned = yield* createVideo(store);
        yield* store.append({
          uploadId: abandoned.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])),
        });
        const abandonedToken = CommandId.make("command-abandoned-attachment");
        yield* store.claim({
          uploadId: abandoned.uploadId,
          threadId: ThreadId.make("thread-1"),
          claimToken: abandonedToken,
        });
        const abandonedPath = yield* store.resolveClaimedPath(abandoned.uploadId);

        const nowMs = yield* Clock.currentTimeMillis;
        yield* store.pruneExpired(nowMs + ATTACHMENT_UPLOAD_EXPIRY_MS + 1, {
          isCommandAccepted: (commandId) => Effect.succeed(commandId === claimToken),
        });

        expect(yield* fileSystem.exists(acceptedPath)).toBe(true);
        expect(yield* fileSystem.exists(abandonedPath)).toBe(false);
        expect((yield* Effect.result(store.inspect(accepted.uploadId)))._tag).toBe("Failure");
        expect((yield* Effect.result(store.inspect(abandoned.uploadId)))._tag).toBe("Failure");
        expect(yield* fileSystem.exists(paths.attachmentsDir)).toBe(true);
      }),
    ),
  );

  it.effect("rejects an image upload whose MIME type is not an image", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const error = yield* store
          .create({
            threadId: ThreadId.make("thread-1"),
            name: "not-an-image.mp4",
            mimeType: "video/mp4",
            kind: "image",
            sizeBytes: 1,
          })
          .pipe(Effect.flip);

        expect(error.reason).toBe("invalid-input");
      }),
    ),
  );

  it.effect("expires incomplete and ready uploads that no turn claimed", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const incomplete = yield* createVideo(store);
        const ready = yield* store.create({
          threadId: ThreadId.make("thread-1"),
          name: "ready.pdf",
          mimeType: "application/pdf",
          kind: "file",
          sizeBytes: 1,
        });
        yield* store.append({
          uploadId: ready.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1])),
        });

        const nowMs = yield* Clock.currentTimeMillis;
        const removed = yield* store.pruneExpired(nowMs + ATTACHMENT_UPLOAD_EXPIRY_MS + 1);

        expect([...removed].sort()).toEqual([incomplete.uploadId, ready.uploadId].sort());
        expect((yield* Effect.result(store.inspect(incomplete.uploadId)))._tag).toBe("Failure");
        expect((yield* Effect.result(store.inspect(ready.uploadId)))._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("keeps client names from escaping the attachment directory", () =>
    withStore((store, paths) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const created = yield* store.create({
          threadId: ThreadId.make("thread-1"),
          name: "../../outside.mp4",
          mimeType: "video/mp4",
          kind: "file",
          sizeBytes: 1,
        });
        yield* store.append({
          uploadId: created.uploadId,
          offsetBytes: 0,
          body: Stream.make(new Uint8Array([1])),
        });
        yield* store.claim({
          uploadId: created.uploadId,
          threadId: ThreadId.make("thread-1"),
          claimToken,
        });
        const resolved = yield* store.resolveClaimedPath(created.uploadId);

        expect(path.relative(paths.attachmentsDir, resolved)).not.toMatch(/^\.\./);
        expect(path.basename(resolved)).not.toContain("outside");
      }),
    ),
  );
});
