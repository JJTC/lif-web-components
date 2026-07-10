/**
 * Inline SVG icon set (16×16, stroke = currentColor) so the components carry
 * no icon-font or emoji dependencies and inherit the button's text color.
 *
 * Each icon is a FUNCTION returning a fresh fragment: Lit adopts rendered
 * nodes into the DOM, so a shared singleton fragment would be emptied by its
 * first use and disappear when a conditional re-render swaps icons.
 */

import { html, type TemplateResult } from "lit";

function icon(body: string, filled = false): () => TemplateResult {
  const svg = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
    fill="${filled ? "currentColor" : "none"}" stroke="${filled ? "none" : "currentColor"}"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const template = document.createElement("template");
  template.innerHTML = svg;
  return () => html`${template.content.cloneNode(true)}`;
}

export const icons = {
  pointer: icon(`<path d="M4.2 2 12.6 8l-3.8.9 2.1 4.3-1.9.9-2.1-4.3L4.2 12z" />`, true),
  node: icon(`<circle cx="6.7" cy="6.7" r="3.6"/><path d="M12.7 10.4v4.2M10.6 12.5h4.2"/>`),
  edge: icon(`<circle cx="3.2" cy="12.8" r="1.6"/><path d="M4.6 11.4 12.6 3.4M12.9 7.2V3.1H8.8"/>`),
  station: icon(`<rect x="3" y="3" width="10" height="10" rx="1.6"/>`),
  twoway: icon(`<path d="M2.5 5.6h9.6M9.6 3l2.7 2.6L9.6 8.2M13.5 10.4H3.9M6.4 13l-2.7-2.6L6.4 7.8"/>`),
  chain: icon(
    `<path d="M6.9 9.1a3 3 0 0 1 0-4.2l1.9-1.9a3 3 0 0 1 4.2 4.2l-1 1"/><path d="M9.1 6.9a3 3 0 0 1 0 4.2l-1.9 1.9a3 3 0 0 1-4.2-4.2l1-1"/>`,
  ),
  undo: icon(`<path d="M5.9 3.2 2.7 6.4l3.2 3.2"/><path d="M2.7 6.4h6.9a3.6 3.6 0 0 1 0 7.2H7.2"/>`),
  redo: icon(`<path d="M10.1 3.2l3.2 3.2-3.2 3.2"/><path d="M13.3 6.4H6.4a3.6 3.6 0 0 0 0 7.2h2.4"/>`),
  trash: icon(
    `<path d="M2.8 4.4h10.4M6.4 4.4V2.9h3.2v1.5M4.3 4.4l.6 9.2h6.2l.6-9.2M6.7 7v4M9.3 7v4"/>`,
  ),
  ruler: icon(
    `<path d="M1.9 11 11 1.9l3.1 3.1L5 14.1zM5.6 8.3l1.4 1.4M8 5.9l1.4 1.4M10.4 3.5l1.4 1.4"/>`,
  ),
  gridgen: icon(
    `<circle cx="3.4" cy="3.4" r="1.15"/><circle cx="8" cy="3.4" r="1.15"/><circle cx="12.6" cy="3.4" r="1.15"/><circle cx="3.4" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.6" cy="8" r="1.15"/><circle cx="3.4" cy="12.6" r="1.15"/><circle cx="8" cy="12.6" r="1.15"/><circle cx="12.6" cy="12.6" r="1.15"/>`,
    true,
  ),
  eye: icon(
    `<path d="M1.8 8C4 4.5 6 3.3 8 3.3S12 4.5 14.2 8C12 11.5 10 12.7 8 12.7S4 11.5 1.8 8z"/><circle cx="8" cy="8" r="2.1"/>`,
  ),
  layerplus: icon(
    `<path d="M8 2.2 13.6 5.4 8 8.6 2.4 5.4zM2.4 8.6 8 11.8l2.6-1.5"/><path d="M12.9 10.3v4.2M10.8 12.4H15"/>`,
  ),
  layeredit: icon(
    `<path d="M8 2.2 13.6 5.4 8 8.6 2.4 5.4zM2.4 8.6 8 11.8l1.6-.9"/><path d="m10.6 13.9.4-1.9 3-3 1.5 1.5-3 3z"/>`,
  ),
  file: icon(`<path d="M4 1.9h5.4L12.7 5.2v8.9H4zM9.2 2.2v3.2h3.2"/>`),
  open: icon(`<path d="M1.9 4.2h4.2l1.4 1.5h6.6v7.4H1.9zM1.9 4.2v9"/>`),
  download: icon(`<path d="M8 2.2v7.6M4.9 6.7 8 9.8l3.1-3.1M2.9 13.4h10.2"/>`),
  shield: icon(
    `<path d="M8 1.8 13 3.7v4.6c0 3.2-2.1 5.1-5 6-2.9-.9-5-2.8-5-6V3.7zM5.6 7.9l1.7 1.7 3.1-3.4"/>`,
  ),
  sun: icon(
    `<circle cx="8" cy="8" r="2.9"/><path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2"/>`,
  ),
  moon: icon(`<path d="M13.4 9.7A5.9 5.9 0 1 1 6.3 2.6a4.7 4.7 0 0 0 7.1 7.1z"/>`),
  bolt: icon(`<path d="M8.8 1.8 3.9 9h3.2l-.9 5.2L11.1 7H7.9z"/>`, true),
  truck: icon(
    `<rect x="1.9" y="4.6" width="8.2" height="5.4" rx="1"/><path d="M10.1 6.4h2.2l1.6 2v1.6h-3.8"/><circle cx="4.6" cy="11.7" r="1.4"/><circle cx="10.9" cy="11.7" r="1.4"/>`,
  ),
  target: icon(
    `<circle cx="8" cy="8" r="4.2"/><path d="M8 1.6v2.6M8 11.8v2.6M1.6 8h2.6M11.8 8h2.6"/>`,
  ),
  length: icon(`<circle cx="3" cy="13" r="1.5"/><circle cx="13" cy="3" r="1.5"/><path d="M4.2 11.8 11.8 4.2"/>`),
  area: icon(`<path d="M8 2.2 13.7 6.4 11.5 13H4.5L2.3 6.4z"/>`),
  hash: icon(`<path d="M6.2 2.4 5.2 13.6M10.8 2.4 9.8 13.6M2.8 5.9h10.8M2.4 10.1h10.8"/>`),
  eraser: icon(`<path d="m9.2 2.8 4 4-6.7 6.7H4.1L2.5 11.9zM6.1 6l3.9 3.9M5.4 13.5h8.2"/>`),
  close: icon(`<path d="m4 4 8 8M12 4l-8 8"/>`),
  search: icon(`<circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.4 3.4"/>`),
  keyboard: icon(
    `<rect x="1.6" y="4" width="12.8" height="8" rx="1.5"/><path d="M4 6.6h.9M6.6 6.6h.9M9.2 6.6h.9M11.8 6.6h.4M4.6 9.4h6.8"/>`,
  ),
  expand: icon(
    `<path d="M9.6 6.4 13.6 2.4M13.6 2.4h-3.5M13.6 2.4v3.5M6.4 9.6l-4 4M2.4 13.6h3.5M2.4 13.6v-3.5"/>`,
  ),
  compress: icon(
    `<path d="M13.6 2.4 9.6 6.4M9.6 6.4h3.5M9.6 6.4V2.9M2.4 13.6l4-4M6.4 9.6H2.9M6.4 9.6v3.5"/>`,
  ),
  zoomin: icon(`<path d="M8 3.2v9.6M3.2 8h9.6"/>`),
  zoomout: icon(`<path d="M3.2 8h9.6"/>`),
  fit: icon(
    `<path d="M2.2 5.4V2.2h3.2M10.6 2.2h3.2v3.2M13.8 10.6v3.2h-3.2M5.4 13.8H2.2v-3.2"/><circle cx="8" cy="8" r="1.7"/>`,
  ),
} as const;

export type IconName = keyof typeof icons;
