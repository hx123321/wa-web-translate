// Inject a single <style> tag with all of our in-page CSS so we don't fight WhatsApp's
// stylesheets and don't depend on a CSS bundler in the page world.

const STYLE_ID = "wa-translate-styles";

const CSS = `
#wa-translate-draft-host[data-preview-mode="floating"]:has(.wa-translate-draft) { background:#24343d; color:#fff; border:1px solid #667781; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.45); }
#wa-translate-draft-host[data-preview-mode="floating"]:has(.wa-translate-draft)::before { content:"独立发送预览 · 自动避开输入框"; display:block; padding:8px 12px 0; font:12px system-ui,sans-serif; }
#wa-translate-draft-host[data-preview-mode="floating"] .wa-translate-draft { margin:8px; max-height:none; overflow:visible; }

.wa-translate-panel-tabs { display:flex; gap:8px; padding:0 12px 8px; border-bottom:1px solid #667781; flex-shrink:0; }
.wa-translate-panel-tabs button { flex:1; padding:8px 12px; color:inherit; background:transparent; border:1px solid transparent; border-radius:8px; cursor:pointer; font:inherit; }
.wa-translate-panel-tabs button[aria-selected="true"] { background:#005c4b; border-color:#00a884; font-weight:600; }
.wa-translate-panel-tabs button:focus-visible { outline:2px solid #00a884; outline-offset:2px; }
.wa-translate-tab-panel { flex:1; min-height:0; overflow:auto; padding:8px 0; }
.wa-translate-tab-panel[hidden] { display:none!important; }
.wa-translate-tab-panel > p { margin:6px 12px; }
.wa-translate-tab-panel h3 { font-size:13px; margin:4px 0 12px; }
.wa-translate-tab-panel textarea { box-sizing:border-box; width:100%; min-height:100px; color:inherit; background:rgba(0,0,0,0.18); border:1px solid #667781; border-radius:8px; }

.wa-translate-picker-host {
  display: inline-flex;
  align-items: center;
  margin-right: 6px;
  position: relative;
  z-index: 10;
}
.wa-translate-picker-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 18px;
  background: rgba(0, 0, 0, 0);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 120ms ease;
  user-select: none;
  font-family: inherit;
}
.wa-translate-picker-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}
.wa-translate-picker-btn[data-active="true"] {
  background: rgba(0, 168, 132, 0.18);
  color: #fff;
  border-color: rgba(0, 168, 132, 0.35);
}
.wa-translate-picker-pop {
  position: fixed;
  box-sizing: border-box;
  overflow: auto;
  overscroll-behavior: contain;
  background: #24343d;
  color: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  z-index: 100001;
  font-family: system-ui, sans-serif;
  font-size: 13px;
  text-align: left;
}
.wa-translate-picker-search {
  appearance: none;
  border: none;
  background: rgba(0, 0, 0, 0.18);
  color: inherit;
  padding: 10px 12px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
}
.wa-translate-picker-list {
  overflow: auto;
  padding: 4px 0;
}
.wa-translate-picker-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
}
.wa-translate-picker-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.wa-translate-picker-item[data-selected="true"] {
  color: #fff;
}
.wa-translate-picker-clear {
  padding: 8px 12px;
  font-size: 12px;
  opacity: 0.7;
  cursor: pointer;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.wa-translate-picker-clear:hover { opacity: 1; }

.wa-translate-draft {
  position: relative;
  margin: 4px 12px;
  max-height: 160px;
  overflow: auto;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(0, 168, 132, 0.35);
  border-radius: 10px;
  color: #e9edef;
  font-size: 13px;
  line-height: 1.35;
  white-space: pre-wrap;
  pointer-events: auto;
  z-index: 50;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}
.wa-translate-draft[data-empty="true"] { display: none; }
.wa-translate-draft-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.wa-translate-draft button { color: #fff; background: #24343d; border: 1px solid #667781; cursor: pointer; }
.wa-translate-draft-heading button { color: #fff; background: transparent; border: 0; flex-shrink: 0; cursor: pointer; }
.wa-translate-draft-row { display: flex; gap: 4px; overflow-wrap: anywhere; }
.wa-translate-draft-row strong { flex-shrink: 0; }
.wa-translate-draft-label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #fff;
  margin-bottom: 2px;
  opacity: 0.85;
}
.wa-translate-draft-loading::after {
  content: '...';
  animation: wa-translate-blink 1s steps(3, end) infinite;
}
@keyframes wa-translate-blink {
  0% { content: ''; }
  33% { content: '.'; }
  66% { content: '..'; }
  100% { content: '...'; }
}
.wa-translate-draft-error {
  color: #f15c6d;
}

.wa-translate-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 100000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.wa-translate-modal-card {
  width: 380px;
  max-width: 100%;
  background: #1f2c33;
  color: #e9edef;
  border-radius: 12px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
}
.wa-translate-modal-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 16px 8px;
}
.wa-translate-modal-sub {
  font-size: 12px;
  color: #8696a0;
}
.wa-translate-modal-search {
  appearance: none;
  border: none;
  margin: 0 12px 8px;
  padding: 9px 12px;
  background: rgba(0, 0, 0, 0.25);
  color: inherit;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  outline: none;
}
.wa-translate-modal-search:focus {
  box-shadow: 0 0 0 2px rgba(0, 168, 132, 0.35);
}
.wa-translate-modal-list {
  max-height: min(420px, 65vh);
  overflow: auto;
  padding: 4px 0;
}
.wa-translate-modal-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
}
.wa-translate-modal-item:hover { background: rgba(255, 255, 255, 0.06); }
.wa-translate-modal-item[data-selected="true"] { color: #00a884; }
.wa-translate-modal-clear {
  padding: 12px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
  opacity: 0.7;
  cursor: pointer;
}
.wa-translate-modal-clear:hover { opacity: 1; }

.wa-translate-incoming {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.18);
  font-style: italic;
  opacity: 0.86;
  font-size: 0.92em;
  white-space: pre-wrap;
}
.wa-translate-incoming::before {
  content: '↳ ';
  opacity: 0.5;
}

.wa-translate-diagnostics { color: #fff; flex: 0 0 auto; margin: 4px 10px; }
.wa-translate-diagnostics ol { max-height: 110px; overflow: auto; padding-left: 22px; font-size: 11px; }
.wa-translate-diagnostics button { color: #fff; background: #24343d; border: 1px solid #667781; }
.wa-translate-direction-panel { color: #fff; padding: 10px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.wa-translate-picker-pop > p { margin: 6px 10px; flex-shrink: 0; }
.wa-translate-picker-pop .wa-translate-direction-panel { flex: 1 0 260px; }
.wa-translate-picker-btn[data-warning="true"] { border-color: #ffbf69; color: #fff; }
.wa-translate-picker-btn:focus-visible { outline: 2px solid #00a884; outline-offset: 2px; }
.wa-translate-status-details, .wa-translate-diagnostics li, .wa-translate-diagnostics p { min-width: 0; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; line-height: 1.5; }
.wa-translate-status-details { user-select: text; }
.wa-translate-status-details p { margin: 8px 0; }
.wa-translate-picker-close { align-self: flex-end; color: inherit; background: transparent; border: 0; padding: 6px 10px; cursor: pointer; flex-shrink: 0; }
.wa-translate-picker-pop .wa-translate-picker-list { min-height: 60px; flex: 1 1 auto; }
.wa-translate-direction-panel p { font-size: 12px; margin: 5px 0; }
.wa-translate-direction-panel button { color: #fff; background: transparent; border: 1px solid #667781; cursor: pointer; padding: 6px; }
.wa-translate-direction-panel button[aria-pressed="true"] { background: #005c4b; }
.wa-translate-direction-tabs { display: flex; gap: 8px; }
.wa-translate-direction-panel .wa-translate-picker-item { width: 100%; display: flex; justify-content: space-between; text-align: left; }
.wa-translate-direction-panel .wa-translate-picker-list { max-height: 230px; overflow: auto; }
`;

export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}
