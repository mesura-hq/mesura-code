/**
 * Mesura: the branch as the sidebar card shows it.
 *
 * Every worktree branch the app creates lives under the app's own namespace
 * (`mesura/`, and `t3/` or `t3code/` on threads created before the rename). The
 * namespace is the same on every card, so it only spends the row's width before
 * the part that tells threads apart. Branches the user or an agent named, such
 * as `feat/search`, keep their prefix: there it carries meaning.
 *
 * The full name stays everywhere a branch is copied, checked out or shown in
 * detail; this is only the card's label.
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
