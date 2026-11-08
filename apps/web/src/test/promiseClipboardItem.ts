/** Consumes ClipboardItem promises as a browser does, including Monaco cancellation. */
export class PromiseClipboardItem {
  readonly types: ReadonlyArray<string>;

  constructor(items: Record<string, Promise<unknown>>) {
    this.types = Object.keys(items);
    for (const item of Object.values(items)) Promise.resolve(item).catch(() => {});
  }
}
