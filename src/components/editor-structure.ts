/**
 * Structural layout for <lif-editor>: grid areas, positioning, sizing, and
 * element geometry. Visual styling (color, borders, typography, tokens for
 * light/dark) lives in editor-theme.ts, which is applied after this sheet and
 * wins the cascade. Split out of the component file for maintainability.
 */

import { css } from "lit";

export const editorStructure = css`
    :host {
      display: grid;
      grid-template-rows: auto 1fr auto;
      grid-template-columns: 1fr 6px var(--lif-sidebar-width, 280px);
      grid-template-areas:
        "toolbar toolbar toolbar"
        "canvas resizer sidebar"
        "status status status";
      min-height: 420px;
      border: 1px solid #ccc;
      border-radius: 6px;
      overflow: hidden;
      background: #fff;
      font: 13px system-ui, sans-serif;
      color: #333;
    }
    .toolbar {
      grid-area: toolbar;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid #ddd;
      background: #f4f4f4;
      flex-wrap: wrap;
    }
    .toolbar .spacer {
      flex: 1;
    }
    .toolbar .sep {
      width: 1px;
      align-self: stretch;
      background: #ddd;
      margin: 0 4px;
    }
                        .canvas-wrap {
      grid-area: canvas;
      position: relative;
      min-height: 0;
    }
    lif-viewer {
      position: absolute;
      inset: 0;
    }
    :host([data-tool="add-node"]) lif-viewer {
      --lif-cursor: crosshair;
    }
    :host([data-tool="add-edge"]) lif-viewer,
    :host([data-tool="add-station"]) lif-viewer {
      --lif-cursor: copy;
    }
    .hint {
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 30, 30, 0.85);
      color: #fff;
      padding: 4px 12px;
      border-radius: 12px;
      pointer-events: none;
    }
    .resizer {
      grid-area: resizer;
      cursor: col-resize;
      background: #f4f4f4;
      border-left: 1px solid #ddd;
      border-right: 1px solid #ddd;
      touch-action: none;
    }
    .resizer:hover,
    .resizer:focus-visible {
      background: #1c6e8c;
      outline: none;
    }
    .sidebar {
      grid-area: sidebar;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .panel {
      padding: 10px;
      border-bottom: 1px solid #eee;
    }
    .panel h3 {
      margin: 0 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #666;
    }
    .field {
      display: grid;
      grid-template-columns: 82px 1fr;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .field label {
      color: #555;
    }
    .field input,
    .field select {
      width: 100%;
      box-sizing: border-box;
    }
    textarea.json {
      width: 100%;
      box-sizing: border-box;
      min-height: 140px;
      font: 11px ui-monospace, monospace;
      white-space: pre;
    }
    .error {
      color: #c62828;
      margin: 4px 0;
    }
    .diagnostics {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .diagnostics li {
      padding: 6px 10px;
      border-bottom: 1px solid #eee;
      cursor: default;
    }
    .diagnostics .code {
      font: 11px ui-monospace, monospace;
      margin-right: 6px;
      padding: 1px 4px;
      border-radius: 3px;
      color: #fff;
    }
    .diagnostics .path {
      display: block;
      font: 10px ui-monospace, monospace;
      color: #888;
      word-break: break-all;
    }
    .severity-error .code {
      background: #c62828;
    }
    .severity-warning .code {
      background: #b0782a;
    }
    .severity-info .code {
      background: #1c6e8c;
    }
    .badge {
      display: inline-block;
      min-width: 16px;
      text-align: center;
      border-radius: 8px;
      padding: 0 5px;
      color: #fff;
      background: #7a8a99;
      margin-left: 4px;
    }
    .badge.has-errors {
      background: #c62828;
    }
    .muted {
      color: #888;
    }
    .warn {
      color: #b0782a;
      font-size: 12px;
      margin: -2px 0 6px;
    }
    h3 {
      margin: 14px 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #666;
    }
    .actions-head {
      margin-top: 12px;
    }
    .action-row {
      border: 1px solid #e2e2e2;
      border-radius: 6px;
      padding: 8px;
      margin: 6px 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #fafafa;
    }
    .action-row-head {
      display: flex;
      gap: 6px;
    }
    .action-row-head > :first-child {
      flex: 1;
      min-width: 0;
    }
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .param-row {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 6px;
    }
    button.icon {
      padding: 2px 7px;
      line-height: 1;
    }
    .status {
      grid-area: status;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 4px 10px;
      border-top: 1px solid #ddd;
      background: #f4f4f4;
      font-size: 12px;
      color: #555;
    }
    .status .spacer {
      flex: 1;
    }
    .status button {
      padding: 1px 8px;
      font-size: 12px;
    }
    .status .stat-errors {
      color: #c62828;
      font-weight: 600;
    }
    .status .stat-warnings {
      color: #b0782a;
      font-weight: 600;
    }
    .dialog-backdrop {
      position: absolute;
      inset: 0;
      z-index: 40;
      background: rgba(0, 0, 0, 0.35);
      display: grid;
      place-items: center;
    }
    .dialog {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
      padding: 16px;
      width: min(420px, 90%);
      max-height: 85%;
      overflow-y: auto;
    }
    .dialog h2 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    .dialog h4 {
      margin: 12px 0 6px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #666;
    }
    .dialog .buttons {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 12px;
    }
    .dialog .danger {
      border-color: #c62828;
      color: #c62828;
    }
    .dialog .danger[data-confirm] {
      background: #c62828;
      color: #fff;
    }
    .search-results {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 220px;
      overflow-y: auto;
      border-bottom: 1px solid #eee;
      /* Fixed-size flex items: tall panels below must not squash the search UI. */
      flex-shrink: 0;
    }
    .search-box {
      flex-shrink: 0;
    }
    .search-results li {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      cursor: pointer;
      border-bottom: 1px solid #f3f3f3;
    }
    .search-results li:hover {
      background: #eef4f7;
    }
    .search-results .kind {
      font: bold 10px ui-monospace, monospace;
      color: #fff;
      background: #7a8a99;
      border-radius: 3px;
      padding: 1px 4px;
    }
    .search-results .kind-node {
      background: #1c6e8c;
    }
    .search-results .kind-station {
      background: #b0782a;
    }
    .search-results .layout-tag {
      margin-left: auto;
      color: #999;
      font-size: 11px;
    }
    .search-box {
      padding: 8px;
      border-bottom: 1px solid #eee;
    }
    .search-box input {
      width: 100%;
      box-sizing: border-box;
    }
    .type-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin: 6px 0;
    }
    .type-row input {
      flex: 1 1 90px;
      min-width: 70px;
    }
    .type-row [data-type-coverage] {
      flex-basis: 100%;
      font-size: 11px;
      margin-top: -2px;
    }
    details.vehicle-other {
      margin: 10px 0;
    }
    details.vehicle-other summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
    }
`;
