import { isFailure } from "@symmetria/fm-core/contract";
import { useEffect, useState } from "react";

import { readFileText } from "../../bridge.ts";

/**
 * How much of a file a text preview reads.
 *
 * A preview pane never needs the whole file. The cap bounds the read, the
 * transfer and the DOM at once — and it is what makes the truncation marker a
 * normal outcome rather than an error path nobody exercises.
 */
const TEXT_CAP_BYTES = 512 * 1024;

export interface TextPreviewProps {
  readonly path: string;
}

interface Loaded {
  readonly text: string;
  readonly truncated: boolean;
}

/** Read the head of a file as text, re-reading whenever the path changes. */
export function useFileText(path: string): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded(null);

    void readFileText(path, TEXT_CAP_BYTES).then((reply) => {
      if (!current) return;
      setLoaded(
        isFailure(reply)
          ? { text: reply.error.message, truncated: false }
          : { text: reply.value.text, truncated: reply.value.truncated },
      );
    });

    return () => {
      current = false;
    };
  }, [path]);

  return loaded;
}

/** A file's contents, scrollable and selectable. */
export function TextPreview({ path }: TextPreviewProps) {
  const loaded = useFileText(path);
  if (loaded === null) return <div data-testid="preview-loading">reading…</div>;

  return (
    <div className="preview preview--text" data-testid="preview-text">
      <pre className="preview__body">{loaded.text}</pre>
      {loaded.truncated ? <TruncationMarker /> : null}
    </div>
  );
}

/**
 * Say that there is more.
 *
 * Without it a capped preview is indistinguishable from a file that simply
 * ends — and a reader would conclude the last line is the last line.
 */
export function TruncationMarker() {
  return (
    <p className="preview__truncated" data-testid="preview-truncated">
      … truncated
    </p>
  );
}
