export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}
export function pickerPosition(anchor: Rect, viewport: Viewport) {
  const margin = Math.min(
    12,
    Math.max(0, viewport.width / 4),
    Math.max(0, viewport.height / 4),
  );
  const leftEdge = viewport.left + margin;
  const topEdge = viewport.top + margin;
  const rightEdge = viewport.left + viewport.width - margin;
  const bottomEdge = viewport.top + viewport.height - margin;
  const width = Math.max(0, Math.min(340, rightEdge - leftEdge));
  const above = Math.max(0, Math.min(bottomEdge, anchor.top - 8) - topEdge);
  const below = Math.max(0, bottomEdge - Math.max(topEdge, anchor.bottom + 8));
  const side = above >= 420 || above >= below ? "above" : "below";
  const height = Math.min(420, side === "above" ? above : below);
  const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - width));
  const preferredTop =
    side === "above" ? anchor.top - 8 - height : anchor.bottom + 8;
  const top = Math.max(topEdge, Math.min(preferredTop, bottomEdge - height));
  return { left, top, width, height, side };
}
export function isInsidePicker(
  target: Node | null,
  anchor: HTMLElement | null,
  panel: HTMLElement | null,
): boolean {
  return !!target && (!!anchor?.contains(target) || !!panel?.contains(target));
}
// Install only while open. All geometry work is coalesced into one animation frame.
export function trackPicker(
  anchor: HTMLElement,
  panel: HTMLElement,
  place: () => void,
  close: () => void,
): () => void {
  let frame: number | undefined;
  let stopped = false;
  const update = () => {
    frame = undefined;
    if (stopped) return;
    if (!anchor.isConnected || !panel.isConnected) {
      close();
      return;
    }
    place();
  };
  const schedule = () => {
    if (!stopped && frame === undefined) frame = requestAnimationFrame(update);
  };
  const pointer = (event: MouseEvent) => {
    if (!isInsidePicker(event.target as Node, anchor, panel)) close();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close();
      anchor.focus();
    }
  };
  document.addEventListener("mousedown", pointer);
  document.addEventListener("keydown", key);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  const resize =
    typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  resize?.observe(anchor);
  const mutation = new MutationObserver(schedule);
  mutation.observe(document.body, { childList: true, subtree: true });
  update();
  return () => {
    stopped = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    resize?.disconnect();
    mutation.disconnect();
    document.removeEventListener("mousedown", pointer);
    document.removeEventListener("keydown", key);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
  };
}
