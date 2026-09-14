/**
 * The folder overview, as a host sees it.
 *
 * `OverviewLayer` renders nothing for a null root and a modal layer otherwise;
 * a host supplies the model and drives the graph through `OverviewPort`.
 */

export type { OverviewViewState } from "./cache.ts";
export { OverviewLayer } from "./Overview.tsx";
export type { OverviewModel } from "./useOverview.ts";
export type { OverviewPort } from "./useOverviewMode.ts";
