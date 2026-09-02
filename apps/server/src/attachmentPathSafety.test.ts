// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAttachmentPath } from "./attachmentStore.ts";

/**
 * ADR-003 retired this fork's attachment stack for upstream's and named one
 * check worth carrying over: before provider work starts, an attachment path
 * must be a regular file and not a symbolic link. Upstream has no equivalent.
 *
 * The fork's original lived on its own delivery path, which no longer exists.
 * The check sits in `resolveAttachmentPath` instead, because every provider
 * reaches an attachment through it — five adapters, `ProviderService`, and both
 * text-generation modules — and a call site upstream adds later is covered
 * without being touched.
 *
 * It rejects only what is actually there. `Normalizer` resolves the path of an
 * attachment it is about to write, so a path with nothing at it still resolves;
 * anything else would take image attachments out entirely. The last two cases
 * here exist to hold that line.
 */

const fileAttachment = (id: string, name: string): ChatAttachment =>
  ({
    type: "file",
    id,
    name,
    mimeType: "text/plain",
    sizeBytes: 5,
  }) as unknown as ChatAttachment;

const withAttachmentsDir = (use: (attachmentsDir: string) => void) => {
  const attachmentsDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "mesura-attachment-safety-"),
  );
  try {
    use(attachmentsDir);
  } finally {
    NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
  }
};

describe("attachment path safety", () => {
  it("refuses a symbolic link pointing outside the attachments directory", () => {
    withAttachmentsDir((attachmentsDir) => {
      const outside = NodePath.join(NodeOS.tmpdir(), "mesura-attachment-safety-outside.txt");
      NodeFS.writeFileSync(outside, "secret");
      try {
        const attachment = fileAttachment("thread-1-escape", "notes.txt");
        NodeFS.symlinkSync(outside, NodePath.join(attachmentsDir, "thread-1-escape.txt"));

        expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBeNull();
      } finally {
        NodeFS.rmSync(outside, { force: true });
      }
    });
  });

  it("refuses a symbolic link even when its target is inside the directory", () => {
    withAttachmentsDir((attachmentsDir) => {
      const realPath = NodePath.join(attachmentsDir, "thread-1-real.txt");
      NodeFS.writeFileSync(realPath, "hello");
      const attachment = fileAttachment("thread-1-link", "notes.txt");
      NodeFS.symlinkSync(realPath, NodePath.join(attachmentsDir, "thread-1-link.txt"));

      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBeNull();
    });
  });

  it("refuses a path that is not a regular file", () => {
    withAttachmentsDir((attachmentsDir) => {
      const attachment = fileAttachment("thread-1-dir", "notes.txt");
      NodeFS.mkdirSync(NodePath.join(attachmentsDir, "thread-1-dir.txt"));

      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBeNull();
    });
  });

  it("refuses a dangling symbolic link, whose target no longer exists", () => {
    // lstat does not follow the link, so this is rejected as a link rather than
    // reaching the missing-target branch and being mistaken for a path with
    // nothing at it.
    withAttachmentsDir((attachmentsDir) => {
      const target = NodePath.join(attachmentsDir, "gone.txt");
      NodeFS.writeFileSync(target, "hello");
      const attachment = fileAttachment("thread-1-dangling", "notes.txt");
      NodeFS.symlinkSync(target, NodePath.join(attachmentsDir, "thread-1-dangling.txt"));
      NodeFS.rmSync(target);

      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBeNull();
    });
  });

  it("refuses a named pipe", () => {
    withAttachmentsDir((attachmentsDir) => {
      const fifoPath = NodePath.join(attachmentsDir, "thread-1-fifo.txt");
      const made = NodeChildProcess.spawnSync("mkfifo", [fifoPath]);
      if (made.status !== 0) return; // no mkfifo on this platform

      const attachment = fileAttachment("thread-1-fifo", "notes.txt");
      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBeNull();
    });
  });

  it("resolves an ordinary regular file", () => {
    withAttachmentsDir((attachmentsDir) => {
      const attachment = fileAttachment("thread-1-plain", "notes.txt");
      const expected = NodePath.join(attachmentsDir, "thread-1-plain.txt");
      NodeFS.writeFileSync(expected, "hello");

      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBe(expected);
    });
  });

  it("still resolves a path with nothing at it, which is how attachments get written", () => {
    // Normalizer resolves the destination before creating it. Rejecting a
    // missing path here would stop every attachment from ever being stored.
    withAttachmentsDir((attachmentsDir) => {
      const attachment = fileAttachment("thread-1-pending", "notes.txt");
      const expected = NodePath.join(attachmentsDir, "thread-1-pending.txt");

      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBe(expected);
    });
  });
});
