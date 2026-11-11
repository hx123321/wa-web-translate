import { injectStyles } from "../src/page/ui/styles";
import { createRoot } from "react-dom/client";
import { LanguagePicker } from "../src/page/ui/LanguagePicker";
import {
  installFloatingDrag,
  FLOATING_DRAG_START,
} from "../src/page/ui/floating-layout";
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function run() {
  injectStyles();
  window.require = () => ({
    Chat: {
      findFirst: () => ({ active: true, id: { _serialized: "100@c.us" } }),
    },
  });
  const host = document.createElement("div");
  host.id = "wa-translate-picker-host";
  host.style.cssText = "position:fixed;width:100px;height:40px";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<LanguagePicker chatIdSignal={0} />);
  await settle();
  const button = host.querySelector<HTMLButtonElement>(
    ".wa-translate-picker-btn",
  )!;
  assert(button && !button.disabled, "synthetic trusted chat enables entry");
  button.setPointerCapture = () => {};
  button.hasPointerCapture = () => true;
  button.releasePointerCapture = () => {};
  const cleanup = installFloatingDrag(host, { x: 400, y: 200 });
  let starts = 0;
  const started = () => {
    starts++;
  };
  window.addEventListener(FLOATING_DRAG_START, started);
  const pointer = (name: string, x: number, y: number) =>
    button.dispatchEvent(
      new PointerEvent(name, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  try {
    pointer("pointerdown", 400, 200);
    pointer("pointermove", 402, 202);
    pointer("pointerup", 402, 202);
    button.click();
    await settle();
    let panel = document.getElementById("wa-translate-picker-pop");
    assert(
      panel && panel.parentElement === document.body,
      "ordinary non-drag click opens real portal",
    );
    assert(starts === 0, "subthreshold gesture emits no drag-start");
    const settingsTab = document.getElementById("wa-tab-settings")!;
    const logsTab = document.getElementById("wa-tab-logs")!;
    assert(
      settingsTab.getAttribute("aria-selected") === "true",
      "settings is default tab",
    );
    assert(
      document.getElementById("wa-panel-logs")!.hidden,
      "logs do not crowd settings",
    );
    settingsTab.focus();
    settingsTab.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    assert(
      document.activeElement === logsTab &&
        logsTab.getAttribute("aria-selected") === "true",
      "End selects and focuses logs tab",
    );
    assert(
      document.getElementById("wa-panel-settings")!.hidden,
      "settings hidden on logs tab",
    );
    const copy = Array.from(panel!.querySelectorAll("button")).find(
      (el) => el.textContent === "复制脱敏日志",
    )!;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Synthetic permission denial");
        },
      },
    });
    copy.click();
    await settle();
    const text = panel!.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="可复制脱敏日志"]',
    );
    assert(
      text?.readOnly && text.value.includes("WA翻译阶段日志"),
      "failed clipboard exposes safe manual-copy text",
    );
    assert(
      !text.value.includes("100@c.us"),
      "copy does not contain synthetic chat identity",
    );
    logsTab.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Home",
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    assert(
      document.activeElement === settingsTab &&
        settingsTab.getAttribute("aria-selected") === "true",
      "Home returns focus and selected settings tab",
    );
    pointer("pointerdown", 400, 200);
    pointer("pointermove", 402, 202);
    await settle();
    assert(
      document.getElementById("wa-translate-picker-pop"),
      "small move does not close expanded panel",
    );
    pointer("pointermove", 406, 200);
    await settle();
    assert(
      !document.getElementById("wa-translate-picker-pop"),
      "crossing threshold closes actual expanded portal",
    );
    pointer("pointermove", 420, 220);
    pointer("pointerup", 420, 220);
    button.click();
    await settle();
    assert(
      !document.getElementById("wa-translate-picker-pop"),
      "drag-generated click cannot reopen portal",
    );
    assert(Number(starts) === 1, "drag-start emitted once per gesture");
    await new Promise((resolve) => setTimeout(resolve, 550));
    button.click();
    await settle();
    assert(
      document.getElementById("wa-translate-picker-pop"),
      "later ordinary click opens panel normally",
    );
    button.click();
    await settle();
    assert(
      !document.getElementById("wa-translate-picker-pop"),
      "ordinary click retains normal toggle close",
    );
  } finally {
    window.removeEventListener(FLOATING_DRAG_START, started);
    cleanup();
    root.unmount();
    host.remove();
  }
  return 1;
}
run()
  .then((count) =>
    document.body.setAttribute("data-picker-drag-tests", `passed:${count}`),
  )
  .catch((error) =>
    document.body.setAttribute(
      "data-picker-drag-tests",
      `failed:${error.message}`,
    ),
  );
