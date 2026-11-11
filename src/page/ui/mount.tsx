import { updatePreviewLayout } from "../capabilities";
import {
  installFloatingDrag,
  placePreview,
  previewIsBelow,
  placeStandalonePreview,
  refreshStandalonePreview,
} from "./floating-layout";
import { createDomScheduler, isOnlyOwnMutation } from "../dom-scheduler";
import { findComposer } from "../composer-dom";
// Mount our React roots into WhatsApp's DOM. We use our own bundled React (the page-world
// script ships with React via the Vite build); we don't share WA's React because pulling
// the right module name reliably across versions is fragile and a separate root is fine.

import { createRoot, type Root } from "react-dom/client";
import { StrictMode, useEffect, useState } from "react";
import { LanguagePicker } from "./LanguagePicker";
import { DraftPreview } from "./DraftPreview";
import { ModalPicker } from "./ModalPicker";
import { injectStyles } from "./styles";

const PICKER_HOST_ID = "wa-translate-picker-host";
const DRAFT_HOST_ID = "wa-translate-draft-host";
const MODAL_HOST_ID = "wa-translate-modal-host";

let pickerRoot: Root | null = null;
let pickerRootHost: HTMLElement | null = null;
let draftRoot: Root | null = null;
let draftRootHost: HTMLElement | null = null;
let modalRoot: Root | null = null;

let floatingCleanup: (() => void) | null = null;
let floatingHost: HTMLElement | null = null;
let previewCleanup: (() => void) | null = null;
let previewComposer: HTMLElement | null = null;
let failedPreview: {
  composer: HTMLElement;
  footer: HTMLElement | null;
} | null = null;
let layoutAvailable: boolean | null = null;
function reportLayout(available: boolean): void {
  if (available === layoutAvailable) return;
  layoutAvailable = available;
  updatePreviewLayout(available);
}
function ownLayoutMutation(record: MutationRecord): boolean {
  const owns = (node: Node) =>
    node instanceof Element &&
    !!node.closest(
      "#wa-translate-picker-host, #wa-translate-draft-host, #wa-translate-modal-host",
    );
  if (owns(record.target)) return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every(owns);
}

export function ensurePickerHost(): HTMLDivElement | null {
  const composer = findComposer();
  if (!composer) {
    if (floatingHost) floatingHost.style.display = "none";
    return floatingHost as HTMLDivElement | null;
  }
  let host = document.getElementById(PICKER_HOST_ID) as HTMLDivElement | null;
  if (!host) {
    host = document.createElement("div");
    host.id = PICKER_HOST_ID;
    host.style.cssText =
      "position:fixed;display:inline-flex;align-items:center;z-index:100002;max-width:calc(100vw - 24px);";
    document.body.appendChild(host);
  }
  host.style.display = "inline-flex";
  if (floatingHost !== host) {
    floatingCleanup?.();
    floatingHost = host;
    const rect = composer.getBoundingClientRect();
    floatingCleanup = installFloatingDrag(host, {
      x: window.innerWidth - 110,
      y: Math.max(12, rect.top - 54),
    });
  }
  return host;
}

export function ensureDraftHost(): HTMLDivElement | null {
  const composer = findComposer();
  let host = document.getElementById(DRAFT_HOST_ID) as HTMLDivElement | null;
  const footer = composer?.closest("footer");
  if (
    host &&
    composer === previewComposer &&
    host.dataset.previewMode === "floating" &&
    refreshStandalonePreview(composer!, host)
  ) {
    reportLayout(true);
    return host;
  }
  if (
    host &&
    composer === previewComposer &&
    host.parentElement === footer &&
    previewIsBelow(composer!, host)
  ) {
    reportLayout(true);
    return host;
  }
  if (
    composer &&
    failedPreview?.composer === composer &&
    failedPreview.footer === footer
  )
    return null;
  previewCleanup?.();
  previewCleanup = null;
  previewComposer = null;
  if (!composer) {
    reportLayout(false);
    return null;
  }
  host ??= document.createElement("div");
  host.id = DRAFT_HOST_ID;
  const cleanup =
    placePreview(composer, host) ?? placeStandalonePreview(composer, host);
  if (!cleanup) {
    failedPreview = { composer, footer: footer ?? null };
    reportLayout(false);
    return null;
  }
  failedPreview = null;
  reportLayout(true);
  previewCleanup = cleanup;
  previewComposer = composer;
  return host;
}

function PickerWrapper() {
  // Bump signal whenever the active chat may have changed (DOM mutations).
  const [signal, setSignal] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setSignal((n) => n + 1));
    const main = document.querySelector("#main");
    if (main) {
      obs.observe(main, { subtree: false, childList: true });
      const header = main.querySelector("header");
      if (header) obs.observe(header, { subtree: true, childList: true });
    }
    const interval = setInterval(() => setSignal((n) => n + 1), 1500);
    return () => {
      obs.disconnect();
      clearInterval(interval);
    };
  }, []);
  return <LanguagePicker chatIdSignal={signal} />;
}

function ensureModalHost(): HTMLDivElement {
  let host = document.getElementById(MODAL_HOST_ID) as HTMLDivElement | null;
  if (host) return host;
  host = document.createElement("div");
  host.id = MODAL_HOST_ID;
  document.body.appendChild(host);
  return host;
}

let mounted = false;
export function mountUI(): void {
  if (mounted) return;
  mounted = true;
  injectStyles();

  // Modal picker is global — mount once.
  if (!modalRoot) {
    modalRoot = createRoot(ensureModalHost());
    modalRoot.render(
      <StrictMode>
        <ModalPicker />
      </StrictMode>,
    );
  }

  let draftSizeObserver: ResizeObserver | null = null;
  let logged = false;
  const tick = () => {
    const composer = findComposer();
    if (!logged && composer) {
      console.info("[wa-translate] 输入框已定位");
      logged = true;
    }

    const pickerHost = ensurePickerHost();
    if (pickerHost !== pickerRootHost) {
      // Host is missing or replaced — re-mount.
      if (pickerRoot) {
        try {
          pickerRoot.unmount();
        } catch {}
        pickerRoot = null;
      }
      pickerRootHost = pickerHost;
      if (pickerHost) {
        pickerRoot = createRoot(pickerHost);
        pickerRoot.render(
          <StrictMode>
            <PickerWrapper />
          </StrictMode>,
        );
        console.info("[wa-translate] picker mounted");
      }
    }

    const draftHost = ensureDraftHost();
    if (draftHost !== draftRootHost) {
      draftSizeObserver?.disconnect();
      if (draftRoot) {
        try {
          draftRoot.unmount();
        } catch {}
        draftRoot = null;
      }
      draftRootHost = draftHost;
      if (draftHost) {
        draftRoot = createRoot(draftHost);
        draftRoot.render(
          <StrictMode>
            <DraftPreview />
          </StrictMode>,
        );
        draftSizeObserver?.observe(draftHost);
        console.info("[wa-translate] draft preview mounted");
      }
    }
  };

  tick();
  const scheduler = createDomScheduler(tick);
  draftSizeObserver = new ResizeObserver(() => scheduler.request());
  if (draftRootHost) draftSizeObserver.observe(draftRootHost);
  const mo = new MutationObserver((records) => {
    const external = records.filter(
      (record) => !isOnlyOwnMutation(record) && !ownLayoutMutation(record),
    );
    if (!external.length) return;
    if (
      failedPreview?.footer &&
      external.some((record) => failedPreview!.footer!.contains(record.target))
    )
      failedPreview = null;
    scheduler.request();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  const resized = () => {
    failedPreview = null;
    scheduler.request();
  };
  window.addEventListener("resize", resized);
  window.visualViewport?.addEventListener("resize", resized);
  window.visualViewport?.addEventListener("scroll", scheduler.request);
  window.addEventListener("scroll", scheduler.request, true);
  window.addEventListener(
    "pagehide",
    () => {
      mounted = false;
      draftSizeObserver?.disconnect();
      mo.disconnect();
      scheduler.cancel();
      window.removeEventListener("resize", resized);
      window.visualViewport?.removeEventListener("resize", resized);
      window.visualViewport?.removeEventListener("scroll", scheduler.request);
      window.removeEventListener("scroll", scheduler.request, true);
      pickerRoot?.unmount();
      draftRoot?.unmount();
      modalRoot?.unmount();
      floatingCleanup?.();
      floatingCleanup = null;
      floatingHost?.remove();
      floatingHost = null;
      previewCleanup?.();
      previewCleanup = null;
      previewComposer = null;
      failedPreview = null;
      layoutAvailable = null;
      pickerRoot = draftRoot = modalRoot = null;
      pickerRootHost = draftRootHost = null;
    },
    { once: true },
  );
}
