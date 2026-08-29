import { FileIcon, RotateCcwIcon, XIcon } from "lucide-react";

import { formatAttachmentSize, type ComposerAttachmentUpload } from "./composerAttachments";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

export function ComposerAttachmentList(props: {
  attachments: ReadonlyArray<ComposerAttachmentUpload>;
  onRetry: (attachment: ComposerAttachmentUpload) => void;
  onRemove: (attachment: ComposerAttachmentUpload) => void;
}) {
  const files = props.attachments.filter((attachment) => attachment.kind === "file");
  if (files.length === 0) return null;

  return (
    <div className="mb-3 grid gap-1.5" data-composer-file-attachments="true">
      {files.map((attachment) => {
        const progress =
          attachment.sizeBytes > 0
            ? Math.round((attachment.uploadedBytes / attachment.sizeBytes) * 100)
            : 0;
        const label =
          attachment.status === "ready"
            ? "Ready"
            : attachment.status === "failed"
              ? (attachment.error ?? "Upload failed")
              : attachment.status === "cancelled"
                ? "Cancelled"
                : attachment.status === "preparing"
                  ? "Preparing"
                  : `Uploading ${progress}%`;
        return (
          <div
            key={attachment.id}
            className="relative flex min-w-0 items-center gap-3 overflow-hidden rounded-lg border border-border/70 bg-background/55 px-3 py-2"
          >
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-border/50" aria-hidden="true">
              <div
                className={cn(
                  "h-full transition-[width] duration-200",
                  attachment.status === "failed"
                    ? "bg-destructive"
                    : attachment.status === "cancelled"
                      ? "bg-muted-foreground"
                      : attachment.status === "ready"
                        ? "bg-emerald-500"
                        : "bg-message-action",
                )}
                style={{ width: `${attachment.status === "ready" ? 100 : progress}%` }}
              />
            </div>
            <FileIcon className="size-4 shrink-0 text-icon-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{attachment.name}</div>
              <div className="truncate text-[11px] text-secondary-label">
                {formatAttachmentSize(attachment.sizeBytes)} · {label}
              </div>
            </div>
            {attachment.status === "failed" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => props.onRetry(attachment)}
                aria-label={`Retry ${attachment.name}`}
              >
                <RotateCcwIcon />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => props.onRemove(attachment)}
              aria-label={`Remove ${attachment.name}`}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
