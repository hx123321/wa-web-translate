// React internals are version-dependent. Inspect own data slots only, never getters
// or message bodies. Unknown, stale, ambiguous or unbounded paths fail closed.
export function ownData(value: unknown, key: string): any {
  if (!value || typeof value !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
export function committedBubbleModel(node: object): object | null {
  try {
    const keys = Object.getOwnPropertyNames(node).filter((k) =>
      k.startsWith("__reactFiber$"),
    );
    if (keys.length !== 1) return null;
    const base = ownData(node, keys[0]);
    const candidates = [...new Set([base, ownData(base, "alternate")])].filter(
      Boolean,
    );
    const models: object[] = [];
    for (const start of candidates) {
      if (ownData(start, "stateNode") !== node) continue;
      let fiber = start;
      let model: object | undefined;
      const visited = new Set<object>();
      for (let depth = 0; fiber && depth < 256; depth++) {
        if (visited.has(fiber)) break;
        visited.add(fiber);
        const msg = ownData(ownData(fiber, "memoizedProps"), "msg");
        if (msg !== undefined) {
          if (!msg || typeof msg !== "object" || (model && model !== msg))
            break;
          model = msg;
        }
        const parent = ownData(fiber, "return");
        if (!parent) {
          if (
            model &&
            ownData(ownData(fiber, "stateNode"), "current") === fiber
          )
            models.push(model);
          break;
        }
        let child = ownData(parent, "child");
        let found = false;
        const siblings = new Set<object>();
        for (let i = 0; child && i < 512; i++) {
          if (siblings.has(child)) break;
          siblings.add(child);
          if (child === fiber) {
            found = true;
            break;
          }
          child = ownData(child, "sibling");
        }
        if (!found) break;
        fiber = parent;
      }
    }
    // Even equal models on two purported current branches are not proof.
    return models.length === 1 ? models[0] : null;
  } catch {
    return null;
  }
}
