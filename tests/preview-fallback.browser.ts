import { mountUI, ensureDraftHost } from "../src/page/ui/mount";
import { installComposerObserver } from "../src/page/hooks/composer";
import { DEFAULT_CONFIG, publicConfig } from "../src/shared/types";
import { refreshStandalonePreview } from "../src/page/ui/floating-layout";
const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function run() {
  window.require = () => ({
    Chat: {
      findFirst: () => ({ active: true, id: { _serialized: "100@c.us" } }),
    },
  });
  document.body.innerHTML =
    '<main id="main"><section style="position:fixed;bottom:12px;left:20px;right:20px"><div contenteditable="true" role="textbox" style="height:48px;background:#eee">Synthetic input</div></section></main>';
  const input = document.querySelector<HTMLElement>('[role="textbox"]')!;
  let requests = 0;
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.kind === "TRANSLATE_REQUEST") {
      requests++;
      window.postMessage(
        {
          __waTrans: true,
          kind: "TRANSLATE_RESULT",
          id: e.data.id,
          ok: true,
          result: {
            translated: "Synthetic translated text",
            source: "en",
            target: "fr",
          },
        },
        "*",
      );
    }
  });
  window.postMessage(
    {
      __waTransStore: true,
      kind: "STORE_PUSH",
      config: publicConfig(DEFAULT_CONFIG),
      chatLangs: { "100@c.us": { incoming: null, outgoing: "fr" } },
    },
    "*",
  );
  await wait();
  mountUI();
  installComposerObserver();
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await wait(300);
  const host = document.getElementById("wa-translate-draft-host")!;
  assert(
    host?.dataset.previewMode === "floating",
    "non-footer composer gets usable independent host",
  );
  assert(
    host
      .querySelector(".wa-translate-draft")
      ?.textContent?.includes("Synthetic translated text"),
    "real Alt+Enter opens React translation preview",
  );
  assert(
    host.getBoundingClientRect().height > 0,
    "preview is visibly rendered",
  );
  assert(
    host.getBoundingClientRect().bottom <= input.getBoundingClientRect().top,
    "bottom-edge composer uses above fallback without overlap",
  );
  assert(host.getBoundingClientRect().top >= 12, "fallback stays in viewport");
  input.style.height = "120px";
  window.dispatchEvent(new Event("resize"));
  await wait();
  assert(
    host.getBoundingClientRect().bottom <= input.getBoundingClientRect().top,
    "multiline resize maintains nonoverlap",
  );
  const area = input.parentElement!;
  area.style.bottom = "auto";
  area.style.top = "20px";
  window.dispatchEvent(new Event("resize"));
  await wait();
  assert(
    host.dataset.side === "below" &&
      host.getBoundingClientRect().top >= input.getBoundingClientRect().bottom,
    "prefers below when there is available space",
  );
  assert(
    ensureDraftHost() === host,
    "repeated tick preserves active React root",
  );
  const entry = document.querySelector<HTMLElement>(
    ".wa-translate-picker-btn",
  )!;
  const entryRect = entry.getBoundingClientRect();
  assert(
    entryRect.width > 0 && entryRect.height > 0,
    "floating entry remains visible with preview",
  );
  assert(
    refreshStandalonePreview(input, host),
    "explicit geometry refresh retains safe placement",
  );
  const close = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "关闭",
  )!;
  close.click();
  await wait();
  assert(
    !host.querySelector(".wa-translate-draft"),
    "close exits active preview through existing behavior",
  );
  assert(requests === 1, "layout changes never resend text");
  window.dispatchEvent(new Event("pagehide"));
  assert(
    !document.getElementById("wa-translate-draft-host"),
    "pagehide detaches standalone host and listeners",
  );
  return 1;
}
run()
  .then((count) =>
    document.body.setAttribute("data-preview-tests", `passed:${count}`),
  )
  .catch((error) =>
    document.body.setAttribute("data-preview-tests", `failed:${error.message}`),
  );
