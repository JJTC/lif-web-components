/**
 * The editor's visual design: token definitions (light + dark, from the
 * validated reference palette) and the styling layer applied on top of the
 * structural base styles in lif-editor.ts. Later sheets win the cascade, so
 * every rule here overrides its structural counterpart.
 */

import { css } from "lit";

export const editorTheme = css`
  :host {
    --_surface: var(--lif-surface, #fcfcfb);
    --_raised: var(--lif-surface-raised, #f4f3ef);
    --_overlay: var(--lif-surface-overlay, #ffffff);
    --_ink: var(--lif-ink, #1c1b19);
    --_ink-2: var(--lif-ink-secondary, #52514e);
    --_muted: var(--lif-ink-muted, #898781);
    --_border: var(--lif-border, rgba(11, 11, 11, 0.12));
    --_border-strong: var(--lif-border-strong, rgba(11, 11, 11, 0.22));
    --_accent: var(--lif-accent, #2a78d6);
    --_accent-wash: color-mix(in srgb, var(--_accent) 13%, transparent);
    --_danger: var(--lif-danger, #d03b3b);
    --_warning: var(--lif-warning, #9a6b00);
    --_node: var(--lif-node-color, #2a78d6);
    --_station: var(--lif-station-color, #eda100);
    --_shadow: 0 10px 32px rgba(11, 11, 11, 0.18);

    border: 1px solid var(--_border);
    border-radius: 10px;
    background: var(--_raised);
    color: var(--_ink);
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  :host(:fullscreen) {
    border: none;
    border-radius: 0;
  }
  :host([theme="dark"]) {
    --_surface: var(--lif-surface, #1a1a19);
    --_raised: var(--lif-surface-raised, #232321);
    --_overlay: var(--lif-surface-overlay, #2c2c2a);
    --_ink: var(--lif-ink, #f2f1ec);
    --_ink-2: var(--lif-ink-secondary, #c3c2b7);
    --_muted: var(--lif-ink-muted, #8f8d85);
    --_border: var(--lif-border, rgba(255, 255, 255, 0.13));
    --_border-strong: var(--lif-border-strong, rgba(255, 255, 255, 0.26));
    --_accent: var(--lif-accent, #3987e5);
    --_danger: var(--lif-danger, #e05252);
    --_warning: var(--lif-warning, #fab219);
    --_node: var(--lif-node-color, #3987e5);
    --_station: var(--lif-station-color, #c98500);
    --_shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
  }

  /* ------------------------------- toolbar ------------------------------ */
  .toolbar {
    gap: 5px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--_border);
    background: var(--_raised);
  }
  .toolbar .group {
    display: inline-flex;
    align-items: stretch;
    gap: 1px;
    padding: 2px;
    background: var(--_surface);
    border: 1px solid var(--_border);
    border-radius: 9px;
  }
  .toolbar .sep {
    display: none;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-weight: 500;
    padding: 5px 9px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--_ink-2);
    cursor: pointer;
    transition:
      background 100ms ease,
      color 100ms ease;
  }
  button:hover:not(:disabled) {
    border-color: transparent;
    background: color-mix(in srgb, var(--_ink) 8%, transparent);
    color: var(--_ink);
  }
  button:disabled {
    opacity: 0.38;
    cursor: default;
  }
  button[aria-pressed="true"] {
    background: var(--_accent-wash);
    color: var(--_accent);
  }
  button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--_accent) 55%, transparent);
    outline-offset: 1px;
  }
  button svg {
    flex: none;
  }
  button.icon-only {
    padding: 5px 7px;
  }
  .toolbar label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--_muted);
    font-size: 12px;
  }

  /* ------------------------------ controls ------------------------------ */
  select,
  input,
  textarea {
    font: inherit;
    padding: 5px 8px;
    border: 1px solid var(--_border);
    border-radius: 7px;
    background: var(--_surface);
    color: var(--_ink);
    transition: border-color 100ms ease;
  }
  select:hover,
  input:hover,
  textarea:hover {
    border-color: var(--_border-strong);
  }
  select:focus-visible,
  input:focus-visible,
  textarea:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--_accent) 45%, transparent);
    outline-offset: 0;
    border-color: var(--_accent);
  }
  input[type="checkbox"] {
    accent-color: var(--_accent);
    width: 14px;
    height: 14px;
  }
  input[type="file"] {
    border: none;
    background: none;
    padding: 2px 0;
    color: var(--_ink-2);
  }

  /* ---------------------------- tool palette ---------------------------- */
  .tool-palette {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 5px;
    background: color-mix(in srgb, var(--_overlay) 92%, transparent);
    border: 1px solid var(--_border);
    border-radius: 13px;
    box-shadow: var(--_shadow);
    backdrop-filter: blur(8px);
  }
  .tool-palette button {
    justify-content: center;
    padding: 8px;
    border-radius: 8px;
  }
  .palette-sep {
    height: 1px;
    margin: 3px 5px;
    background: var(--_border);
  }
  .palette-sub {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 1px 0;
    padding: 3px;
    background: var(--_accent-wash);
    border-radius: 9px;
  }
  .palette-sub button {
    padding: 6px;
  }

  /* ------------------------------- canvas ------------------------------- */
  .hint {
    background: color-mix(in srgb, var(--_ink) 86%, transparent);
    color: var(--_surface);
    font-weight: 500;
    padding: 6px 14px;
    border-radius: 999px;
    box-shadow: var(--_shadow);
  }

  /* ------------------------------- sidebar ------------------------------ */
  .sidebar {
    background: var(--_raised);
    border-left: none;
  }
  .search-box {
    padding: 10px;
    border-bottom: 1px solid var(--_border);
  }
  .panel {
    padding: 12px;
    border-bottom: 1px solid var(--_border);
  }
  .panel h3,
  h3 {
    margin: 12px 0 8px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--_muted);
  }
  .panel > h3:first-child,
  [data-vehicle-section] > h3:first-child {
    margin-top: 0;
  }
  [data-vehicle-section] {
    margin-top: 14px;
    padding-top: 2px;
    border-top: 1px solid var(--_border);
  }
  .field label {
    color: var(--_muted);
    font-size: 12px;
  }
  .muted {
    color: var(--_muted);
    font-size: 12px;
  }
  .warn {
    color: var(--_warning);
    font-weight: 500;
  }
  .error {
    color: var(--_danger);
  }
  textarea.json {
    background: var(--_surface);
    color: var(--_ink);
    border-radius: 8px;
  }
  .action-row {
    border: 1px solid var(--_border);
    border-radius: 9px;
    background: var(--_surface);
    padding: 8px;
  }
  .sidebar button:not(.icon):not([data-action="apply-json"]) {
    border: 1px solid var(--_border);
    background: var(--_surface);
  }
  .sidebar button:hover:not(:disabled) {
    border-color: var(--_border-strong);
    background: color-mix(in srgb, var(--_ink) 6%, var(--_surface));
  }
  button[data-action="apply-json"] {
    border: 1px solid var(--_accent);
    background: var(--_accent);
    color: #fff;
    margin-top: 6px;
  }
  button[data-action="apply-json"]:hover:not(:disabled) {
    background: color-mix(in srgb, var(--_accent) 88%, #000);
    color: #fff;
  }

  /* search results */
  .search-results li {
    border-bottom: 1px solid var(--_border);
    transition: background 80ms ease;
  }
  .search-results li:hover {
    background: var(--_accent-wash);
  }
  .search-results .kind {
    background: var(--_muted);
  }
  .search-results .kind-node {
    background: var(--_node);
  }
  .search-results .kind-station {
    background: var(--_station);
    color: #221a00;
  }
  .search-results .layout-tag {
    color: var(--_muted);
  }

  /* diagnostics */
  .diagnostics li {
    border-bottom: 1px solid var(--_border);
    font-size: 12px;
  }
  .diagnostics .code {
    font-size: 10px;
  }
  .diagnostics .path {
    color: var(--_muted);
  }
  .severity-error .code {
    background: var(--_danger);
  }
  .severity-warning .code {
    background: #b97a00;
  }
  .severity-info .code {
    background: var(--_accent);
  }
  .badge {
    background: color-mix(in srgb, var(--_ink) 25%, transparent);
    color: var(--_ink);
    font-size: 11px;
    font-weight: 700;
    border-radius: 999px;
  }
  .badge.has-errors {
    background: var(--_danger);
    color: #fff;
  }

  /* ------------------------------ status bar ---------------------------- */
  .status {
    border-top: 1px solid var(--_border);
    background: var(--_raised);
    color: var(--_muted);
    font-size: 12px;
    padding: 5px 12px;
    gap: 10px;
  }
  .status span[data-stat] {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    background: var(--_surface);
    border: 1px solid var(--_border);
    border-radius: 999px;
    color: var(--_ink-2);
    white-space: nowrap;
  }
  .status button {
    border: 1px solid var(--_border);
    background: var(--_surface);
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 12px;
  }
  .status .stat-errors {
    color: var(--_danger);
  }
  .status .stat-warnings {
    color: var(--_warning);
  }

  /* ------------------------------- menus -------------------------------- */

  /* ------------------------------- dialogs ------------------------------ */
  .dialog-backdrop {
    background: rgba(9, 9, 8, 0.45);
    backdrop-filter: blur(3px);
  }
  .dialog {
    background: var(--_overlay);
    border: 1px solid var(--_border);
    border-radius: 14px;
    box-shadow: var(--_shadow);
    padding: 18px;
  }
  .dialog h2 {
    font-size: 15px;
    font-weight: 650;
    color: var(--_ink);
  }
  .dialog h4 {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    color: var(--_muted);
  }
  .dialog button {
    border: 1px solid var(--_border);
    background: var(--_surface);
  }
  .dialog button[data-action="save-layout"],
  .dialog button[data-action="generate-grid"] {
    border-color: var(--_accent);
    background: var(--_accent);
    color: #fff;
  }
  .dialog button[data-action="save-layout"]:hover,
  .dialog button[data-action="generate-grid"]:hover {
    background: color-mix(in srgb, var(--_accent) 88%, #000);
    color: #fff;
  }
  .dialog .danger {
    border-color: color-mix(in srgb, var(--_danger) 55%, transparent);
    color: var(--_danger);
    background: transparent;
  }
  .dialog .danger[data-confirm] {
    background: var(--_danger);
    border-color: var(--_danger);
    color: #fff;
  }

  /* ----------------------------- shortcuts ------------------------------ */
  .shortcut-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 7px 16px;
    align-items: baseline;
    font-size: 12.5px;
    color: var(--_ink-2);
  }
  .shortcut-grid .keys {
    white-space: nowrap;
    text-align: right;
  }
  kbd {
    display: inline-block;
    font: 600 11px ui-monospace, monospace;
    padding: 2px 6px;
    border: 1px solid var(--_border-strong);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: var(--_surface);
    color: var(--_ink);
  }

  /* ------------------------------- resizer ------------------------------ */
  .resizer {
    background: var(--_raised);
    border-left: 1px solid var(--_border);
    border-right: 1px solid var(--_border);
  }
  .resizer:hover,
  .resizer:focus-visible {
    background: var(--_accent);
    outline: none;
  }

  /* ------------------------------ scrollbars ---------------------------- */
  .sidebar::-webkit-scrollbar,
  .dialog::-webkit-scrollbar,
  .search-results::-webkit-scrollbar {
    width: 10px;
  }
  .sidebar::-webkit-scrollbar-thumb,
  .dialog::-webkit-scrollbar-thumb,
  .search-results::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--_ink) 18%, transparent);
    border-radius: 999px;
    border: 3px solid transparent;
    background-clip: content-box;
  }
`;
