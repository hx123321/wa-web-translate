import { updateCapabilities } from "./capabilities";
// Main-world entry point. Loaded into web.whatsapp.com as a module via the content script.
// No telemetry or fingerprint modifications are installed.

import { installCapabilities, tryRequire } from "./wa";
import { installSendHook } from "./hooks/send";
import { installComposerObserver } from "./hooks/composer";
import { installIncomingAnnotations } from "./hooks/incoming-annotations";
import { installAttachMenuItem } from "./hooks/attach-menu";
import { mountUI } from "./ui/mount";
import { requestSnapshot } from "./store";

console.info("[wa-translate] 页面脚本已启动");
requestSnapshot();
mountUI();
installComposerObserver();
let previousStatus = "";
let optionalMenuAttempted = false;
const stop = installCapabilities({
  send: () => {
    const module = tryRequire("WAWebSendTextMsgChatAction");
    if (
      !module ||
      (typeof module.sendTextMsgToChat !== "function" &&
        typeof module.addAndSendTextMsg !== "function")
    )
      return false;
    return installSendHook().length > 0;
  },
  incoming: installIncomingAnnotations,
  status: (status) => {
    const key = JSON.stringify(status);
    if (key !== previousStatus) {
      previousStatus = key;
      updateCapabilities(status);
      console.info("[wa-translate] 翻译兼容状态", status);
    }
    if (!optionalMenuAttempted && (status.send || status.incoming)) {
      optionalMenuAttempted = true;
      installAttachMenuItem();
    }
  },
});
window.addEventListener("pagehide", stop, { once: true });
