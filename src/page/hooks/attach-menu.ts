import { serializedWid } from "../chat-id";
// Inject a "Translate" entry into WhatsApp's attach menu (the popup that opens when
// the user clicks the "+" button next to the composer).
//
// Strategy: monkey-patch React.createElement to detect when WhatsApp is creating an
// instance of WAWebAttachMenuPopup.react. We substitute a wrapper component that
// invokes the original popup's render function, then walks the returned React element
// tree to find the WDSMenu container and appends our extra menu item to its children.
//
// This reuses WhatsApp's own React, its WAWebAttachMenuPopupItem.react primitive, and
// its WDSIconIcLanguage.react icon, so the new entry is visually indistinguishable
// from native menu entries.

import { tryRequire } from "../wa";

const OPEN_PICKER_EVENT = "wa-translate:open-picker";

let installed = false;

export function installAttachMenuItem(): boolean {
  if (installed) return true;
  // Optional enhancement only. The DOM picker is the reliable entry point;
  // do not repeatedly require absent private modules and flood the console.
  return tryInstall();
}

function tryInstall(): boolean {
  if (installed) return true;
  const React = tryRequire<any>("react");
  const Popup = tryRequire<any>("WAWebAttachMenuPopup.react");
  const WDSMenu = tryRequire<any>("WDSMenu.react");
  const Item = tryRequire<any>("WAWebAttachMenuPopupItem.react");
  const Icon = tryRequire<any>("WDSIconIcLanguage.react");

  if (!React || !Popup || !WDSMenu || !Item || !Icon) {
    return false;
  }

  const origCreateElement = React.createElement.bind(React);

  function TranslateMenuItem(props: { chat: any }) {
    const open = () => {
      try {
        const chatId = serializedWid(props.chat?.id);
        window.dispatchEvent(
          new CustomEvent(OPEN_PICKER_EVENT, { detail: { chatId } }),
        );
      } catch (err) {
        console.warn("[wa-translate] 无法打开翻译面板");
      }
    };
    return origCreateElement(Item, {
      testid: "mi-attach-translate",
      action: () => {
        open();
        return true;
      },
      onPress: open,
      Icon,
      text: "收发翻译",
    });
  }

  function injectIntoTree(el: any, chat: any): any {
    if (!el || typeof el !== "object") return el;
    if (Array.isArray(el)) return el.map((c) => injectIntoTree(c, chat));
    if (!("type" in el) || !("props" in el)) return el;

    if (el.type === WDSMenu) {
      const existing = React.Children.toArray(el.props.children);
      const ours = origCreateElement(TranslateMenuItem, {
        chat,
        key: "wa-translate-item",
      });
      return React.cloneElement(el, undefined, ...existing, ours);
    }

    const children = el.props?.children;
    if (children == null) return el;
    const mapped = React.Children.map(children, (c: any) =>
      injectIntoTree(c, chat),
    );
    return React.cloneElement(el, undefined, mapped);
  }

  function WrappedPopup(props: any) {
    const tree = Popup(props);
    try {
      return injectIntoTree(tree, props.chat);
    } catch (err) {
      console.warn("[wa-translate] 附件菜单入口暂不可用");
      return tree;
    }
  }
  WrappedPopup.displayName = "WaTranslateAttachMenuWrapper";

  React.createElement = function (type: any, ...rest: any[]) {
    if (type === Popup) {
      return origCreateElement(WrappedPopup, ...rest);
    }
    return origCreateElement(type, ...rest);
  };

  installed = true;
  console.info("[wa-translate] attach-menu hook installed");
  return true;
}

export const ATTACH_MENU_OPEN_EVENT = OPEN_PICKER_EVENT;
