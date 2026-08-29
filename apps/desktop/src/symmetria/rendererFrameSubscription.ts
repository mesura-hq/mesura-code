export type RendererFrame<Session> = {
  readonly revision: number;
  readonly session: Session;
};

/** Keeps a renderer reload ordered while its listener and snapshot request attach separately. */
export function subscribeToOrderedRendererFrames<Session>(options: {
  readonly load: () => Promise<RendererFrame<Session>>;
  readonly attach: (listener: (frame: RendererFrame<Session>) => void) => () => void;
  readonly listener: (session: Session) => void;
  readonly onError?: (error: Error) => void;
}): () => void {
  let active = true;
  let opening = true;
  let revision = -1;
  const queued: Array<RendererFrame<Session>> = [];
  const unsubscribe = options.attach((frame) => {
    if (!active) return;
    if (opening) {
      queued.push(frame);
      return;
    }
    if (frame.revision <= revision) return;
    revision = frame.revision;
    options.listener(frame.session);
  });

  void options
    .load()
    .then((frame) => {
      if (!active) return;
      revision = frame.revision;
      options.listener(frame.session);
      opening = false;
      queued.sort((left, right) => left.revision - right.revision);
      for (const pending of queued) {
        if (pending.revision <= revision) continue;
        revision = pending.revision;
        options.listener(pending.session);
      }
      queued.length = 0;
    })
    .catch((cause) => {
      opening = false;
      queued.sort((left, right) => left.revision - right.revision);
      for (const pending of queued) {
        if (pending.revision <= revision) continue;
        revision = pending.revision;
        options.listener(pending.session);
      }
      queued.length = 0;
      options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    });

  return () => {
    active = false;
    queued.length = 0;
    unsubscribe();
  };
}
