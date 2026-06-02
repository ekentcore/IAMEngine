// Indent depth for an ordered step list (runbook / playbook): how deep each item sits in the
// dependency chain — the longest path to a root, counting only items present in the list. Used
// to slightly indent each step under the step(s) it runs after, so "what's under what" is visible
// without reordering. Dependency graphs are DAGs (topo-sorted upstream); a cycle guard is kept
// for safety.
export function dependencyDepth(items: Array<{ key: string; deps: string[] }>): Map<string, number> {
  const present = new Set(items.map((i) => i.key));
  const depsByKey = new Map(items.map((i) => [i.key, i.deps.filter((d) => present.has(d) && d !== i.key)]));
  const memo = new Map<string, number>();

  const depth = (key: string, stack: Set<string>): number => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (stack.has(key)) return 0; // cycle guard
    stack.add(key);
    const deps = depsByKey.get(key) ?? [];
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, stack))) : 0;
    stack.delete(key);
    memo.set(key, d);
    return d;
  };

  for (const i of items) depth(i.key, new Set());
  return memo;
}
