import { ensureDraftHost } from "../src/page/ui/mount";
import {
  installFloatingDrag,
  placePreview,
  previewIsBelow,
} from "../src/page/ui/floating-layout";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function runFloatingLayoutBrowserTests(): number {
  let count = 0;
  const main = document.createElement("main");
  main.id = "main";
  document.body.appendChild(main);
  main.innerHTML =
    '<footer style="display:flex;flex-direction:row-reverse;width:600px"><div style="order:99;width:100%;padding:8px"><div role="textbox" contenteditable="true" style="height:45px;background:#eee">Synthetic input</div></div></footer>';
  const composer = main.querySelector<HTMLElement>('[role="textbox"]')!;
  const footer = main.querySelector("footer")!;
  const originalDisplay = footer.style.display,
    originalDirection = footer.style.flexDirection;
  const preview = document.createElement("div");
  preview.innerHTML = '<div style="height:60px">Synthetic preview</div>';
  const cleanup = placePreview(composer, preview);
  assert(cleanup, "known single input row mounts");
  assert(
    previewIsBelow(composer, preview),
    "rendered preview is below composer",
  );
  assert(
    preview.getBoundingClientRect().top >=
      composer.getBoundingClientRect().bottom,
    "actual geometry, not DOM ordering",
  );
  count++;
  cleanup();
  assert(
    footer.style.display === originalDisplay &&
      footer.style.flexDirection === originalDirection &&
      !footer.style.alignItems &&
      !footer.style.gap,
    "footer styles restored",
  );
  footer.appendChild(document.createElement("div"));
  const multiCleanup = placePreview(composer, preview);
  assert(
    multiCleanup && previewIsBelow(composer, preview),
    "multiple normal-flow footer blocks supported",
  );
  composer.style.height = "100px";
  assert(
    preview.getBoundingClientRect().top >=
      composer.getBoundingClientRect().bottom,
    "multiline composer growth keeps preview below",
  );
  multiCleanup();
  main.innerHTML =
    '<div><div role="textbox" style="height:20px">Synthetic unknown wrapper</div></div>';
  assert(
    placePreview(
      main.querySelector<HTMLElement>('[role="textbox"]')!,
      preview,
    ) === null,
    "no arbitrary ancestor fallback",
  );
  count++;
  const host = document.createElement("div");
  host.id = "wa-translate-picker-host";
  host.style.cssText = "position:fixed;width:80px;height:40px;";
  host.innerHTML = '<button class="wa-translate-picker-btn">Translate</button>';
  document.body.appendChild(host);
  const button = host.querySelector("button")!;
  let captureCount = 0,
    releaseCount = 0;
  button.setPointerCapture = () => {
    captureCount++;
  };
  button.hasPointerCapture = () => true;
  button.releasePointerCapture = () => {
    releaseCount++;
  };
  const stop = installFloatingDrag(host, { x: 100, y: 100 });
  const pointer = (type: string, x: number, y: number) =>
    button.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 102, 102);
  pointer("pointerup", 102, 102);
  assert(host.style.left === "100px", "below 5px threshold stays put");
  assert(
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
    "ordinary tap remains clickable",
  );
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 130, 120);
  pointer("pointerup", 130, 120);
  assert(
    host.style.left === "130px" && host.style.top === "120px",
    "drag moves rendered host",
  );
  assert(
    !button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
    "drag suppresses generated click",
  );
  assert(
    captureCount === 2 && releaseCount === 2,
    "pointer capture acquired and released",
  );
  const position = host.style.left;
  stop();
  pointer("pointerdown", 130, 120);
  pointer("pointermove", 170, 180);
  assert(host.style.left === position, "cleanup removes drag listeners");
  host.remove();
  const next = document.createElement("div");
  next.style.cssText = "position:fixed;width:80px;height:40px";
  document.body.appendChild(next);
  const stopNext = installFloatingDrag(next, { x: 300, y: 300 });
  assert(
    next.style.left === "130px",
    "window-lifetime position survives remount",
  );
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 150,
  });
  window.dispatchEvent(new Event("resize"));
  assert(next.style.left === "58px", "resize reclamps saved position");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalWidth,
  });
  stopNext();
  next.remove();
  count++;
  main.innerHTML =
    '<footer><div style="transform:translateY(100px)"><div contenteditable="true" role="textbox" style="height:40px;width:200px">Synthetic shifted input</div></div></footer>';
  const unsafeFooter = main.querySelector("footer")!;
  let appends = 0;
  const append = unsafeFooter.appendChild.bind(unsafeFooter);
  unsafeFooter.appendChild = ((node: Node) => {
    appends++;
    return append(node);
  }) as typeof unsafeFooter.appendChild;
  let unsupported = false;
  const layout = (event: Event) => {
    unsupported = (event as CustomEvent).detail.available === false;
  };
  window.addEventListener("wa-translate:preview-layout", layout);
  const fallback = ensureDraftHost();
  assert(
    fallback &&
      fallback.parentElement === document.body &&
      fallback.dataset.previewMode === "floating",
    "unsafe inline geometry uses independent preview",
  );
  assert(
    ensureDraftHost() === fallback,
    "fallback host is stable across ticks",
  );
  assert(appends === 1, "failed inline placement is not retried on every tick");
  assert(!unsupported, "usable fallback reports available");
  fallback.remove();
  window.removeEventListener("wa-translate:preview-layout", layout);
  main.remove();
  count++;
  return count;
}
try {
  const count = runFloatingLayoutBrowserTests();
  document.body.setAttribute("data-layout-tests", `passed:${count}`);
} catch (error) {
  document.body.setAttribute(
    "data-layout-tests",
    `failed:${error instanceof Error ? error.message : "unknown"}`,
  );
}
