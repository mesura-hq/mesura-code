import type { SidebarThreadSortOrder } from "@t3tools/contracts";

export const THREAD_ORDER_OPTIONS: ReadonlyArray<{
  readonly value: SidebarThreadSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Last user message" },
  { value: "created_at", label: "Created at" },
];
