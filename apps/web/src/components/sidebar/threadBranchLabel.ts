/**
 * Mesura: the branch as the sidebar card shows it. The app's own namespace (`mesura/`, and `t3/`
 * or `t3code/` from before the rename) is the same on every card, so the label drops it; a
 * user-named prefix such as `feat/` carries meaning and stays. Everywhere else shows the full name.
 */
const APP_BRANCH_NAMESPACES = ["mesura/", "t3code/", "t3/"] as const;

export function threadBranchCardLabel(branch: string): string {
  for (const namespace of APP_BRANCH_NAMESPACES) {
    if (branch.startsWith(namespace) && branch.length > namespace.length) {
      return branch.slice(namespace.length);
    }
  }
  return branch;
}
