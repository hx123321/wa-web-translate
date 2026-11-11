import { installIncomingHoverAction } from "../src/page/hooks/incoming-hover";
import {
  showIncomingText,
  incomingTextAnchor,
} from "../src/page/hooks/incoming-text";
import { getConfig, setChatLang } from "../src/page/store";
function assert(ok: unknown, label: string) {
  if (!ok) throw Error(label);
}
(async () => {
  let active = "100@c.us",
    calls = 0;
  const sent: string[] = [];
  const msg = {
    id: {
      _serialized: "false_100@c.us_SYNTHETIC",
      id: "SYNTHETIC",
      remote: { _serialized: "100@c.us" },
      fromMe: false,
    },
    type: "chat",
    body: "ORIGINAL",
  };
  window.require = (() => ({
    Chat: { findFirst: () => ({ active: true, id: { _serialized: active } }) },
    Msg: { get: () => msg },
  })) as any;
  getConfig().enabled = true;
  setChatLang(active, "zh-CN", "incoming");
  document.body.innerHTML =
    '<main id="main"><div data-id="false_100@c.us_SYNTHETIC" style="position:absolute;left:50px;top:100px;width:300px;height:100px"><div class="copyable-text"><span class="selectable-text">ORIGINAL</span></div></div></main>';
  const row = document.querySelector<HTMLElement>("[data-id]")!,
    text = row.querySelector<HTMLElement>(".selectable-text")!;
  let click: ((event: any) => void) | undefined;
  const original = HTMLElement.prototype.addEventListener;
  HTMLElement.prototype.addEventListener = function (
    type: any,
    listener: any,
    options: any,
  ) {
    if (type === "click" && this.className === "wa-translate-hover-action")
      click = listener;
    return original.call(this, type, listener, options);
  };
  const stop = installIncomingHoverAction({
    getModel: () => msg,
    select: (m) => {
      calls++;
      sent.push(String(m.body));
      return true;
    },
  });
  try {
    text.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    assert(
      !document.querySelector(".wa-translate-hover-action"),
      "no guessed anchor",
    );
    const reaction = document.createElement("div");
    reaction.setAttribute("role", "button");
    reaction.dataset.testid = "reaction-entry-point";
    reaction.style.cssText =
      "width:26px;height:26px;border-radius:50%;position:absolute;left:300px;top:0";
    row.append(reaction);
    await new Promise((r) => setTimeout(r, 100));
    const button = document.querySelector<HTMLButtonElement>(
      ".wa-translate-hover-action",
    );
    assert(
      button && button.textContent === "译",
      "late native anchor creates circular action",
    );
    assert(
      parseFloat(button!.style.left) > reaction.getBoundingClientRect().right,
      "action follows reaction without parent relayout",
    );
    button!.click();
    assert(calls === 0, "programmatic click cannot translate");
    click!({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
    const note = showIncomingText(row, "TRANSLATED");
    assert(note.connected(), "note mounted within original text bubble");
    assert(
      text.nextElementSibling?.textContent === "TRANSLATED",
      "original above plain translation without language labels",
    );
    assert(msg.body === "ORIGINAL", "model unchanged");
    click!({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
    assert(
      sent.join("|") === "ORIGINAL|ORIGINAL",
      "manual repeat reads original, never combined DOM",
    );
    button!.focus();
    reaction.remove();
    await new Promise((r) => setTimeout(r, 100));
    assert(
      document.querySelector(".wa-translate-hover-action"),
      "own focus preserves action if native hover leaves",
    );
    row.dataset.id = "false_200@c.us_SYNTHETIC";
    await new Promise((r) => setTimeout(r, 100));
    assert(
      !document.querySelector(".wa-translate-hover-action"),
      "recycled identity removes stale button",
    );
    row.dataset.id = msg.id._serialized;
    active = "200@c.us";
    text.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    assert(
      !document.querySelector(".wa-translate-hover-action"),
      "cross chat cannot reuse old row",
    );
    const duplicate = text.cloneNode(true);
    text.parentElement!.appendChild(duplicate);
    assert(
      incomingTextAnchor(row) === null,
      "ambiguous original anchors refused",
    );
    stop();
    assert(
      !document.querySelector(".wa-translate-hover-action"),
      "cleanup removes action",
    );
    document.body.textContent =
      "PASS incoming text and hover synthetic DOM checks";
  } finally {
    stop();
    HTMLElement.prototype.addEventListener = original;
  }
})().catch((error) => (document.body.textContent = "FAIL " + error.message));
