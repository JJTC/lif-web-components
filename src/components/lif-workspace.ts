/**
 * <lif-workspace> — multi-LIF workspace for master controls: one
 * document per vehicle integrator, shown as stacked, view-synchronized
 * viewer layers over a common frame. Per layer: visibility, opacity, a
 * distinguishing tint, the displayed layout, and a rigid-body alignment
 * (Δx/Δy metres, θ degrees) previewed live. "Merge layers" composes the
 * pure core ops — transform → prefix (only when ids collide) → rename into
 * the base layout (optional) → merge with provenance — and emits the result
 * as "lif-merge" { lif, summary }; the document model of each source is
 * never mutated.
 */

import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import {
  collectIdCollisions,
  mergeLif,
  prefixLifIds,
  renameLayout,
  transformLif,
  type Lif,
} from "../lif";
// Type-only on purpose: bundling the viewer into dist/mc.js would register
// <lif-viewer> a second time in hosts that import the main entry (which they
// must — it provides the element this component stacks).
import type { LifViewer } from "./lif-viewer";
import { icons } from "./icons";

/** One integrator document in the workspace. */
export interface WorkspaceSource {
  /** Stable key; colliding sources are prefixed with `${sourceId}:` on merge. */
  sourceId: string;
  label?: string;
  lif: Lif;
}

/** What happened to one source during merge. */
export interface LayerMergeSummary {
  sourceId: string;
  /** The applied id prefix, or null when no ids collided. */
  prefix: string | null;
  /** The base layout its displayed layout was united with, or null. */
  mergedIntoLayout: string | null;
}

interface LayerState {
  visible: boolean;
  opacity: number;
  dx: number;
  dy: number;
  rotateDeg: number;
  layoutId: string | null;
  mergeIntoBase: boolean;
}

/** Overlay tints (validated categorical palette; the base keeps role colors). */
const LAYER_TINTS = ["#e34948", "#e87ba4", "#c98500", "#9085e9"];

export class LifWorkspace extends LitElement {
  static properties = {
    sources: { attribute: false },
    theme: { type: String, reflect: true },
    activeSourceId: { state: true },
    mergeError: { state: true },
  };

  declare sources: WorkspaceSource[];
  /** "light" (default) or "dark" — selected token sets, not an automatic flip. */
  declare theme: "light" | "dark";
  /** The layer receiving pointer input (pan/zoom drives all layers). */
  declare activeSourceId: string | null;
  declare mergeError: string | null;

  #layerStates = new Map<string, LayerState>();
  #transformCache = new Map<
    string,
    { lif: Lif; dx: number; dy: number; rotateDeg: number; result: Lif }
  >();

  constructor() {
    super();
    this.sources = [];
    this.theme = "light";
    this.activeSourceId = null;
    this.mergeError = null;
  }

  #layerState(sourceId: string): LayerState {
    let state = this.#layerStates.get(sourceId);
    if (!state) {
      state = {
        visible: true,
        opacity: 0.75,
        dx: 0,
        dy: 0,
        rotateDeg: 0,
        layoutId: null,
        mergeIntoBase: true,
      };
      this.#layerStates.set(sourceId, state);
    }
    return state;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!changed.has("sources")) return;
    const known = new Set(this.sources.map((s) => s.sourceId));
    for (const id of [...this.#layerStates.keys()]) {
      if (!known.has(id)) {
        this.#layerStates.delete(id);
        this.#transformCache.delete(id);
      }
    }
    this.sources.forEach((s, i) => {
      const state = this.#layerStates.get(s.sourceId);
      if (!state) {
        this.#layerStates.set(s.sourceId, {
          visible: true,
          opacity: i === 0 ? 1 : 0.75,
          dx: 0,
          dy: 0,
          rotateDeg: 0,
          layoutId: s.lif.layouts[0]?.layoutId ?? null,
          mergeIntoBase: true,
        });
      } else if (
        state.layoutId !== null &&
        !s.lif.layouts.some((l) => l.layoutId === state.layoutId)
      ) {
        // Same sourceId, replaced document: a stale layout selection would
        // rename overlays into a ghost id on merge — revalidate it.
        state.layoutId = s.lif.layouts[0]?.layoutId ?? null;
      }
    });
    if (this.activeSourceId === null || !known.has(this.activeSourceId)) {
      this.activeSourceId = this.sources[0]?.sourceId ?? null;
    }
  }

  /* ------------------------------ layers ------------------------------ */

  #transformedDoc(source: WorkspaceSource): Lif {
    const state = this.#layerState(source.sourceId);
    const hit = this.#transformCache.get(source.sourceId);
    if (
      hit &&
      hit.lif === source.lif &&
      hit.dx === state.dx &&
      hit.dy === state.dy &&
      hit.rotateDeg === state.rotateDeg
    ) {
      return hit.result;
    }
    const result =
      state.dx === 0 && state.dy === 0 && state.rotateDeg === 0
        ? source.lif
        : transformLif(source.lif, {
            dx: state.dx,
            dy: state.dy,
            rotateRad: (state.rotateDeg * Math.PI) / 180,
          });
    this.#transformCache.set(source.sourceId, {
      lif: source.lif,
      dx: state.dx,
      dy: state.dy,
      rotateDeg: state.rotateDeg,
      result,
    });
    return result;
  }

  #viewers(): LifViewer[] {
    return [...this.renderRoot.querySelectorAll<LifViewer>("lif-viewer")];
  }

  #activeViewer(): LifViewer | null {
    // No selector interpolation: source ids are host-supplied and may contain
    // characters that would break (or subvert) a CSS selector.
    return (
      this.#viewers().find((v) => v.dataset.sourceId === this.activeSourceId) ?? null
    );
  }

  /**
   * Any layer's genuine view change becomes the stack's view. Sync writes
   * produce views equal to the emitter's, so the equality guard in
   * `#syncViewsFrom` makes re-entrant events no-ops — while a spontaneous
   * change (the interactive layer panning, or the base layer auto-fitting
   * after a document swap) propagates to every other layer.
   */
  #onViewChange = (ev: Event): void => {
    this.#syncViewsFrom(ev.target as LifViewer);
  };

  #syncViews(): void {
    const active = this.#activeViewer();
    if (active) this.#syncViewsFrom(active);
  }

  #syncViewsFrom(source: LifViewer): void {
    const view = source.view;
    for (const viewer of this.#viewers()) {
      if (viewer === source) continue;
      const v = viewer.view;
      if (v.scale !== view.scale || v.tx !== view.tx || v.ty !== view.ty) {
        viewer.view = { ...view };
      }
    }
  }

  protected updated(): void {
    // Newly rendered layers pick up the current frame immediately.
    this.#syncViews();
  }

  /* ------------------------------ merge ------------------------------- */

  /** Compose transform → prefix-on-collision → layout union → merge. */
  buildMerged(): { lif: Lif; summary: LayerMergeSummary[] } {
    if (this.sources.length === 0) throw new Error("no source documents loaded");
    const [base, ...rest] = this.sources;
    const baseState = this.#layerState(base!.sourceId);
    let merged = this.#transformedDoc(base!);
    const baseLayoutId = baseState.layoutId ?? merged.layouts[0]?.layoutId ?? null;
    const summary: LayerMergeSummary[] = [];
    for (const source of rest) {
      const state = this.#layerState(source.sourceId);
      let doc = this.#transformedDoc(source);
      const selectedId = state.layoutId ?? source.lif.layouts[0]?.layoutId ?? "";
      const collisions = collectIdCollisions(merged, doc);
      // The only sanctioned same-id union is the selected layout joining the
      // base layout: with mergeIntoBase, the selected layout's id collision
      // is irrelevant (it gets renamed away or IS the intended union) — any
      // OTHER colliding layout would silently fuse two integrators' levels,
      // so it forces prefixing just like element collisions do.
      const layoutConflicts = collisions.layouts.filter(
        (id) => !(state.mergeIntoBase && id === selectedId),
      );
      const collides =
        collisions.nodes.length + collisions.edges.length + collisions.stations.length > 0 ||
        layoutConflicts.length > 0;
      const prefix = collides ? `${source.sourceId}:` : null;
      if (prefix) doc = prefixLifIds(doc, prefix);
      let mergedIntoLayout: string | null = null;
      if (state.mergeIntoBase && baseLayoutId) {
        const selected = (prefix ?? "") + selectedId;
        if (selected && selected !== baseLayoutId) {
          doc = renameLayout(doc, selected, baseLayoutId);
        }
        mergedIntoLayout = baseLayoutId;
      }
      merged = mergeLif(merged, doc);
      summary.push({ sourceId: source.sourceId, prefix, mergedIntoLayout });
    }
    return { lif: merged, summary };
  }

  #merge = (): void => {
    try {
      const result = this.buildMerged();
      this.mergeError = null;
      this.dispatchEvent(
        new CustomEvent("lif-merge", { detail: result, bubbles: true, composed: true }),
      );
    } catch (e) {
      this.mergeError = e instanceof Error ? e.message : String(e);
    }
  };

  /* ------------------------------ render ------------------------------ */

  #renderLayerRow(source: WorkspaceSource, index: number): TemplateResult {
    const state = this.#layerState(source.sourceId);
    const active = source.sourceId === this.activeSourceId;
    const tint = index === 0 ? null : LAYER_TINTS[(index - 1) % LAYER_TINTS.length]!;
    const numberField = (
      label: string,
      field: "dx" | "dy" | "rotateDeg",
      step: string,
    ) => html`
      <label class="num">
        ${label}
        <input
          data-field=${field}
          type="number"
          step=${step}
          .value=${String(state[field])}
          @change=${(ev: Event) => {
            const v = Number((ev.target as HTMLInputElement).value);
            if (Number.isFinite(v)) {
              state[field] = v;
              this.requestUpdate();
            }
          }}
        />
      </label>
    `;
    return html`
      <div class="layer-row ${active ? "active" : ""}" data-layer-row=${source.sourceId}>
        <div class="head">
          <span class="tint" style=${tint ? `background:${tint}` : ""}></span>
          <button
            class="activate"
            title="Make this the interactive layer"
            aria-pressed=${active ? "true" : "false"}
            @click=${() => (this.activeSourceId = source.sourceId)}
          >
            ${source.label ?? source.sourceId}
          </button>
          <button
            class="icon-only"
            data-action="toggle-visible"
            title=${state.visible ? "Hide layer" : "Show layer"}
            aria-pressed=${state.visible ? "true" : "false"}
            @click=${() => {
              state.visible = !state.visible;
              this.requestUpdate();
            }}
          >
            ${icons.eye()}
          </button>
          <input
            data-field="opacity"
            type="range"
            min="0.2"
            max="1"
            step="0.1"
            title="Layer opacity"
            .value=${String(state.opacity)}
            @input=${(ev: Event) => {
              state.opacity = Number((ev.target as HTMLInputElement).value);
              this.requestUpdate();
            }}
          />
        </div>
        <div class="controls">
          <select
            data-field="layoutId"
            title="Displayed layout"
            @change=${(ev: Event) => {
              state.layoutId = (ev.target as HTMLSelectElement).value;
              this.requestUpdate();
            }}
          >
            ${source.lif.layouts.map(
              (l) =>
                html`<option value=${l.layoutId} ?selected=${l.layoutId === state.layoutId}>
                  ${l.layoutId}
                </option>`,
            )}
          </select>
          ${numberField("Δx", "dx", "0.1")} ${numberField("Δy", "dy", "0.1")}
          ${numberField("θ°", "rotateDeg", "1")}
        </div>
        ${index === 0
          ? nothing
          : html`
              <label class="merge-opt">
                <input
                  type="checkbox"
                  data-field="mergeIntoBase"
                  .checked=${state.mergeIntoBase}
                  @change=${(ev: Event) => {
                    state.mergeIntoBase = (ev.target as HTMLInputElement).checked;
                    this.requestUpdate();
                  }}
                />
                unite displayed layout with the base layout on merge
              </label>
            `}
      </div>
    `;
  }

  #renderLayerViewer(source: WorkspaceSource, index: number): TemplateResult {
    const state = this.#layerState(source.sourceId);
    const active = source.sourceId === this.activeSourceId;
    const tint = index === 0 ? null : LAYER_TINTS[(index - 1) % LAYER_TINTS.length]!;
    const style = [
      // Dim the map parts only — never the viewer's own controls (see styles).
      `--layer-opacity:${state.opacity}`,
      state.visible ? "" : "display:none",
      index === 0 ? "" : "--lif-surface: transparent",
      tint
        ? `--lif-node-color:${tint};--lif-edge-color:${tint};--lif-station-color:${tint};--lif-edge-hover-color:${tint}`
        : "",
    ]
      .filter(Boolean)
      .join(";");
    return html`
      <lif-viewer
        class="layer ${active ? "active" : ""}"
        data-source-id=${source.sourceId}
        style=${style}
        .lif=${this.#transformedDoc(source)}
        .layoutId=${state.layoutId}
        .autoFit=${index === 0}
        .showGrid=${index === 0}
        .showRulers=${index === 0}
        .theme=${this.theme}
        @lif-view-change=${this.#onViewChange}
        @lif-layout-change=${(ev: CustomEvent<{ layoutId: string }>) => {
          state.layoutId = ev.detail.layoutId;
          this.requestUpdate();
        }}
      ></lif-viewer>
    `;
  }

  protected render(): TemplateResult {
    return html`
      <div class="stage" part="stage">
        ${this.sources.map((s, i) => this.#renderLayerViewer(s, i))}
        ${this.sources.length === 0
          ? html`<div class="empty">Assign <code>sources</code> to load integrator documents.</div>`
          : nothing}
      </div>
      <aside class="panel" part="layers">
        <h3>Layers</h3>
        <div class="hint">
          First layer is the base frame. Align the others (Δ in metres, θ in degrees), then merge.
        </div>
        ${this.sources.map((s, i) => this.#renderLayerRow(s, i))}
        ${this.mergeError ? html`<div class="error" data-merge-error>${this.mergeError}</div>` : nothing}
        <button
          class="merge"
          data-action="merge"
          ?disabled=${this.sources.length === 0}
          @click=${this.#merge}
        >
          Merge ${this.sources.length} layer${this.sources.length === 1 ? "" : "s"}
        </button>
        <div class="hint">
          Colliding ids are prefixed with <code>sourceId:</code>; the merged document records its
          sources in <code>metaInformation["x-mergedSources"]</code>.
        </div>
      </aside>
    `;
  }

  static styles = css`
    :host {
      --_surface: var(--lif-surface, #fcfcfb);
      --_overlay: var(--lif-surface-overlay, #ffffff);
      --_ink: var(--lif-ink, #1c1b19);
      --_ink-2: var(--lif-ink-secondary, #52514e);
      --_muted: var(--lif-ink-muted, #898781);
      --_border: var(--lif-border, rgba(11, 11, 11, 0.12));
      --_accent: var(--lif-accent, #2a78d6);
      display: flex;
      min-height: 320px;
      background: var(--_surface);
      color: var(--_ink);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      border: 1px solid var(--_border);
      border-radius: 8px;
      overflow: hidden;
    }
    :host([theme="dark"]) {
      --_surface: var(--lif-surface, #1a1a19);
      --_overlay: var(--lif-surface-overlay, #2b2b29);
      --_ink: var(--lif-ink, #f2f1ec);
      --_ink-2: var(--lif-ink-secondary, #c3c2b7);
      --_muted: var(--lif-ink-muted, #898781);
      --_border: var(--lif-border, rgba(255, 255, 255, 0.14));
      --_accent: var(--lif-accent, #3987e5);
    }
    .stage {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .layer {
      position: absolute;
      inset: 0;
      min-height: 0;
      pointer-events: none;
    }
    .layer.active {
      pointer-events: auto;
    }
    /* One map, one set of chrome: layouts are chosen per layer in the panel. */
    .layer::part(tabs) {
      display: none;
    }
    .layer:not(.active)::part(zoom-controls) {
      display: none;
    }
    /* Layer opacity dims the document content only — grid, rulers and the
       viewer's controls are instruments, not layer content. */
    .layer::part(scene),
    .layer::part(vehicle-layer) {
      opacity: var(--layer-opacity, 1);
    }
    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--_muted);
    }
    .panel {
      width: 280px;
      flex: none;
      overflow-y: auto;
      border-left: 1px solid var(--_border);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .panel h3 {
      margin: 0;
      font-size: 13px;
    }
    .hint {
      color: var(--_muted);
      font-size: 11.5px;
    }
    .layer-row {
      border: 1px solid var(--_border);
      border-radius: 6px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .layer-row.active {
      box-shadow: inset 2px 0 0 var(--_accent);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tint {
      flex: none;
      width: 10px;
      height: 10px;
      border-radius: 3px;
      background: var(--_ink-2);
    }
    .activate {
      flex: 1;
      min-width: 0;
      text-align: left;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .head input[type="range"] {
      width: 70px;
    }
    button.icon-only {
      border: 0;
      background: none;
      color: var(--_ink-2);
      cursor: pointer;
      display: inline-flex;
      padding: 2px;
    }
    button.icon-only[aria-pressed="false"] {
      opacity: 0.45;
    }
    button.icon-only svg {
      width: 15px;
      height: 15px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .controls select {
      flex: 1 1 90px;
      min-width: 80px;
      background: var(--_overlay);
      color: inherit;
      border: 1px solid var(--_border);
      border-radius: 4px;
      font: inherit;
      font-size: 12px;
      padding: 2px 4px;
    }
    .num {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 11.5px;
      color: var(--_ink-2);
    }
    .num input {
      width: 52px;
      background: var(--_overlay);
      color: var(--_ink);
      border: 1px solid var(--_border);
      border-radius: 4px;
      font: inherit;
      font-size: 12px;
      padding: 2px 4px;
    }
    .merge-opt {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: var(--_ink-2);
    }
    .error {
      color: #c62828;
      font-size: 12px;
    }
    button.merge {
      border: 1px solid var(--_border);
      border-radius: 6px;
      background: var(--_overlay);
      color: inherit;
      font: inherit;
      font-weight: 600;
      padding: 6px;
      cursor: pointer;
    }
    button.merge:hover:not([disabled]) {
      border-color: var(--_accent);
      color: var(--_accent);
    }
    button.merge[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    button:focus-visible,
    input:focus-visible,
    select:focus-visible {
      outline: 2px solid var(--_accent);
      outline-offset: 1px;
    }
  `;
}

customElements.define("lif-workspace", LifWorkspace);

declare global {
  interface HTMLElementTagNameMap {
    "lif-workspace": LifWorkspace;
  }
}
