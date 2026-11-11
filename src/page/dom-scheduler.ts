// Coalesce mutation bursts without holding the page in a microtask loop.
export function createDomScheduler(run: () => void, delay = 100) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  return {
    request() {
      if (stopped || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) run();
      }, delay);
    },
    cancel() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
function ownNote(node: Node): boolean {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return !!el?.closest?.(
    ".wa-translate-incoming-note, .wa-translate-hover-action",
  );
}
export function isOnlyOwnMutation(record: MutationRecord): boolean {
  if (ownNote(record.target)) return true;
  if (record.type !== "childList") return false;
  const nodes = [
    ...Array.from(record.addedNodes),
    ...Array.from(record.removedNodes),
  ];
  return nodes.length > 0 && nodes.every(ownNote);
}
