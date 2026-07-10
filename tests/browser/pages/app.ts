/**
 * Page module for the browser tests: registers the components and exposes
 * the core API plus a fixture loader for use from page.evaluate().
 */

import "../../../src/index";
import "../../../src/mc";
import { parseLif, serializeLif, validateLif } from "../../../src/index";
import type { LifEditor } from "../../../src/index";
import type { LifViewer } from "../../../src/index";

declare global {
  interface Window {
    lifCore: {
      parseLif: typeof parseLif;
      serializeLif: typeof serializeLif;
      validateLif: typeof validateLif;
    };
    loadFixtureIntoViewer(name: string, selector: string): Promise<void>;
    loadFixtureIntoEditor(name: string, selector: string): Promise<number>;
  }
}

window.lifCore = { parseLif, serializeLif, validateLif };

window.loadFixtureIntoViewer = async (name, selector) => {
  const text = await (await fetch(`/fixtures/${name}`)).text();
  const { lif } = parseLif(text);
  const viewer = document.querySelector<LifViewer>(selector)!;
  viewer.lif = lif;
  await viewer.updateComplete;
};

window.loadFixtureIntoEditor = async (name, selector) => {
  const text = await (await fetch(`/fixtures/${name}`)).text();
  const editor = document.querySelector<LifEditor>(selector)!;
  const diagnostics = editor.loadJson(text);
  await editor.updateComplete;
  return diagnostics.length;
};

// The fleet page pairs the panel with the viewer next to it.
const fleetPanel = document.querySelector("lif-fleet-panel");
if (fleetPanel) fleetPanel.viewer = document.querySelector<LifViewer>("lif-viewer");
