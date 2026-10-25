/**
 * The project keys the sidebar's search pool reads. While the Search field has
 * text it searches every project, whatever the project filter holds; clearing
 * the field hands the pool back to the filter. `null` means every project.
 */
export function resolveSidebarSearchProjectKeys(
  query: string,
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  return query.trim().length > 0 ? null : scopedProjectKeys;
}
