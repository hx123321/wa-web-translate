import assert from "node:assert/strict";
import {
  pickerPosition,
  isInsidePicker,
  trackPicker,
} from "../src/page/ui/picker-position";
export async function runPickerTests(): Promise<number> {
  for (const viewport of [
    { left: 0, top: 0, width: 1280, height: 800 },
    { left: 0, top: 0, width: 320, height: 320 },
    { left: 40, top: 70, width: 300, height: 210 },
  ]) {
    for (const x of [viewport.left, viewport.left + viewport.width - 40]) {
      for (const y of [
        viewport.top + 10,
        viewport.top + viewport.height - 40,
      ]) {
        const p = pickerPosition(
          { left: x, right: x + 40, top: y, bottom: y + 30 },
          viewport,
        );
        assert(p.left >= viewport.left + 12);
        assert(p.top >= viewport.top + 12);
        assert(p.left + p.width <= viewport.left + viewport.width - 12);
        assert(p.top + p.height <= viewport.top + viewport.height - 12);
      }
    }
  }
  const normal = pickerPosition(
    { left: 100, right: 180, top: 700, bottom: 730 },
    { left: 0, top: 0, width: 1280, height: 800 },
  );
  assert.equal(normal.side, "above");
  assert.equal(normal.left, 100);
  assert.equal(normal.top + normal.height, 692);
  const low = pickerPosition(
    { left: 100, right: 180, top: 20, bottom: 50 },
    { left: 0, top: 0, width: 1280, height: 800 },
  );
  assert.equal(low.side, "below");
  console.log(
    "PASS Picker geometry stays in viewport at edges, narrow screens and visual offsets",
  );
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    raf: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
    mutation: globalThis.MutationObserver,
    resize: globalThis.ResizeObserver,
  };
  const handlers = new Map<string, Function>();
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0,
    closed = 0,
    placed = 0,
    focused = 0,
    disconnected = 0;
  const target = (prefix: string) => ({
    addEventListener: (n: string, f: Function) => handlers.set(prefix + n, f),
    removeEventListener: (n: string) => handlers.delete(prefix + n),
  });
  const insideButton = {},
    insidePanel = {},
    outside = {};
  const anchor = {
    isConnected: true,
    contains: (node: any) => node === insideButton,
    focus: () => focused++,
  } as any;
  const panel = {
    isConnected: true,
    contains: (node: any) => node === insidePanel,
  } as any;
  try {
    (globalThis as any).document = { ...target("doc:"), body: {} };
    (globalThis as any).window = {
      ...target("win:"),
      visualViewport: target("visual:"),
    };
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.set(++next, cb);
      return next;
    }) as any;
    globalThis.cancelAnimationFrame = ((id: number) =>
      frames.delete(id)) as any;
    (globalThis as any).MutationObserver = class {
      constructor(cb: Function) {
        handlers.set("mutation", cb);
      }
      observe() {}
      disconnect() {
        disconnected++;
        handlers.delete("mutation");
      }
    };
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {
        disconnected++;
      }
    };
    assert(isInsidePicker(insidePanel as Node, anchor, panel));
    assert(!isInsidePicker(outside as Node, anchor, panel));
    const stop = trackPicker(
      anchor,
      panel,
      () => placed++,
      () => closed++,
    );
    assert.equal(placed, 1);
    handlers.get("doc:mousedown")!({ target: insideButton });
    handlers.get("doc:mousedown")!({ target: insidePanel });
    assert.equal(closed, 0);
    handlers.get("doc:mousedown")!({ target: outside });
    assert.equal(closed, 1);
    handlers.get("doc:keydown")!({ key: "Escape" });
    assert.equal(closed, 2);
    assert.equal(focused, 1);
    for (let i = 0; i < 100; i++) handlers.get("win:scroll")!();
    assert.equal(frames.size, 1);
    const frame = [...frames.values()][0];
    frames.clear();
    frame(0);
    assert.equal(placed, 2);
    anchor.isConnected = false;
    handlers.get("mutation")!();
    const detached = [...frames.values()][0];
    frames.clear();
    detached(0);
    assert.equal(closed, 3);
    handlers.get("win:resize")!();
    stop();
    assert.equal(frames.size, 0);
    assert.equal(handlers.size, 0);
    assert.equal(disconnected, 2);
  } finally {
    Object.assign(globalThis, {
      window: saved.window,
      document: saved.document,
      requestAnimationFrame: saved.raf,
      cancelAnimationFrame: saved.cancel,
      MutationObserver: saved.mutation,
      ResizeObserver: saved.resize,
    });
  }
  console.log(
    "PASS Portal interaction tracks anchor and panel, coalesces layout, closes and cleans listeners",
  );
  return 2;
}
