export const FLOATING_DRAG_START = "wa-translate:floating-drag-start";

export interface Point {
  x: number;
  y: number;
}
export function clampPosition(
  point: Point,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): Point {
  return {
    x: Math.max(
      12,
      Math.min(point.x, Math.max(12, viewportWidth - width - 12)),
    ),
    y: Math.max(
      12,
      Math.min(point.y, Math.max(12, viewportHeight - height - 12)),
    ),
  };
}
// Window-lifetime state only: never persist user movement to browser storage.
let savedPosition: Point | null = null;
export function installFloatingDrag(
  host: HTMLElement,
  initial: Point,
): () => void {
  let position = savedPosition ?? initial;
  let drag: {
    id: number;
    x: number;
    y: number;
    origin: Point;
    moved: boolean;
    capture: HTMLElement;
  } | null = null;
  let suppressClickUntil = 0;
  const apply = () => {
    const rect = host.getBoundingClientRect();
    position = clampPosition(
      position,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    );
    host.style.left = `${position.x}px`;
    host.style.top = `${position.y}px`;
    if (savedPosition) savedPosition = { ...position };
  };
  const down = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const capture = target?.closest<HTMLElement>(".wa-translate-picker-btn");
    if (!event.isPrimary || event.button !== 0 || !capture) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: { ...position },
      moved: false,
      capture,
    };
    try {
      capture.setPointerCapture(event.pointerId);
    } catch {
      drag = null;
    }
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.capture.dispatchEvent(
        new Event(FLOATING_DRAG_START, { bubbles: true }),
      );
    }
    event.preventDefault();
    position = { x: drag.origin.x + dx, y: drag.origin.y + dy };
    savedPosition = position;
    apply();
  };
  const finish = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved) {
      suppressClickUntil = Date.now() + 500;
      event.preventDefault();
    }
    const { id, capture } = drag;
    drag = null;
    try {
      if (capture.hasPointerCapture(id)) capture.releasePointerCapture(id);
    } catch {}
  };
  const click = (event: MouseEvent) => {
    if (Date.now() > suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Limit touch-action to the draggable button; the open language list still scrolls.
  const css = document.createElement("style");
  css.textContent =
    "#wa-translate-picker-host .wa-translate-picker-btn{touch-action:none;cursor:grab;}";
  document.head.appendChild(css);
  host.addEventListener("pointerdown", down, { passive: true });
  host.addEventListener("pointermove", move, { passive: false });
  host.addEventListener("pointerup", finish, { passive: false });
  host.addEventListener("pointercancel", finish, { passive: false });
  host.addEventListener("lostpointercapture", finish, { passive: false });
  host.addEventListener("click", click, { capture: true, passive: false });
  window.addEventListener("resize", apply);
  const observer = new ResizeObserver(apply);
  observer.observe(host);
  apply();
  return () => {
    if (drag) {
      try {
        drag.capture.releasePointerCapture(drag.id);
      } catch {}
    }
    drag = null;
    observer.disconnect();
    css.remove();
    window.removeEventListener("resize", apply);
    host.removeEventListener("pointerdown", down);
    host.removeEventListener("pointermove", move);
    host.removeEventListener("pointerup", finish);
    host.removeEventListener("pointercancel", finish);
    host.removeEventListener("lostpointercapture", finish);
    host.removeEventListener("click", click, true);
  };
}

export function previewIsBelow(
  composer: HTMLElement,
  host: HTMLElement,
): boolean {
  const input = composer.getBoundingClientRect(),
    preview = host.getBoundingClientRect();
  const visual = window.visualViewport;
  const bottom =
    (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight);
  if (
    !(
      input.width > 0 &&
      input.height > 0 &&
      preview.width > 0 &&
      preview.top >= input.bottom - 0.5 &&
      preview.top < bottom - 40 &&
      preview.bottom <= bottom
    )
  )
    return false;
  for (
    let parent = host.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
      const bounds = parent.getBoundingClientRect();
      if (preview.top < bounds.top || preview.bottom > bounds.bottom)
        return false;
    }
  }
  return true;
}
// Only use a semantic footer containing the verified composer. Preserve native
// horizontal rows and put the preview on its own final line; never guess an ancestor.
export function placePreview(
  composer: HTMLElement,
  host: HTMLElement,
): (() => void) | null {
  const footer = composer.closest<HTMLElement>("footer");
  if (!footer || !footer.closest("#main")) return null;
  const rows = Array.from(footer.children).filter((el) => el !== host);
  if (!rows.length || !rows.some((row) => row.contains(composer))) return null;
  if (
    rows.some((row) =>
      ["absolute", "fixed"].includes(getComputedStyle(row).position),
    )
  )
    return null;
  const native = getComputedStyle(footer);
  const horizontal =
    native.display === "flex" &&
    ["row", "row-reverse"].includes(native.flexDirection);
  const direction = horizontal ? native.flexDirection : "column";
  const properties = [
    "display",
    "flex-direction",
    "flex-wrap",
    "align-items",
    "gap",
  ];
  const applied: Record<string, string> = {
    display: "flex",
    "flex-direction": direction,
    "flex-wrap": "wrap",
    "align-items": "stretch",
    gap: "0px",
  };
  const previous = properties.map((name) => [
    name,
    footer.style.getPropertyValue(name),
    footer.style.getPropertyPriority(name),
  ]);
  footer.style.setProperty("display", "flex", "important");
  footer.style.setProperty("flex-direction", direction, "important");
  footer.style.setProperty("flex-wrap", "wrap", "important");
  footer.style.setProperty("align-items", "stretch", "important");
  footer.style.setProperty("gap", "0", "important");
  host.style.cssText = `display:block!important;position:relative!important;order:2147483647!important;flex:0 0 ${horizontal ? "100%" : "auto"}!important;align-self:stretch!important;width:100%;min-width:0;min-height:1px;box-sizing:border-box;`;
  footer.appendChild(host);
  const cleanup = () => {
    host.remove();
    for (const [name, value, priority] of previous) {
      if (
        footer.style.getPropertyValue(name) !== applied[name] ||
        footer.style.getPropertyPriority(name) !== "important"
      )
        continue;
      if (value) footer.style.setProperty(name, value, priority);
      else footer.style.removeProperty(name);
    }
  };
  if (!previewIsBelow(composer, host)) {
    cleanup();
    return null;
  }
  return cleanup;
}

export function standalonePreviewPosition(
  input: { left: number; right: number; top: number; bottom: number },
  viewport: { left: number; top: number; width: number; height: number },
  contentHeight: number,
) {
  const margin = 12,
    gap = 8;
  const leftEdge = viewport.left + margin,
    topEdge = viewport.top + margin;
  const rightEdge = viewport.left + viewport.width - margin,
    bottomEdge = viewport.top + viewport.height - margin;
  const below = Math.max(0, bottomEdge - Math.max(topEdge, input.bottom + gap));
  const above = Math.max(0, Math.min(bottomEdge, input.top - gap) - topEdge);
  const desired = Math.min(240, Math.max(96, contentHeight));
  const side = below >= desired || below >= above ? "below" : "above";
  const maxHeight = Math.min(desired, side === "below" ? below : above);
  if (maxHeight < 40 || viewport.width < 64) return null;
  const width = Math.min(
    Math.max(340, input.right - input.left),
    Math.max(0, rightEdge - leftEdge),
  );
  return {
    left: Math.max(leftEdge, Math.min(input.left, rightEdge - width)),
    top:
      side === "below"
        ? Math.max(topEdge, input.bottom + gap)
        : Math.min(bottomEdge, input.top - gap) - maxHeight,
    width,
    maxHeight,
    side,
  };
}
export function refreshStandalonePreview(
  composer: HTMLElement,
  host: HTMLElement,
): boolean {
  if (!composer.isConnected || !host.isConnected) return false;
  const input = composer.getBoundingClientRect();
  if (!input.width || !input.height) return false;
  const visual = window.visualViewport;
  const position = standalonePreviewPosition(
    input,
    {
      left: visual?.offsetLeft ?? 0,
      top: visual?.offsetTop ?? 0,
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
    },
    host.scrollHeight,
  );
  if (!position) return false;
  host.style.left = `${position.left}px`;
  host.style.top = `${position.top}px`;
  host.style.width = `${position.width}px`;
  host.style.maxHeight = `${position.maxHeight}px`;
  host.dataset.side = position.side;
  const actual = host.getBoundingClientRect();
  return position.side === "below"
    ? actual.top >= input.bottom
    : actual.bottom <= input.top;
}
export function placeStandalonePreview(
  composer: HTMLElement,
  host: HTMLElement,
): (() => void) | null {
  // Independent extension container. Never infer a chat identity or mutate an
  // arbitrary WA ancestor merely to create space for a preview.
  host.dataset.previewMode = "floating";
  host.setAttribute("aria-label", "独立发送预览");
  host.style.cssText =
    "position:fixed!important;display:block!important;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;z-index:100000;";
  document.body.appendChild(host);
  if (!refreshStandalonePreview(composer, host)) {
    host.remove();
    return null;
  }
  return () => {
    host.remove();
    delete host.dataset.previewMode;
    delete host.dataset.side;
    host.removeAttribute("aria-label");
  };
}
