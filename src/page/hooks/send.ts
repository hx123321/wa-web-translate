import { recordOutgoingDiagnostic } from "../outgoing-diagnostics";
import { serializedWid } from "../chat-id";
// Hook the outgoing-text-message send so we can replace the body with a translation
// (and optionally include the original) before WhatsApp encodes/transmits it.
//
// The exact module/function name has shifted across WhatsApp Web versions. We try a
// list of known candidates and install on the first one we find. If all of them are
// missing, we log and fall back to a no-op.

import { showSendError, sessions, draftContext } from "./composer";
import { tryRequire } from "../wa";
import { getChatLang, getConfig } from "../store";

interface Candidate {
  module: string;
  function: string;
  bodyArgIndex: number;
  chatArgIndex: number;
}

// Verified live against current WhatsApp Web (compose flow in WAWebComposeBox.react):
//   o("WAWebSendTextMsgChatAction").sendTextMsgToChat(chat, body, options)
//   o("WAWebNewsletterSendMsgAction").sendNewsletterTextMsg(chat, body, options)
const CANDIDATES: Candidate[] = [
  {
    module: "WAWebSendTextMsgChatAction",
    function: "sendTextMsgToChat",
    bodyArgIndex: 1,
    chatArgIndex: 0,
  },
  {
    module: "WAWebNewsletterSendMsgAction",
    function: "sendNewsletterTextMsg",
    bodyArgIndex: 1,
    chatArgIndex: 0,
  },
  // Fallbacks if WhatsApp renames in the future:
  {
    module: "WAWebSendTextMsgChatAction",
    function: "addAndSendTextMsg",
    bodyArgIndex: 1,
    chatArgIndex: 0,
  },
];

export function installSendHook(): Array<{ module: string; function: string }> {
  const installed: Array<{ module: string; function: string }> = [];
  for (const c of CANDIDATES) {
    const mod = tryRequire(c.module);
    if (!mod || typeof mod[c.function] !== "function") continue;
    const orig = mod[c.function].bind(mod);
    mod[c.function] = async (...args: any[]) => {
      recordOutgoingDiagnostic("send_triggered");
      let next: any[];
      try {
        next = maybeRewrite(args, c);
      } catch {
        recordOutgoingDiagnostic("send_blocked");
        showSendError();
        throw new Error("Translation failed; message not sent.");
      }
      // Sending itself is never retried, including asynchronous send failures.
      recordOutgoingDiagnostic("wa_send_started");
      let result: unknown;
      try {
        result = await orig(...next);
        recordOutgoingDiagnostic("wa_send_resolved");
      } catch (error) {
        recordOutgoingDiagnostic("wa_send_failed");
        throw error;
      }
      const chatId = serializedWid(args[c.chatArgIndex]?.id);
      if (chatId && typeof args[c.bodyArgIndex] === "string")
        sessions.sent(
          chatId,
          args[c.bodyArgIndex].trim().replace(/\u00a0/g, " "),
        );
      return result;
    };
    installed.push({ module: c.module, function: c.function });
    console.info(
      `[wa-translate] send hook installed on ${c.module}.${c.function}`,
    );
  }
  if (installed.length === 0) {
    console.warn(
      "[wa-translate] no candidate send module found; outbound translation disabled",
    );
  }
  return installed;
}

function maybeRewrite(args: any[], c: Candidate): any[] {
  const config = getConfig();

  const chat = args[c.chatArgIndex];
  const chatId = serializedWid(chat?.id);
  if (!chatId) {
    recordOutgoingDiagnostic("send_identity_unknown");
    return args;
  }

  const targetLang = getChatLang(chatId);
  const body = args[c.bodyArgIndex];
  if (typeof body !== "string" || !body.trim()) {
    recordOutgoingDiagnostic("send_body_unsupported");
    return args;
  }
  if (!config.enabled) {
    if (sessions.read(chatId).activated)
      throw new Error("Close the activated draft before sending original text");
    recordOutgoingDiagnostic("send_original");
    return args;
  }
  const result = sessions.forSend(
    chatId,
    body.trim().replace(/ /g, " "),
    targetLang,
    draftContext(),
  );
  if (!result) {
    recordOutgoingDiagnostic("send_original");
    return args; // Unactivated drafts always use ordinary WhatsApp sending.
  }
  recordOutgoingDiagnostic("send_translation_ready");
  let finalBody = result.translated;
  if (config.sendBoth && result.translated.trim() !== body.trim())
    finalBody = `${result.translated}\n-----\n${body}`;
  const next = args.slice();
  next[c.bodyArgIndex] = finalBody;
  return next;
}
