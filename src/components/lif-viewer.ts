/**
 * <lif-viewer> — renders one layout of a LIF document as SVG with
 * pan/zoom, layout tabs, hover and selection.
 *
 * Coordinates: the model is y-up metres. The one and only y-flip
 * lives in the `#project()` helper; the scene is rendered in screen pixels
 * (no scaled group transform — see #project for why), and pointer input is
 * mapped back through `toWorld()`.
 *
 * Input is handled as pointer gestures on the <svg> (element-level `click`
 * cannot be used: pointer capture retargets pointerup, so click never fires
 * on the shapes). A press that moves less than a small threshold counts as a
 * click and selects the shape found by hit-testing the pointerdown target.
 *
 * Selection is controlled: the component renders `selectedId` (optionally
 * disambiguated by `selectedKind`) and emits `lif-select`, but never changes
 * its own selection state.
 *
 * Events (bubbling, composed):
 * - "lif-select"        detail: { kind: "node"|"edge"|"station"|"vehicle"|null, id: string|null }
 * - "lif-canvas-click"  detail: { x, y }                       (world metres)
 * - "lif-node-pointer"  detail: { phase: "start"|"move"|"end", nodeId, x, y }
 *                       (only when `interactiveNodes` is true; used by the editor)
 * - "lif-layout-change" detail: { layoutId }
 * - "lif-follow-change" detail: { vehicleId: string|null }   (follow mode)
 * - "lif-view-change"   detail: { scale, tx, ty }             (on every view change)
 * - "lif-marquee"       detail: { minX, minY, maxX, maxY }    (Shift+drag, world metres)
 */

import { html, LitElement, nothing, svg, css, type PropertyValues, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { icons } from "./icons";
import { STATUS_COLORS, STATUS_GLYPH_INK } from "./status-colors";
import {
  isTrajectoryEvaluable,
  sampleTrajectory,
  type Layout,
  type Lif,
  type LifEdge,
  type LifNode,
  type Station,
} from "../lif";

interface ViewTransform {
  /** Pixels per metre. */
  scale: number;
  tx: number;
  ty: number;
}

export interface LifSelectDetail {
  kind: "node" | "edge" | "station" | "vehicle" | null;
  id: string | null;
}

/**
 * Operational status of a live vehicle. "warning"/"error" add a status badge
 * to the marker (reserved status palette + glyph — never color alone);
 * "offline" dims the marker. Absent means "ok".
 */
export type VehicleStatus = "ok" | "warning" | "error" | "offline";

/**
 * Live vehicle pose for the overlay. Coordinates follow the
 * VDA 5050 agvPosition convention: metres, y-up, theta radians CCW-positive,
 * in the same project-global origin as the LIF layouts.
 */
export interface LifVehicle {
  vehicleId: string;
  x: number;
  y: number;
  /** Heading; omit to render an orientation-less marker. */
  theta?: number;
  /** Show only on layouts whose nodes reference this map. */
  mapId?: string;
  /** Show only on this layout (takes precedence over mapId). */
  layoutId?: string;
  /** Participates in the vehicle-type filter when set. */
  vehicleTypeId?: string;
  /** Marker caption; defaults to vehicleId. */
  label?: string;
  /** Status-codes the marker (badge/dim); see VehicleStatus. */
  status?: VehicleStatus;
}

/** One stop of a runtime route overlay. */
export interface LifRouteStop {
  nodeId: string;
  /** VDA 5050 base/horizon: false → planned, rendered dashed. Default true. */
  released?: boolean;
  /** Action types badged at this stop. */
  actions?: string[];
}

/**
 * Runtime route/order overlay — like vehicles, never document
 * state. Stops reference the document's node ids; legs with a matching
 * `edgeIds` entry follow that edge's drawn geometry (incl. trajectories),
 * otherwise they render as straight lines. Legs whose endpoints are not both
 * on the displayed layout are skipped (cross-layout orders).
 */
export interface LifRoute {
  routeId: string;
  stops: LifRouteStop[];
  /** Edge per leg (`stops.length - 1`); null/absent legs render straight. */
  edgeIds?: (string | null)[];
  /** The vehicle executing this route (informational). */
  vehicleId?: string;
  /** Used in the accessible name; defaults to routeId. */
  label?: string;
}

/**
 * Background image for a layout — runtime data, never part of the
 * LIF document. `x`/`y` are the world position of the image's **lower-left**
 * corner in metres, matching the ROS occupancy-grid map convention
 * (origin = lower-left pixel, size = pixels × resolution).
 */
export interface LifBackground {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Default 0.7. */
  opacity?: number;
}

export type MeasureMode = "length" | "area";

interface Measurement {
  mode: MeasureMode;
  points: { x: number; y: number }[];
}

interface VehiclePose {
  x: number;
  y: number;
  theta?: number;
}

/** What the canvas vehicle layer drew for one vehicle in the last frame. */
export interface RenderedVehicle {
  vehicleId: string;
  /** Screen px within the viewer. */
  x: number;
  y: number;
  /** Screen rotation in degrees (world θ negated for the y-down screen). */
  rotationDeg: number;
  /** "full" marker with heading nose, or a "dot" below the LOD zoom threshold. */
  lod: "full" | "dot";
  selected: boolean;
  status?: VehicleStatus;
}

interface VehicleTween {
  from: VehiclePose;
  to: VehiclePose;
  start: number;
  duration: number;
}

export interface LifNodePointerDetail {
  phase: "start" | "move" | "end";
  nodeId: string;
  x: number;
  y: number;
}

type Hit = { kind: "node" | "edge" | "station" | "vehicle"; id: string };

type Gesture =
  | {
      type: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startTx: number;
      startTy: number;
      hit: Hit | null;
      moved: boolean;
    }
  | {
      type: "drag";
      pointerId: number;
      nodeId: string;
      startClientX: number;
      startClientY: number;
      moved: boolean;
    }
  | {
      type: "marquee";
      pointerId: number;
      moved: boolean;
    };

/**
 * Displayed-layout element count up to which a zoom re-projects the scene on
 * every frame (marks keep their constant screen size and labels grow
 * continuously to their cap — no gesture-time scaling). Larger documents ride
 * the compositor delta and settle at rest instead; pure pans use
 * the delta at any size, since translation never distorts sizes.
 */
const LIVE_ZOOM_ELEMENT_LIMIT = 1500;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50000;
/** Pointer travel (px) below which a press counts as a click. */
const CLICK_SLOP = 3;
/**
 * Scene labels are world objects: their font size tracks the zoom
 * (LABEL_WORLD_EM metres per em), clamped to a readable pixel range and
 * hidden entirely below it — which also declutters zoomed-out overviews.
 */
const LABEL_WORLD_EM = 0.26;
const LABEL_MIN_PX = 6.5;
const LABEL_MAX_PX = 20;

export class LifViewer extends LitElement {
  static properties = {
    lif: { attribute: false },
    layoutId: { type: String, attribute: "layout-id" },
    selectedId: { type: String, attribute: "selected-id" },
    selectedKind: { type: String, attribute: "selected-kind" },
    vehicleTypeId: { type: String, attribute: "vehicle-type-id" },
    multiSelectedIds: { attribute: false },
    interactiveNodes: { type: Boolean, attribute: "interactive-nodes" },
    vehicleTransitionMs: { type: Number, attribute: "vehicle-transition-ms" },
    routes: { attribute: false },
    backgrounds: { attribute: false },
    showGrid: { attribute: false },
    showRulers: { attribute: false },
    showNodes: { attribute: false },
    showEdges: { attribute: false },
    showStations: { attribute: false },
    showLabels: { attribute: false },
    showTrajectories: { attribute: false },
    displayMenuOpen: { attribute: false },
    measuring: { type: Boolean, reflect: true },
    measureMode: { type: String, attribute: "measure-mode" },
    measureSegmentLabels: { attribute: false },
    theme: { type: String, reflect: true },
    fullscreenTarget: { attribute: false },
    autoFit: { attribute: false },
    view: { attribute: false, state: true },
  };

  declare lif: Lif | null;
  declare layoutId: string | null;
  declare selectedId: string | null;
  /**
   * Optional selection kind. When set, selection matches only a mark of this
   * kind — disambiguating the spec-legal case where a stationId equals a
   * nodeId (guideline example 10.13). When null, any mark with the id matches.
   */
  declare selectedKind: LifSelectDetail["kind"];
  declare vehicleTypeId: string | null;
  /** Marks highlighted as part of a bulk selection (editor marquee). */
  declare multiSelectedIds: string[];
  declare interactiveNodes: boolean;
  /**
   * Live vehicle poses; assign a new array on every fleet update.
   * Deliberately NOT a reactive property: vehicles render on their own canvas
   * layer, so a fleet update never re-renders the SVG scene — it only syncs
   * the tweens and redraws the canvas. This is what makes 10k AMRs cheap.
   */
  get vehicles(): LifVehicle[] {
    return this.#vehicles;
  }

  set vehicles(value: LifVehicle[]) {
    this.#vehicles = value ?? [];
    this.#syncVehicleTweens();
    this.#applyFollow();
    this.#scheduleVehicleDraw();
  }

  /**
   * Follow mode: keep this vehicle centred as it moves. Cleared by
   * a manual pan, `fitView()` or `centerOn()`; zooming keeps following.
   * Changes emit "lif-follow-change".
   */
  get followVehicleId(): string | null {
    return this.#followVehicleId;
  }

  set followVehicleId(value: string | null) {
    const next = value ?? null;
    if (next === this.#followVehicleId) return;
    this.#followVehicleId = next;
    this.#applyFollow();
    this.#scheduleVehicleDraw();
    this.dispatchEvent(
      new CustomEvent("lif-follow-change", {
        detail: { vehicleId: next },
        bubbles: true,
        composed: true,
      }),
    );
  }
  /** Tween duration towards each new pose; 0 disables interpolation. */
  declare vehicleTransitionMs: number;
  /** Route/order overlays (runtime-only, never exported). */
  declare routes: LifRoute[];
  /** Background image per layoutId (runtime-only, never exported). */
  declare backgrounds: Record<string, LifBackground>;
  declare showGrid: boolean;
  /** Metre labels along the axes; a sub-element of the grid (off while the grid is off). */
  declare showRulers: boolean;
  declare showNodes: boolean;
  declare showEdges: boolean;
  declare showStations: boolean;
  declare showLabels: boolean;
  /** When false, trajectory edges render as straight lines. */
  declare showTrajectories: boolean;
  /** The display-filter popover in the map controls. */
  declare displayMenuOpen: boolean;
  /** Measure mode: clicks place measurement points instead of selecting. */
  declare measuring: boolean;
  /** What a measurement means: polyline length or polygon area. */
  declare measureMode: MeasureMode;
  /** Show the per-segment length labels (in addition to totals). */
  declare measureSegmentLabels: boolean;
  /** "light" (default) or "dark" — selected token sets, not an automatic flip. */
  declare theme: "light" | "dark";
  /** Element the fullscreen button expands (default: this viewer). The editor points it at itself. */
  declare fullscreenTarget: HTMLElement | null;
  /** Fit the view once per document/layout (default). Off for externally driven views (workspace layers). */
  declare autoFit: boolean;
  declare view: ViewTransform;

  #gesture: Gesture | null = null;
  #fittedForKey: string | null = null;
  #vehicles: LifVehicle[] = [];
  #followVehicleId: string | null = null;
  /**
   * The view the SVG scene is currently projected for.
   * During pan/zoom gestures only a group transform tracks `view`; the scene
   * re-projects (crisp, screen-space) when the gesture rests.
   */
  #projectedView: ViewTransform = { scale: 50, tx: 60, ty: 400 };
  #restReprojectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Marquee drag rectangle in viewer-local px (Shift+drag). */
  #marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  #multiSet = new Set<string>();
  /** Poses as currently drawn (tween state lives here, never in `vehicles`). */
  #displayedPoses = new Map<string, VehiclePose>();
  #tweens = new Map<string, VehicleTween>();
  #raf: number | null = null;
  /** Screen-space results of the last canvas draw (hit-testing + getRenderedVehicles). */
  #drawnVehicles: RenderedVehicle[] = [];
  #vehicleDrawQueued = false;
  #measurements: Measurement[] = [];
  #measurePending: { x: number; y: number }[] = [];
  #measureCursor: { x: number; y: number } | null = null;
  #resizeObserver: ResizeObserver | null = null;

  constructor() {
    super();
    this.lif = null;
    this.layoutId = null;
    this.selectedId = null;
    this.selectedKind = null;
    this.vehicleTypeId = null;
    this.multiSelectedIds = [];
    this.interactiveNodes = false;
    this.vehicles = [];
    this.vehicleTransitionMs = 800;
    this.routes = [];
    this.backgrounds = {};
    this.showGrid = true;
    this.showRulers = true;
    this.showNodes = true;
    this.showEdges = true;
    this.showStations = true;
    this.showLabels = true;
    this.showTrajectories = true;
    this.displayMenuOpen = false;
    this.measuring = false;
    this.measureMode = "length";
    this.measureSegmentLabels = true;
    this.theme = "light";
    this.fullscreenTarget = null;
    this.autoFit = true;
    this.view = { scale: 50, tx: 60, ty: 400 };
  }

  #onFullscreenChange = (): void => {
    this.requestUpdate();
  };

  /** True when this component's fullscreen target is currently fullscreen. */
  get isFullscreen(): boolean {
    const target = this.fullscreenTarget ?? this;
    return document.fullscreenElement === target;
  }

  /** Enter/exit fullscreen on the configured target. */
  async toggleFullscreen(): Promise<void> {
    const target = this.fullscreenTarget ?? this;
    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
      } else {
        await target.requestFullscreen();
      }
    } catch {
      // Fullscreen can be denied (permissions policy, no user activation).
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Grid/ruler geometry and the vehicle canvas depend on the viewport size.
    this.#resizeObserver = new ResizeObserver(() => {
      this.#resizeVehicleCanvas();
      this.requestUpdate();
    });
    this.#resizeObserver.observe(this);
    document.addEventListener("fullscreenchange", this.#onFullscreenChange);
    // Re-attaching mid-tween: disconnect cancelled the animation frame while
    // tweens were still in flight — resume them.
    if (this.#tweens.size > 0) this.#startTweenLoop();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("fullscreenchange", this.#onFullscreenChange);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#raf !== null) {
      cancelAnimationFrame(this.#raf);
      this.#raf = null;
    }
    if (this.#restReprojectTimer !== null) {
      clearTimeout(this.#restReprojectTimer);
      this.#restReprojectTimer = null;
    }
  }

  /**
   * Pan so the given world position sits at the viewport centre (scale
   * unchanged). An explicit reframe: ends follow mode.
   */
  centerOn(x: number, y: number): void {
    this.followVehicleId = null;
    this.#centerViewOn(x, y);
    this.#reproject();
  }

  #centerViewOn(x: number, y: number): void {
    const rect = this.getBoundingClientRect();
    const { scale } = this.view;
    this.view = {
      scale,
      tx: (rect.width || 800) / 2 - x * scale,
      ty: (rect.height || 500) / 2 + y * scale,
    };
  }

  /** Re-centre on the followed vehicle's displayed pose; true when it moved the view. */
  #applyFollow(): boolean {
    if (!this.#followVehicleId) return false;
    const pose =
      this.#displayedPoses.get(this.#followVehicleId) ??
      this.#vehicles.find((v) => v.vehicleId === this.#followVehicleId);
    if (!pose) return false;
    this.#centerViewOn(pose.x, pose.y);
    return true;
  }

  #zoomBy(factor: number): void {
    queueMicrotask(() => this.#reproject()); // single-step zoom: crisp right away
    const rect = this.getBoundingClientRect();
    const px = (rect.width || 800) / 2;
    const py = (rect.height || 500) / 2;
    const scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const applied = scale / this.view.scale;
    this.view = {
      scale,
      tx: px - (px - this.view.tx) * applied,
      ty: py - (py - this.view.ty) * applied,
    };
    this.#applyFollow(); // keep the followed vehicle centred through button zooms
  }

  /** Zoom in one step, anchored at the viewport centre. */
  zoomIn(): void {
    this.#zoomBy(1.3);
  }

  /** Zoom out one step, anchored at the viewport centre. */
  zoomOut(): void {
    this.#zoomBy(1 / 1.3);
  }

  /** Discard all measurements and any in-progress one. */
  clearMeasurements(): void {
    this.#measurements = [];
    this.#measurePending = [];
    this.#measureCursor = null;
    this.requestUpdate();
  }

  /** True while a measurement is being drawn (points placed, not yet finished). */
  get hasPendingMeasurement(): boolean {
    return this.#measurePending.length > 0;
  }

  /** Abort the in-progress measurement, keeping completed ones. */
  cancelPendingMeasurement(): void {
    this.#measurePending = [];
    this.#measureCursor = null;
    this.requestUpdate();
  }

  /** Remove the in-progress measurement, or the most recent completed one. */
  clearLastMeasurement(): void {
    if (this.hasPendingMeasurement) {
      this.cancelPendingMeasurement();
      return;
    }
    this.#measurements.pop();
    this.requestUpdate();
  }

  /** Finish the in-progress measurement (also triggered by double-click). */
  finishMeasurement(): void {
    const need = this.measureMode === "area" ? 3 : 2;
    if (this.#measurePending.length >= need) {
      this.#measurements.push({ mode: this.measureMode, points: [...this.#measurePending] });
    }
    this.#measurePending = [];
    this.#measureCursor = null;
    this.requestUpdate();
  }

  static styles = css`
    :host {
      /* Design tokens (dataviz reference palette). Public --lif-* vars
         override either theme; the private --_* names are what rules read. */
      --_surface: var(--lif-surface, #fcfcfb);
      --_overlay: var(--lif-surface-overlay, #ffffff);
      --_ink: var(--lif-ink, #1c1b19);
      --_ink-2: var(--lif-ink-secondary, #52514e);
      --_muted: var(--lif-ink-muted, #898781);
      --_border: var(--lif-border, rgba(11, 11, 11, 0.12));
      --_grid: var(--lif-grid-color, #e9e8e1);
      --_axis: var(--lif-grid-axis-color, #cfcec6);
      --_accent: var(--lif-accent, #2a78d6);
      --_node: var(--lif-node-color, #2a78d6);
      --_edge: var(--lif-edge-color, #9c9a92);
      --_edge-hover: var(--lif-edge-hover-color, #52514e);
      --_station: var(--lif-station-color, #eda100);
      --_vehicle: var(--lif-vehicle-color, #1baf7a);
      --_selection: var(--lif-selection-color, #4a3aa7);
      --_measure: var(--lif-measure-color, #eb6834);
      --_route: var(--lif-route-color, #008300);
      display: block;
      min-height: 200px;
      position: relative;
      background: var(--_surface);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: var(--_ink);
    }
    :host(:fullscreen) {
      border-radius: 0;
    }
    :host([theme="dark"]) {
      --_surface: var(--lif-surface, #1a1a19);
      --_overlay: var(--lif-surface-overlay, #2b2b29);
      --_ink: var(--lif-ink, #f2f1ec);
      --_ink-2: var(--lif-ink-secondary, #c3c2b7);
      --_muted: var(--lif-ink-muted, #898781);
      --_border: var(--lif-border, rgba(255, 255, 255, 0.14));
      --_grid: var(--lif-grid-color, #262624);
      --_axis: var(--lif-grid-axis-color, #3c3c38);
      --_accent: var(--lif-accent, #3987e5);
      --_node: var(--lif-node-color, #3987e5);
      --_edge: var(--lif-edge-color, #8a887f);
      --_edge-hover: var(--lif-edge-hover-color, #d6d5cc);
      --_station: var(--lif-station-color, #c98500);
      --_vehicle: var(--lif-vehicle-color, #199e70);
      --_selection: var(--lif-selection-color, #9085e9);
      --_measure: var(--lif-measure-color, #e07a4a);
      --_route: var(--lif-route-color, #008300);
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
      user-select: none;
      cursor: var(--lif-cursor, grab);
    }
    svg.panning {
      cursor: grabbing;
    }
    :host([measuring]) svg {
      cursor: crosshair;
    }
    .background {
      pointer-events: none;
    }
    .routes {
      pointer-events: none;
    }
    .scene {
      /* Gesture-time delta rides the compositor. */
      will-change: transform;
      transform-origin: 0 0;
      transform-box: view-box;
    }
    .marquee {
      fill: var(--_selection);
      fill-opacity: 0.08;
      stroke: var(--_selection);
      stroke-width: 1;
      stroke-dasharray: 4 3;
      pointer-events: none;
    }
    .node-dot.multi-selected,
    .station-box.multi-selected {
      stroke: var(--_selection);
      stroke-width: 2.5;
    }
    .edge.multi-selected {
      stroke: var(--_selection);
    }
    .route-base,
    .route-horizon {
      fill: none;
      stroke: var(--_route);
      stroke-width: 4;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.75;
    }
    .route-horizon {
      stroke-dasharray: 7 6;
      opacity: 0.45;
    }
    .route-stop-badge circle {
      fill: var(--_route);
      stroke: var(--_surface);
      stroke-width: 1.5;
    }
    .route-stop-badge text {
      fill: var(--_surface);
      font: 700 8px system-ui, sans-serif;
      text-anchor: middle;
    }
    .grid-line {
      stroke: var(--_grid);
      stroke-width: 1;
      pointer-events: none;
    }
    .grid-line.grid-axis {
      stroke: var(--_axis);
    }
    .ruler-label {
      font-size: 9.5px;
      fill: var(--_muted);
      paint-order: stroke;
      stroke: var(--_surface);
      stroke-width: 3;
      pointer-events: none;
    }
    .measure-line {
      stroke: var(--_measure);
      stroke-width: 1.5;
      stroke-dasharray: 6 4;
      stroke-linecap: round;
      pointer-events: none;
    }
    .measure-point {
      fill: var(--_measure);
      stroke: var(--_surface);
      stroke-width: 1.5;
      pointer-events: none;
    }
    .measure-seg-label {
      font-size: 10px;
      fill: var(--_ink-2);
      paint-order: stroke;
      stroke: var(--_surface);
      stroke-width: 3.5;
      pointer-events: none;
    }
    .measure-total {
      font-size: 11px;
      font-weight: 700;
      fill: var(--_measure);
      paint-order: stroke;
      stroke: var(--_surface);
      stroke-width: 3.5;
      pointer-events: none;
    }
    .edge {
      stroke: var(--_edge);
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
      transition: stroke 120ms ease;
    }
    .edge-hit {
      stroke: transparent;
      fill: none;
      cursor: pointer;
    }
    .edge.selected {
      stroke: var(--_selection);
    }
    g.edge-group:hover .edge:not(.selected) {
      stroke: var(--_edge-hover);
    }
    .node-dot {
      fill: var(--_node);
      stroke: var(--_surface);
      cursor: pointer;
      transition: filter 120ms ease;
    }
    .node-dot:hover {
      filter: brightness(0.88) saturate(1.15);
    }
    .node-theta {
      stroke: var(--_node);
      opacity: 0.65;
      fill: none;
      pointer-events: none;
    }
    .selection-ring {
      fill: none;
      stroke: var(--_selection);
      stroke-width: 2;
      opacity: 0.95;
      pointer-events: none;
    }
    .station-box {
      fill: color-mix(in srgb, var(--_station) 20%, transparent);
      stroke: var(--_station);
      cursor: pointer;
      transition: fill 120ms ease;
    }
    .station-box:hover {
      fill: color-mix(in srgb, var(--_station) 34%, transparent);
    }
    .station-link {
      stroke: var(--_station);
      stroke-dasharray: 4 3;
      opacity: 0.7;
      fill: none;
      pointer-events: none;
    }
    canvas.vehicle-layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .dimmed {
      opacity: 0.18;
    }
    /* No font-size here: world-scaled labels carry it as an attribute, and a
       CSS rule would silently override it. Fixed-size texts (ruler, measure,
       badges) declare their own sizes in their class rules. */
    text {
      fill: var(--_ink-2);
      paint-order: stroke;
      stroke: var(--_surface);
      stroke-width: 3;
      pointer-events: none;
    }
    .tabs {
      position: absolute;
      top: 10px;
      left: 10px;
      display: flex;
      gap: 2px;
      flex-wrap: wrap;
      padding: 3px;
      background: color-mix(in srgb, var(--_overlay) 88%, transparent);
      border: 1px solid var(--_border);
      border-radius: 10px;
      backdrop-filter: blur(6px);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
    }
    .tabs button {
      font: 600 12px/1 system-ui, sans-serif;
      padding: 6px 12px;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: var(--_ink-2);
      cursor: pointer;
    }
    .tabs button:hover {
      background: color-mix(in srgb, var(--_ink) 7%, transparent);
    }
    .tabs button[aria-pressed="true"] {
      background: var(--_accent);
      color: #fff;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--_muted);
      font-size: 14px;
      pointer-events: none;
    }
    .zoom-controls {
      position: absolute;
      left: 10px;
      bottom: 10px;
      z-index: 15;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      background: color-mix(in srgb, var(--_overlay) 90%, transparent);
      border: 1px solid var(--_border);
      border-radius: 11px;
      backdrop-filter: blur(6px);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
    }
    .zoom-controls button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 7px;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: var(--_ink-2);
      cursor: pointer;
      transition: background 100ms ease;
    }
    .zoom-controls button:hover {
      background: color-mix(in srgb, var(--_ink) 8%, transparent);
      color: var(--_ink);
    }
    .zoom-controls button:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--_accent) 55%, transparent);
      outline-offset: 1px;
    }
    .zoom-controls button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--_accent) 14%, transparent);
      color: var(--_accent);
    }
    .controls-sep {
      height: 1px;
      margin: 2px 4px;
      background: var(--_border);
    }
    .display-menu {
      position: absolute;
      bottom: calc(100% + 8px);
      left: 0;
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 140px;
      padding: 10px 12px;
      background: var(--_overlay);
      border: 1px solid var(--_border);
      border-radius: 10px;
      box-shadow: 0 8px 26px rgba(0, 0, 0, 0.22);
      font-size: 12.5px;
      color: var(--_ink-2);
    }
    .display-menu label {
      display: flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
      cursor: pointer;
    }
    .display-menu label.sub {
      margin-left: 20px;
    }
    .display-menu label:has(input:disabled) {
      opacity: 0.45;
      cursor: default;
    }
    .display-menu input[type="checkbox"] {
      accent-color: var(--_accent);
      width: 13px;
      height: 13px;
    }
  `;

  #isSelected(kind: "node" | "edge" | "station" | "vehicle", id: string): boolean {
    if (this.selectedId !== id) return false;
    return this.selectedKind == null || this.selectedKind === kind;
  }

  /** Layout currently displayed. */
  get layout(): Layout | undefined {
    if (!this.lif || this.lif.layouts.length === 0) return undefined;
    return this.lif.layouts.find((l) => l.layoutId === this.layoutId) ?? this.lif.layouts[0];
  }

  /** Convert a pointer event position to world coordinates (metres, y-up). */
  toWorld(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const { scale, tx, ty } = this.view;
    return { x: (px - tx) / scale, y: -(py - ty) / scale };
  }

  /** Fit the current layout into the viewport with padding. Ends follow mode. */
  fitView(): void {
    this.followVehicleId = null;
    const layout = this.layout;
    const rect = this.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 500;
    if (!layout) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const extend = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const n of layout.nodes) extend(n.nodePosition.x, n.nodePosition.y);
    for (const s of layout.stations) {
      if (s.stationPosition) extend(s.stationPosition.x, s.stationPosition.y);
    }
    for (const e of layout.edges) {
      for (const p of e.vehicleTypeEdgeProperties) {
        for (const cp of p.trajectory?.controlPoints ?? []) extend(cp.x, cp.y);
      }
    }
    if (!Number.isFinite(minX)) {
      this.view = { scale: 50, tx: width / 2, ty: height / 2 };
      this.#reproject();
      return;
    }
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = clamp(
      Math.min((width * 0.8) / spanX, (height * 0.8) / spanY),
      MIN_SCALE,
      MAX_SCALE,
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.view = { scale, tx: width / 2 - cx * scale, ty: height / 2 + cy * scale };
    this.#reproject();
  }

  protected willUpdate(changed: PropertyValues): void {
    // Fit once per document/layout combination (manual pan/zoom is preserved otherwise).
    const key = this.lif
      ? `${this.lif.layouts.map((l) => l.layoutId).join("|")}::${this.layout?.layoutId ?? ""}`
      : null;
    if (key !== this.#fittedForKey) {
      this.#fittedForKey = key;
      if (this.lif && this.autoFit) this.updateComplete.then(() => this.fitView());
    }
    if (changed.has("multiSelectedIds")) {
      this.#multiSet = new Set(this.multiSelectedIds);
    }
    // Zooming a normally-sized document re-projects immediately (before this
    // very render): marks keep their screen size and labels their clamp,
    // instead of scaling up with the delta transform and popping back at
    // rest. Pure translations stay on the (lossless) delta path.
    if (changed.has("view")) {
      const v = this.view;
      const pv = this.#projectedView;
      const layout = this.layout;
      if (
        v.scale !== pv.scale &&
        layout &&
        layout.nodes.length + layout.edges.length + layout.stations.length <=
          LIVE_ZOOM_ELEMENT_LIMIT
      ) {
        this.#projectedView = { ...v };
      }
    }
    if (changed.has("measuring") && !this.measuring) {
      this.#measurements = [];
      this.#measurePending = [];
      this.#measureCursor = null;
    }
    // Switching between length/area discards the in-progress drawing only.
    if (changed.has("measureMode") && changed.get("measureMode") !== undefined) {
      this.#measurePending = [];
      this.#measureCursor = null;
    }
  }

  protected updated(changed: PropertyValues): void {
    // Keep the canvas vehicle layer in sync with whatever the SVG render
    // reacted to (view transform, theme, filters, layout switch, selection).
    this.#resizeVehicleCanvas();
    this.#drawVehicles();
    // Lets embedders (the workspace) synchronize stacked viewers.
    if (changed.has("view")) {
      this.dispatchEvent(
        new CustomEvent("lif-view-change", {
          detail: { ...this.view },
          bubbles: true,
          composed: true,
        }),
      );
      this.#armRestReproject();
    }
  }

  /* --------------------------- vehicle overlay --------------------------- */

  #syncVehicleTweens(): void {
    const now = performance.now();
    const seen = new Set<string>();
    for (const v of this.#vehicles) {
      seen.add(v.vehicleId);
      const target: VehiclePose = { x: v.x, y: v.y, theta: v.theta };
      const current = this.#displayedPoses.get(v.vehicleId);
      if (!current || this.vehicleTransitionMs <= 0) {
        // First sighting (or interpolation disabled): appear at the target.
        this.#displayedPoses.set(v.vehicleId, target);
        this.#tweens.delete(v.vehicleId);
        continue;
      }
      if (
        current.x === target.x &&
        current.y === target.y &&
        (current.theta ?? 0) === (target.theta ?? 0)
      ) {
        this.#tweens.delete(v.vehicleId);
        continue;
      }
      this.#tweens.set(v.vehicleId, {
        from: { ...current },
        to: target,
        start: now,
        duration: this.vehicleTransitionMs,
      });
    }
    for (const id of [...this.#displayedPoses.keys()]) {
      if (!seen.has(id)) {
        this.#displayedPoses.delete(id);
        this.#tweens.delete(id);
      }
    }
    if (this.#tweens.size > 0) this.#startTweenLoop();
  }

  #startTweenLoop(): void {
    if (this.#raf !== null) return;
    const step = (): void => {
      this.#raf = null;
      const now = performance.now();
      for (const [id, tween] of [...this.#tweens]) {
        // Linear: a vehicle between two reported poses moves at constant speed.
        const k = Math.min(1, (now - tween.start) / tween.duration);
        this.#displayedPoses.set(id, {
          x: tween.from.x + (tween.to.x - tween.from.x) * k,
          y: tween.from.y + (tween.to.y - tween.from.y) * k,
          theta: lerpAngle(tween.from.theta, tween.to.theta, k),
        });
        if (k >= 1) this.#tweens.delete(id);
      }
      // Animation frames touch only the canvas layer — never the SVG scene.
      // Exception: follow mode moves the view, which re-renders the scene
      // (equivalent to the user panning continuously).
      this.#applyFollow();
      this.#drawVehicles();
      if (this.#tweens.size > 0 && this.isConnected) {
        this.#raf = requestAnimationFrame(step);
      }
    };
    this.#raf = requestAnimationFrame(step);
  }

  /** Coalesce one-off redraw requests into the next animation frame. */
  #scheduleVehicleDraw(): void {
    if (this.#vehicleDrawQueued) return;
    this.#vehicleDrawQueued = true;
    requestAnimationFrame(() => {
      this.#vehicleDrawQueued = false;
      this.#drawVehicles();
    });
  }

  get #vehicleCanvas(): HTMLCanvasElement | null {
    return this.renderRoot?.querySelector?.("canvas.vehicle-layer") ?? null;
  }

  #resizeVehicleCanvas(): void {
    const canvas = this.#vehicleCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  /**
   * Draw the fleet onto the canvas layer. Vehicles outside the viewport are
   * culled; below the label zoom threshold each vehicle becomes a plain dot
   * (LOD). Screen positions are recorded for hit-testing and
   * `getRenderedVehicles()`.
   */
  #drawVehicles(): void {
    const canvas = this.#vehicleCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = this.clientWidth;
    const height = this.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    this.#drawnVehicles = [];

    const layout = this.layout;
    if (!layout || this.#vehicles.length === 0) {
      canvas.setAttribute("aria-label", "no vehicles");
      return;
    }
    const mapIds = this.#layoutMapIds(layout);
    const styles = getComputedStyle(this);
    const vehicleColor = styles.getPropertyValue("--_vehicle").trim() || "#1baf7a";
    const surface = styles.getPropertyValue("--_surface").trim() || "#fcfcfb";
    const selectionColor = styles.getPropertyValue("--_selection").trim() || "#4a3aa7";
    const inkColor = styles.getPropertyValue("--_ink-2").trim() || "#52514e";
    const mutedColor = styles.getPropertyValue("--_muted").trim() || "#898781";
    // The canvas redraws per frame: always the live view (the SVG scene may
    // still be group-transformed mid-gesture).
    const labelPx = this.#labelPxFor(this.view.scale);
    const full = labelPx !== null;
    const margin = 40;
    let warningCount = 0;
    let errorCount = 0;

    for (const v of this.#vehicles) {
      if (!this.#vehicleVisible(v, layout, mapIds)) continue;
      const pose = this.#displayedPoses.get(v.vehicleId) ?? v;
      const p = this.#project(pose, this.view);
      if (p.x < -margin || p.y < -margin || p.x > width + margin || p.y > height + margin) {
        continue; // viewport culling
      }
      const dimmed =
        v.vehicleTypeId !== undefined && !!this.vehicleTypeId && v.vehicleTypeId !== this.vehicleTypeId;
      const selected = this.#isSelected("vehicle", v.vehicleId);
      const rotationDeg = pose.theta !== undefined ? (-pose.theta * 180) / Math.PI : 0;
      const offline = v.status === "offline";
      const statusColor =
        v.status === "error"
          ? STATUS_COLORS.error
          : v.status === "warning"
            ? STATUS_COLORS.warning
            : null;
      if (v.status === "error") errorCount++;
      if (v.status === "warning") warningCount++;
      const bodyColor = offline ? mutedColor : vehicleColor;
      ctx.globalAlpha = dimmed ? 0.18 : offline ? 0.45 : 1;

      if (!full) {
        // At dot LOD a badge glyph is illegible: the dot itself takes the
        // status color (the fleet panel/aria carry the textual channel).
        ctx.fillStyle = selected ? selectionColor : statusColor ?? bodyColor;
        ctx.beginPath();
        ctx.arc(p.x, p.y, selected || statusColor ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        if (pose.theta !== undefined) ctx.rotate((rotationDeg * Math.PI) / 180);
        if (selected) {
          ctx.strokeStyle = selectionColor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(-15, -10, 30, 20, 6);
          ctx.stroke();
        }
        ctx.fillStyle = bodyColor;
        ctx.strokeStyle = surface;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(-11, -6, 22, 12, 3);
        ctx.fill();
        ctx.stroke();
        if (pose.theta !== undefined) {
          ctx.fillStyle = surface;
          ctx.beginPath();
          ctx.moveTo(10, 0);
          ctx.lineTo(3, -4);
          ctx.lineTo(3, 4);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        if (this.showLabels && labelPx) {
          const caption = v.label ?? v.vehicleId;
          ctx.font = `${labelPx}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.lineWidth = 3;
          ctx.strokeStyle = surface;
          ctx.strokeText(caption, p.x, p.y + 12 + labelPx);
          ctx.fillStyle = inkColor;
          ctx.fillText(caption, p.x, p.y + 12 + labelPx);
        }
        if (statusColor) {
          // Screen-aligned status badge with a glyph (never color alone).
          const bx = p.x + 11;
          const by = p.y - 9;
          ctx.beginPath();
          ctx.arc(bx, by, 5, 0, Math.PI * 2);
          ctx.fillStyle = statusColor;
          ctx.fill();
          ctx.strokeStyle = surface;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.fillStyle = v.status === "error" ? STATUS_GLYPH_INK.error : STATUS_GLYPH_INK.warning;
          ctx.font = "bold 8px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("!", bx, by + 0.5);
          ctx.textBaseline = "alphabetic";
        }
      }
      this.#drawnVehicles.push({
        vehicleId: v.vehicleId,
        x: p.x,
        y: p.y,
        rotationDeg,
        lod: full ? "full" : "dot",
        selected,
        status: v.status,
      });
    }
    ctx.globalAlpha = 1;
    const parts: string[] = [];
    if (errorCount) parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
    if (warningCount) parts.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
    canvas.setAttribute(
      "aria-label",
      `${this.#drawnVehicles.length} vehicle${this.#drawnVehicles.length === 1 ? "" : "s"}` +
        (parts.length ? ` (${parts.join(", ")})` : ""),
    );
  }

  /** Screen-space info of the vehicles drawn in the last frame (tests, HTML badges…). */
  getRenderedVehicles(): readonly RenderedVehicle[] {
    return this.#drawnVehicles;
  }

  /** Topmost drawn vehicle within clicking distance of a viewer-local point. */
  #hitTestVehicles(px: number, py: number): Hit | null {
    for (let i = this.#drawnVehicles.length - 1; i >= 0; i--) {
      const v = this.#drawnVehicles[i]!;
      const r = v.lod === "dot" ? 6 : 15;
      if (Math.abs(px - v.x) <= r && Math.abs(py - v.y) <= r) {
        return { kind: "vehicle", id: v.vehicleId };
      }
    }
    return null;
  }

  /** Map ids referenced by the current layout's nodes. */
  #layoutMapIds(layout: Layout): Set<string> {
    const ids = new Set<string>();
    for (const n of layout.nodes) {
      if (n.mapId !== undefined) ids.add(n.mapId);
    }
    return ids;
  }

  #vehicleVisible(v: LifVehicle, layout: Layout, mapIds: Set<string>): boolean {
    if (v.layoutId !== undefined) return v.layoutId === layout.layoutId;
    if (v.mapId !== undefined) return mapIds.has(v.mapId);
    return true;
  }

  protected render(): TemplateResult {
    const layout = this.layout;
    return html`
      <svg
        part="canvas"
        role="application"
        aria-label=${`LIF layout${this.layout ? ` ${this.layout.layoutId}` : ""}`}
        class=${this.#gesture?.type === "pan" ? "panning" : ""}
        @pointerdown=${this.#onPointerDown}
        @pointermove=${this.#onPointerMove}
        @pointerup=${this.#onPointerUp}
        @pointercancel=${this.#onPointerCancel}
        @dblclick=${this.#onDblClick}
        @wheel=${this.#onWheel}
      >
        ${this.showGrid ? this.#renderGrid() : nothing}
        ${layout
          ? svg`<g class="scene" part="scene" style=${this.#sceneDelta()}>
              ${guard(this.#sceneDeps(layout), () => this.#renderScene(layout))}
            </g>`
          : nothing}
        ${this.#renderMeasurements()}
        ${this.#renderMarquee()}
      </svg>
      <canvas class="vehicle-layer" part="vehicle-layer" aria-label="no vehicles"></canvas>
      ${this.#renderTabs()}
      <div class="zoom-controls" part="zoom-controls" role="group" aria-label="Map controls">
        ${this.displayMenuOpen ? this.#renderDisplayMenu() : nothing}
        <button
          data-action="display-menu"
          title="Display filters"
          aria-pressed=${this.displayMenuOpen ? "true" : "false"}
          @click=${() => (this.displayMenuOpen = !this.displayMenuOpen)}
        >
          ${icons.eye()}
        </button>
        <span class="controls-sep"></span>
        <button data-action="zoom-in" title="Zoom in" @click=${() => this.zoomIn()}>
          ${icons.zoomin()}
        </button>
        <button data-action="zoom-out" title="Zoom out" @click=${() => this.zoomOut()}>
          ${icons.zoomout()}
        </button>
        <button data-action="fit-view" title="Fit &amp; centre the layout" @click=${() => this.fitView()}>
          ${icons.fit()}
        </button>
        <span class="controls-sep"></span>
        <button
          data-action="fullscreen"
          title=${this.isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          @click=${() => this.toggleFullscreen()}
        >
          ${this.isFullscreen ? icons.compress() : icons.expand()}
        </button>
      </div>
      ${layout ? nothing : html`<div class="empty">No LIF document loaded</div>`}
    `;
  }

  /** Display-filter popover; Rulers is a sub-element of Grid and follows it. */
  #renderDisplayMenu(): TemplateResult {
    const row = (
      flag: "grid" | "rulers" | "nodes" | "edges" | "trajectories" | "stations" | "labels",
      label: string,
      checked: boolean,
      set: (v: boolean) => void,
      opts: { sub?: boolean; disabled?: boolean } = {},
    ) => html`
      <label class=${opts.sub ? "sub" : ""}>
        <input
          type="checkbox"
          data-view-flag=${flag}
          .checked=${checked}
          ?disabled=${opts.disabled ?? false}
          @change=${(e: Event) => set((e.target as HTMLInputElement).checked)}
        />
        ${label}
      </label>
    `;
    return html`
      <div class="display-menu" data-panel="display-menu">
        ${row("grid", "Grid", this.showGrid, (v) => (this.showGrid = v))}
        ${row("rulers", "Rulers", this.showRulers, (v) => (this.showRulers = v), {
          sub: true,
          disabled: !this.showGrid,
        })}
        ${row("nodes", "Nodes", this.showNodes, (v) => (this.showNodes = v))}
        ${row("edges", "Edges", this.showEdges, (v) => (this.showEdges = v))}
        ${row("trajectories", "Trajectories", this.showTrajectories, (v) => (this.showTrajectories = v))}
        ${row("stations", "Stations", this.showStations, (v) => (this.showStations = v))}
        ${row("labels", "Labels", this.showLabels, (v) => (this.showLabels = v))}
      </div>
    `;
  }

  #renderTabs(): TemplateResult | typeof nothing {
    if (!this.lif || this.lif.layouts.length < 2) return nothing;
    const current = this.layout;
    return html`
      <div class="tabs" part="tabs">
        ${this.lif.layouts.map(
          (l) => html`
            <button
              aria-pressed=${l === current ? "true" : "false"}
              title=${l.layoutDescription ?? ""}
              @click=${() => this.#selectLayout(l.layoutId)}
            >
              ${l.layoutName ?? l.layoutId}
            </button>
          `,
        )}
      </div>
    `;
  }

  #selectLayout(layoutId: string): void {
    this.layoutId = layoutId;
    this.dispatchEvent(
      new CustomEvent("lif-layout-change", {
        detail: { layoutId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * World → screen projection: the single y-flip. The scene is
   * rendered in screen pixels rather than under a scaled <g>: a large,
   * rapidly changing group transform makes Chromium reuse a cached layer
   * raster (blurry until it re-rasterizes ~a second later) and loses
   * precision at deep zoom. Marker/stroke sizes below are plain pixels.
   */
  #project(
    p: { x: number; y: number },
    view: ViewTransform = this.#projectedView,
  ): { x: number; y: number } {
    const { scale, tx, ty } = view;
    return { x: p.x * scale + tx, y: -p.y * scale + ty };
  }

  /** Sync the scene projection to the live view (call when a gesture rests). */
  #reproject(): void {
    if (this.#restReprojectTimer !== null) {
      clearTimeout(this.#restReprojectTimer);
      this.#restReprojectTimer = null;
    }
    const v = this.view;
    const pv = this.#projectedView;
    if (pv.scale === v.scale && pv.tx === v.tx && pv.ty === v.ty) return;
    this.#projectedView = { ...v };
    this.requestUpdate();
  }

  /**
   * Any view change re-arms this; continuous streams (wheel bursts,
   * follow-mode ticks, workspace layer sync) keep pushing it out and ride the
   * cheap group transform, then the scene re-projects when the view rests.
   */
  #armRestReproject(): void {
    const v = this.view;
    const pv = this.#projectedView;
    if (pv.scale === v.scale && pv.tx === v.tx && pv.ty === v.ty) return;
    if (this.#restReprojectTimer !== null) clearTimeout(this.#restReprojectTimer);
    this.#restReprojectTimer = setTimeout(() => {
      this.#restReprojectTimer = null;
      this.#reproject();
    }, 150);
  }

  /**
   * Affine delta mapping the projected scene onto the live view — the whole
   * pan/zoom-gesture cost on large documents is this one style. A CSS
   * transform (not the SVG attribute) so Chromium composites the cached
   * scene raster instead of re-rasterizing the vectors every frame; the
   * transient scaling blur disappears at rest-reprojection.
   */
  #sceneDelta(): string | typeof nothing {
    const v = this.view;
    const pv = this.#projectedView;
    if (pv.scale === v.scale && pv.tx === v.tx && pv.ty === v.ty) return nothing;
    const k = v.scale / pv.scale;
    return `transform: translate(${v.tx - k * pv.tx}px, ${v.ty - k * pv.ty}px) scale(${k})`;
  }

  /** Everything the guarded scene render reads; a change re-renders it. */
  #sceneDeps(layout: Layout): unknown[] {
    return [
      this.lif,
      layout,
      this.#projectedView,
      this.selectedId,
      this.selectedKind,
      this.vehicleTypeId,
      this.multiSelectedIds,
      this.routes,
      this.backgrounds,
      this.interactiveNodes,
      this.showNodes,
      this.showEdges,
      this.showStations,
      this.showLabels,
      this.showTrajectories,
    ];
  }

  #renderScene(layout: Layout): TemplateResult {
    // All layouts feed the map (transition edges end elsewhere), but the
    // displayed layout wins for ids duplicated across layouts (invalid, yet
    // renderable) — consistent with the measure tool's snapping.
    const nodePos = new Map<string, { x: number; y: number }>();
    for (const l of this.lif?.layouts ?? []) {
      if (l === layout) continue;
      for (const n of l.nodes) nodePos.set(n.nodeId, n.nodePosition);
    }
    for (const n of layout.nodes) nodePos.set(n.nodeId, n.nodePosition);
    const reverse = new Set(layout.edges.map((e) => `${e.startNodeId}->${e.endNodeId}`));
    // Incident edge directions per node (screen space) steer label placement
    // away from the tracks; straight-line direction is accurate enough even
    // for trajectory edges.
    const incidentAngles = new Map<string, number[]>();
    const addIncident = (nodeId: string, towardsId: string): void => {
      const from = nodePos.get(nodeId);
      const to = nodePos.get(towardsId);
      if (!from || !to || (from.x === to.x && from.y === to.y)) return;
      const a = this.#project(from);
      const b = this.#project(to);
      const list = incidentAngles.get(nodeId) ?? [];
      list.push(Math.atan2(b.y - a.y, b.x - a.x));
      incidentAngles.set(nodeId, list);
    };
    for (const e of layout.edges) {
      addIncident(e.startNodeId, e.endNodeId);
      addIncident(e.endNodeId, e.startNodeId);
    }
    // Vehicles are not part of this SVG scene: they live on the canvas layer.
    // The grid, measurements and marquee live outside too: they track the
    // live view while this subtree is guarded.
    return svg`
      <g>
        ${this.#renderBackground(layout)}
        ${this.showStations ? svg`<g>${layout.stations.map((s) => this.#renderStationLinks(s, nodePos))}</g>` : nothing}
        ${this.showEdges ? svg`<g>${layout.edges.map((e) => this.#renderEdge(e, nodePos, reverse))}</g>` : nothing}
        ${this.routes.length > 0 ? svg`<g class="routes">${this.routes.map((r) => this.#renderRoute(r, layout, nodePos))}</g>` : nothing}
        ${this.showStations ? svg`<g>${layout.stations.map((s) => this.#renderStation(s, nodePos))}</g>` : nothing}
        ${this.showNodes ? svg`<g>${layout.nodes.map((n) => this.#renderNode(n, incidentAngles))}</g>` : nothing}
      </g>
    `;
  }

  /** Shift+drag rectangle; emits "lif-marquee" (world rect) on release. */
  #renderMarquee(): TemplateResult | typeof nothing {
    const m = this.#marquee;
    if (!m) return nothing;
    const x = Math.min(m.x0, m.x1);
    const y = Math.min(m.y0, m.y1);
    return svg`
      <rect
        class="marquee"
        x=${round(x)}
        y=${round(y)}
        width=${round(Math.abs(m.x1 - m.x0))}
        height=${round(Math.abs(m.y1 - m.y0))}
      ></rect>
    `;
  }

  #renderBackground(layout: Layout): TemplateResult | typeof nothing {
    const bg = this.backgrounds[layout.layoutId];
    if (!bg) return nothing;
    const { scale } = this.#projectedView;
    // x/y describe the lower-left corner; SVG images anchor at the top-left.
    const topLeft = this.#project({ x: bg.x, y: bg.y + bg.height });
    return svg`
      <image
        class="background"
        href=${bg.href}
        x=${round(topLeft.x)}
        y=${round(topLeft.y)}
        width=${round(bg.width * scale)}
        height=${round(bg.height * scale)}
        opacity=${bg.opacity ?? 0.7}
        preserveAspectRatio="none"
      ></image>
    `;
  }

  /** Metric grid with axis rulers; line spacing snaps to 1/2/5×10ⁿ metres. */
  #renderGrid(): TemplateResult | typeof nothing {
    const rect = this.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 500;
    const { scale, tx, ty } = this.view;
    const step = niceGridStep(80 / scale);
    const xMin = (0 - tx) / scale;
    const xMax = (width - tx) / scale;
    const yMin = -(height - ty) / scale;
    const yMax = -(0 - ty) / scale;

    const lines: TemplateResult[] = [];
    const labels: TemplateResult[] = [];
    for (let k = Math.ceil(xMin / step); k <= Math.floor(xMax / step); k++) {
      const wx = k * step;
      const sx = round(wx * scale + tx);
      lines.push(
        svg`<line class="grid-line ${wx === 0 ? "grid-axis" : ""}" x1=${sx} y1="0" x2=${sx} y2=${height}></line>`,
      );
      if (this.showRulers) {
        labels.push(
          svg`<text class="ruler-label" x=${sx + 3} y="12">${formatMetres(wx, step)}</text>`,
        );
      }
    }
    for (let k = Math.ceil(yMin / step); k <= Math.floor(yMax / step); k++) {
      const wy = k * step;
      const sy = round(-wy * scale + ty);
      lines.push(
        svg`<line class="grid-line ${wy === 0 ? "grid-axis" : ""}" x1="0" y1=${sy} x2=${width} y2=${sy}></line>`,
      );
      if (this.showRulers) {
        labels.push(
          svg`<text class="ruler-label" x="4" y=${sy - 3}>${formatMetres(wy, step)}</text>`,
        );
      }
    }
    return svg`<g class="grid">${lines}${labels}</g>`;
  }

  #renderMeasurements(): TemplateResult | typeof nothing {
    if (!this.measuring && this.#measurements.length === 0) return nothing;
    const live: Measurement | null =
      this.#measurePending.length > 0
        ? {
            mode: this.measureMode,
            points: this.#measureCursor
              ? [...this.#measurePending, this.#measureCursor]
              : [...this.#measurePending],
          }
        : null;
    return svg`
      <g>
        ${this.#measurements.map((m) => this.#renderMeasurement(m, false))}
        ${live ? this.#renderMeasurement(live, true) : nothing}
      </g>
    `;
  }

  #renderMeasurement(m: Measurement, live: boolean): TemplateResult {
    const pts = m.points.map((p) => this.#project(p, this.view));
    const closed = m.mode === "area" && m.points.length >= 3;
    const parts: TemplateResult[] = [];

    // Segment lines (plus the closing line for areas).
    const segmentCount = pts.length - 1 + (closed ? 1 : 0);
    for (let i = 0; i < segmentCount; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      parts.push(
        svg`<line class="measure-line" x1=${round(a.x)} y1=${round(a.y)} x2=${round(b.x)} y2=${round(b.y)}></line>`,
      );
      if (this.measureSegmentLabels) {
        const wa = m.points[i]!;
        const wb = m.points[(i + 1) % m.points.length]!;
        const d = Math.hypot(wb.x - wa.x, wb.y - wa.y);
        // A near-zero segment (rubber band to a still cursor) gets no label.
        if (d >= 0.01) {
          parts.push(
            svg`<text class="measure-seg-label" text-anchor="middle" x=${round((a.x + b.x) / 2)} y=${round((a.y + b.y) / 2 - 6)}>${formatMeasure(d)} m</text>`,
          );
        }
      }
    }

    // Vertex markers while drawing.
    if (live) {
      for (const p of pts) {
        parts.push(svg`<circle class="measure-point" cx=${round(p.x)} cy=${round(p.y)} r="3"></circle>`);
      }
    }

    // Total: polyline length at the last point, or polygon area at the centroid.
    if (m.mode === "length" && m.points.length >= 2) {
      let total = 0;
      for (let i = 1; i < m.points.length; i++) {
        total += Math.hypot(m.points[i]!.x - m.points[i - 1]!.x, m.points[i]!.y - m.points[i - 1]!.y);
      }
      const at = pts[pts.length - 1]!;
      parts.push(
        svg`<text class="measure-total" text-anchor="middle" x=${round(at.x)} y=${round(at.y - 12)}>${formatMeasure(total)} m</text>`,
      );
    } else if (m.mode === "area" && m.points.length >= 3) {
      const area = polygonArea(m.points);
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      parts.push(
        svg`<text class="measure-total" data-measure-area text-anchor="middle" x=${round(cx)} y=${round(cy)}>${formatMeasure(area)} m²</text>`,
      );
    }

    return svg`<g data-measurement data-measure-mode=${m.mode}>${parts}</g>`;
  }

  #usableByVehicleType(props: readonly { vehicleTypeId: string }[]): boolean {
    if (!this.vehicleTypeId) return true;
    return props.some((p) => p.vehicleTypeId === this.vehicleTypeId);
  }

  #renderNode(node: LifNode, incidentAngles: Map<string, number[]>): TemplateResult {
    const p = this.#project(node.nodePosition);
    const selected = this.#isSelected("node", node.nodeId);
    const dimmed = !this.#usableByVehicleType(node.vehicleTypeNodeProperties);
    const thetas = node.vehicleTypeNodeProperties
      .filter((prop) => prop.theta !== undefined)
      .map((prop) => prop.theta!);
    return svg`
      <g class=${dimmed ? "dimmed" : ""}>
        ${thetas.map(
          (theta) => svg`
            <path
              class="node-theta"
              stroke-width="1.5"
              d="M ${round(p.x)} ${round(p.y)} L ${round(p.x + Math.cos(theta) * 14)} ${round(p.y - Math.sin(theta) * 14)}"
            ></path>
          `,
        )}
        ${selected ? svg`<circle class="selection-ring" cx=${round(p.x)} cy=${round(p.y)} r="10"></circle>` : nothing}
        <circle
          class="node-dot ${selected ? "selected" : ""} ${this.#multiSet.has(node.nodeId) ? "multi-selected" : ""}"
          data-node-id=${node.nodeId}
          role="button"
          aria-label=${`Node ${node.nodeId}${node.nodeName ? `, ${node.nodeName}` : ""}`}
          cx=${round(p.x)}
          cy=${round(p.y)}
          r="6"
          stroke-width="1.5"
        >
          <title>${node.nodeId}${node.nodeName ? ` — ${node.nodeName}` : ""}</title>
        </circle>
        ${this.showLabels && this.#labelPx
          ? (() => {
              // Side with the most angular clearance from incident edges;
              // offsets keep the halo clear of the 6px marker and its ring
              // at every label size (the font box rises ~1.2× the size).
              const placed = this.#labelPlacement(
                p,
                incidentAngles.get(node.nodeId) ?? [],
                this.#labelPx!,
              );
              return this.#label(
                placed.x,
                placed.y,
                node.nodeName ?? node.nodeId,
                this.#labelPx!,
                placed.anchor,
              );
            })()
          : nothing}
      </g>
    `;
  }

  /**
   * A route overlay: base legs solid, horizon legs dashed (the
   * distinction is never color-alone), action-count badges at stops. Display
   * only — pointer events pass through to the scene beneath.
   */
  #renderRoute(
    route: LifRoute,
    layout: Layout,
    nodePos: Map<string, { x: number; y: number }>,
  ): TemplateResult | typeof nothing {
    const layoutNodeIds = new Set(layout.nodes.map((n) => n.nodeId));
    const edgeById = new Map(layout.edges.map((e) => [e.edgeId, e]));
    const basePaths: string[] = [];
    const horizonPaths: string[] = [];
    const badges: TemplateResult[] = [];
    let planned = 0;

    route.stops.forEach((stop, i) => {
      if (stop.released === false) planned++;
      const pos = nodePos.get(stop.nodeId);
      if (pos && layoutNodeIds.has(stop.nodeId) && stop.actions?.length) {
        const p = this.#project(pos);
        badges.push(svg`
          <g class="route-stop-badge" data-route-stop=${stop.nodeId}>
            <circle cx=${round(p.x + 8)} cy=${round(p.y - 8)} r="5.5"></circle>
            <text x=${round(p.x + 8)} y=${round(p.y - 8 + 2.5)}>${stop.actions.length}</text>
            <title>${stop.actions.join(", ")}</title>
          </g>
        `);
      }
      if (i === 0) return;
      const prev = route.stops[i - 1]!;
      // Cross-layout orders: draw only the legs of the displayed layout.
      if (!layoutNodeIds.has(prev.nodeId) || !layoutNodeIds.has(stop.nodeId)) return;
      const a = nodePos.get(prev.nodeId)!;
      const b = nodePos.get(stop.nodeId)!;
      const edgeId = route.edgeIds?.[i - 1];
      const edge = edgeId ? edgeById.get(edgeId) : undefined;
      const trajectory =
        edge && this.showTrajectories
          ? edge.vehicleTypeEdgeProperties
              .map((p) => p.trajectory)
              .find((t) => t && isTrajectoryEvaluable(t))
          : undefined;
      const points = trajectory
        ? sampleTrajectory(trajectory, 48).map((p) => this.#project(p))
        : [this.#project(a), this.#project(b)];
      const d = points
        .map((p, j) => `${j === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`)
        .join(" ");
      (stop.released === false ? horizonPaths : basePaths).push(d);
    });

    if (basePaths.length + horizonPaths.length + badges.length === 0) return nothing;
    const label =
      `Route ${route.label ?? route.routeId}, ${route.stops.length} stops` +
      (planned > 0 ? ` (${planned} planned)` : "");
    return svg`
      <g class="route" data-route-id=${route.routeId} role="img" aria-label=${label}>
        ${basePaths.length ? svg`<path class="route-base" d=${basePaths.join(" ")}></path>` : nothing}
        ${horizonPaths.length ? svg`<path class="route-horizon" d=${horizonPaths.join(" ")}></path>` : nothing}
        ${badges}
      </g>
    `;
  }

  #renderEdge(
    edge: LifEdge,
    nodePos: Map<string, { x: number; y: number }>,
    reverse: Set<string>,
  ): TemplateResult | typeof nothing {
    const aWorld = nodePos.get(edge.startNodeId);
    const bWorld = nodePos.get(edge.endNodeId);
    if (!aWorld || !bWorld) return nothing;
    const selected = this.#isSelected("edge", edge.edgeId);
    const dimmed = !edge.vehicleTypeEdgeProperties.some(
      (p) => !this.vehicleTypeId || p.vehicleTypeId === this.vehicleTypeId,
    );

    // Prefer the first evaluable trajectory for the path geometry.
    const trajectory = this.showTrajectories
      ? edge.vehicleTypeEdgeProperties
          .map((p) => p.trajectory)
          .find((t) => t && isTrajectoryEvaluable(t))
      : undefined;
    let points: { x: number; y: number }[];
    if (trajectory) {
      points = sampleTrajectory(trajectory, 48).map((p) => this.#project(p));
    } else {
      // Offset opposite straight edges sideways so both directions stay visible.
      const a = this.#project(aWorld);
      const b = this.#project(bWorld);
      const hasReverse = reverse.has(`${edge.endNodeId}->${edge.startNodeId}`);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (hasReverse && len > 1e-9) {
        const off = 2.5;
        const ox = (-dy / len) * off;
        const oy = (dx / len) * off;
        points = [
          { x: a.x + ox, y: a.y + oy },
          { x: b.x + ox, y: b.y + oy },
        ];
      } else {
        points = [a, b];
      }
    }
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`)
      .join(" ");

    // Direction arrow at the path midpoint.
    const mid = points[Math.floor(points.length / 2)]!;
    const prev = points[Math.max(0, Math.floor(points.length / 2) - 1)]!;
    const ang = Math.atan2(mid.y - prev.y, mid.x - prev.x);
    const arrowSize = 5;
    const arrow = `M ${round(mid.x)} ${round(mid.y)}
      L ${round(mid.x - arrowSize * Math.cos(ang - 0.45))} ${round(mid.y - arrowSize * Math.sin(ang - 0.45))}
      M ${round(mid.x)} ${round(mid.y)}
      L ${round(mid.x - arrowSize * Math.cos(ang + 0.45))} ${round(mid.y - arrowSize * Math.sin(ang + 0.45))}`;

    return svg`
      <g class="edge-group ${dimmed ? "dimmed" : ""}">
        <path
          class="edge-hit"
          data-edge-id=${edge.edgeId}
          role="button"
          aria-label=${`Edge ${edge.edgeId}, ${edge.startNodeId} to ${edge.endNodeId}`}
          d=${d}
          stroke-width="12"
        >
          <title>${edge.edgeId}${edge.edgeName ? ` — ${edge.edgeName}` : ""}</title>
        </path>
        <path class="edge ${selected ? "selected" : ""} ${this.#multiSet.has(edge.edgeId) ? "multi-selected" : ""}" d=${d} stroke-width="1.6"></path>
        <path class="edge ${selected ? "selected" : ""} ${this.#multiSet.has(edge.edgeId) ? "multi-selected" : ""}" d=${arrow} stroke-width="1.6"></path>
      </g>
    `;
  }

  /** Screen anchor for a station marker: stationPosition, or the interaction-node centroid nudged upward. */
  #stationAnchor(
    station: Station,
    nodePos: Map<string, { x: number; y: number }>,
  ): { x: number; y: number } | null {
    if (station.stationPosition) return this.#project(station.stationPosition);
    const positions = station.interactionNodeIds
      .map((id) => nodePos.get(id))
      .filter((p): p is { x: number; y: number } => !!p);
    if (positions.length === 0) return null;
    const centroid = this.#project({
      x: positions.reduce((sum, p) => sum + p.x, 0) / positions.length,
      y: positions.reduce((sum, p) => sum + p.y, 0) / positions.length,
    });
    // Nudge derived anchors off the node so the marker does not cover it.
    return { x: centroid.x, y: centroid.y - 18 };
  }

  #renderStationLinks(
    station: Station,
    nodePos: Map<string, { x: number; y: number }>,
  ): TemplateResult | typeof nothing {
    const anchor = this.#stationAnchor(station, nodePos);
    if (!anchor) return nothing;
    return svg`
      ${station.interactionNodeIds.map((id) => {
        const p = nodePos.get(id);
        if (!p) return nothing;
        const sp = this.#project(p);
        return svg`
          <path
            class="station-link"
            stroke-width="1"
            d="M ${round(anchor.x)} ${round(anchor.y)} L ${round(sp.x)} ${round(sp.y)}"
          ></path>
        `;
      })}
    `;
  }

  #renderStation(
    station: Station,
    nodePos: Map<string, { x: number; y: number }>,
  ): TemplateResult | typeof nothing {
    const anchor = this.#stationAnchor(station, nodePos);
    if (!anchor) return nothing;
    const selected = this.#isSelected("station", station.stationId);
    const theta = station.stationPosition?.theta ?? 0;
    // World angles are CCW-positive; the projected screen is y-down, so negate.
    return svg`
      <g transform="translate(${round(anchor.x)}, ${round(anchor.y)}) rotate(${round((-theta * 180) / Math.PI)})">
        ${selected ? svg`<rect class="selection-ring" x="-11" y="-11" width="22" height="22" rx="5"></rect>` : nothing}
        <rect
          class="station-box ${selected ? "selected" : ""} ${this.#multiSet.has(station.stationId) ? "multi-selected" : ""}"
          data-station-id=${station.stationId}
          role="button"
          aria-label=${`Station ${station.stationId}${station.stationName ? `, ${station.stationName}` : ""}`}
          x="-7"
          y="-7"
          width="14"
          height="14"
          rx="2.5"
          stroke-width="1.5"
        >
          <title>${station.stationId}${station.stationName ? ` — ${station.stationName}` : ""}</title>
        </rect>
      </g>
      ${this.showLabels && this.#labelPx
        ? this.#label(
            anchor.x,
            anchor.y - 13 - this.#labelPx * 0.25,
            station.stationName ?? station.stationId,
            this.#labelPx,
          )
        : nothing}
    `;
  }

  /** World-scaled label size in px, or null when too small to render. */
  #labelPxFor(scale: number): number | null {
    const px = LABEL_WORLD_EM * scale;
    if (px < LABEL_MIN_PX) return null;
    return Math.min(px, LABEL_MAX_PX);
  }

  /** Label size for the guarded SVG scene (projected view). */
  get #labelPx(): number | null {
    return this.#labelPxFor(this.#projectedView.scale);
  }

  /** Text label at a screen position, sized like a world object. */
  /**
   * Pick the label side (below/above/right/left of the node) farthest from
   * every incident edge, so labels never sit on the tracks leaving the node.
   * `angles` are incident edge directions in screen space; ties prefer below.
   */
  #labelPlacement(
    p: { x: number; y: number },
    angles: number[],
    labelPx: number,
  ): { x: number; y: number; anchor: string } {
    const candidates: Array<{ angle: number; x: number; y: number; anchor: string }> = [
      { angle: Math.PI / 2, x: p.x, y: p.y + 10 + 1.25 * labelPx, anchor: "middle" }, // below
      { angle: -Math.PI / 2, x: p.x, y: p.y - (9 + 0.3 * labelPx), anchor: "middle" }, // above
      { angle: 0, x: p.x + 11, y: p.y + 0.35 * labelPx, anchor: "start" }, // right
      { angle: Math.PI, x: p.x - 11, y: p.y + 0.35 * labelPx, anchor: "end" }, // left
    ];
    if (angles.length === 0) return candidates[0]!;
    const distance = (a: number, b: number): number => {
      const d = Math.abs(a - b) % (2 * Math.PI);
      return d > Math.PI ? 2 * Math.PI - d : d;
    };
    let best = candidates[0]!;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = Math.min(...angles.map((a) => distance(candidate.angle, a)));
      if (score > bestScore + 1e-9) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  #label(x: number, y: number, content: string, px: number, anchor = "middle"): TemplateResult {
    return svg`<text class="scene-label" font-size=${round(px)} x=${round(x)} y=${round(y)} text-anchor=${anchor}>${content}</text>`;
  }

  /* ------------------------------ input ------------------------------ */

  /** Find the LIF element under the pointer via data attributes. */
  #hitTest(ev: Event): Hit | null {
    for (const el of ev.composedPath()) {
      if (!(el instanceof Element)) continue;
      if (el === this) break;
      const nodeId = el.getAttribute?.("data-node-id");
      if (nodeId) return { kind: "node", id: nodeId };
      const edgeId = el.getAttribute?.("data-edge-id");
      if (edgeId) return { kind: "edge", id: edgeId };
      const stationId = el.getAttribute?.("data-station-id");
      if (stationId) return { kind: "station", id: stationId };
    }
    return null;
  }

  #onPointerDown(ev: PointerEvent): void {
    if (this.displayMenuOpen) this.displayMenuOpen = false;
    if (ev.button !== 0 || this.#gesture) return;
    const svgEl = ev.currentTarget as SVGElement;
    svgEl.setPointerCapture(ev.pointerId);
    const rect = this.getBoundingClientRect();

    // Shift+drag: marquee selection instead of panning.
    if (ev.shiftKey && !this.measuring) {
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      this.#gesture = { type: "marquee", pointerId: ev.pointerId, moved: false };
      this.#marquee = { x0: x, y0: y, x1: x, y1: y };
      this.requestUpdate();
      return;
    }

    // The canvas vehicle layer sits above the SVG scene: test it first.
    const hit =
      this.#hitTestVehicles(ev.clientX - rect.left, ev.clientY - rect.top) ?? this.#hitTest(ev);

    if (hit?.kind === "node" && this.interactiveNodes && !this.measuring) {
      this.#gesture = {
        type: "drag",
        pointerId: ev.pointerId,
        nodeId: hit.id,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        moved: false,
      };
      const w = this.toWorld(ev);
      this.#emitNodePointer("start", hit.id, w.x, w.y);
      return;
    }

    this.#gesture = {
      type: "pan",
      pointerId: ev.pointerId,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startTx: this.view.tx,
      startTy: this.view.ty,
      hit,
      moved: false,
    };
    this.requestUpdate();
  }

  #onPointerMove(ev: PointerEvent): void {
    if (this.measuring && this.#measurePending.length > 0) {
      this.#measureCursor = this.toWorld(ev);
      this.requestUpdate();
    }
    const g = this.#gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    if (g.type === "marquee") {
      const rect = this.getBoundingClientRect();
      const m = this.#marquee!;
      m.x1 = ev.clientX - rect.left;
      m.y1 = ev.clientY - rect.top;
      if (Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > CLICK_SLOP) g.moved = true;
      this.requestUpdate();
      return;
    }
    const dx = ev.clientX - g.startClientX;
    const dy = ev.clientY - g.startClientY;
    if (!g.moved && Math.hypot(dx, dy) <= CLICK_SLOP) return;
    g.moved = true;
    if (g.type === "pan") this.followVehicleId = null; // manual pan takes over

    if (g.type === "drag") {
      const w = this.toWorld(ev);
      this.#emitNodePointer("move", g.nodeId, w.x, w.y);
      return;
    }
    this.view = { scale: this.view.scale, tx: g.startTx + dx, ty: g.startTy + dy };
  }

  #onPointerUp(ev: PointerEvent): void {
    const g = this.#gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    this.#gesture = null;
    this.#reproject(); // a resting gesture snaps the scene back to crisp

    if (g.type === "marquee") {
      const m = this.#marquee!;
      this.#marquee = null;
      this.requestUpdate();
      if (!g.moved) return;
      const { scale, tx, ty } = this.view;
      const xs = [(m.x0 - tx) / scale, (m.x1 - tx) / scale];
      const ys = [-(m.y0 - ty) / scale, -(m.y1 - ty) / scale];
      this.dispatchEvent(
        new CustomEvent("lif-marquee", {
          detail: {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
          },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    if (g.type === "drag") {
      const w = this.toWorld(ev);
      this.#emitNodePointer("end", g.nodeId, w.x, w.y);
      if (!g.moved) this.#emitSelect("node", g.nodeId);
      return;
    }

    this.requestUpdate(); // cursor class
    if (g.moved) return;
    if (this.measuring) {
      this.#addMeasurePoint(ev, g.hit);
      return;
    }
    if (g.hit) {
      this.#emitSelect(g.hit.kind, g.hit.id);
      return;
    }
    const w = this.toWorld(ev);
    this.#emitSelect(null, null);
    this.dispatchEvent(
      new CustomEvent("lif-canvas-click", {
        detail: { x: w.x, y: w.y },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Measure-mode click: snap to a node when one was hit, else the raw point. */
  #addMeasurePoint(ev: PointerEvent, hit: Hit | null): void {
    let point = this.toWorld(ev);
    if (hit?.kind === "node" && this.lif) {
      // Displayed layout first — same duplicate-id preference as the scene.
      const display = this.layout;
      const layouts = display
        ? [display, ...this.lif.layouts.filter((l) => l !== display)]
        : this.lif.layouts;
      for (const layout of layouts) {
        const node = layout.nodes.find((n) => n.nodeId === hit.id);
        if (node) {
          point = { ...node.nodePosition };
          break;
        }
      }
    }
    // Ignore duplicates (the clicks that make up a finishing double-click).
    const last = this.#measurePending[this.#measurePending.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1e-9) return;
    this.#measurePending.push(point);
    this.requestUpdate();
  }

  #onDblClick(ev: MouseEvent): void {
    if (!this.measuring) return;
    ev.preventDefault();
    this.finishMeasurement();
  }

  #onPointerCancel(ev: PointerEvent): void {
    const g = this.#gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    this.#gesture = null;
    this.#reproject();
    this.#marquee = null;
    if (g.type === "drag") {
      const w = this.toWorld(ev);
      this.#emitNodePointer("end", g.nodeId, w.x, w.y);
    }
    this.requestUpdate();
  }

  #onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const rect = this.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const applied = scale / this.view.scale;
    this.view = {
      scale,
      tx: px - (px - this.view.tx) * applied,
      ty: py - (py - this.view.ty) * applied,
    };
    // A wheel zoom during an active pan drag re-anchors the gesture so the
    // next pointermove continues from the zoomed view instead of reverting it.
    const g = this.#gesture;
    if (g?.type === "pan") {
      g.startTx = this.view.tx - (ev.clientX - g.startClientX);
      g.startTy = this.view.ty - (ev.clientY - g.startClientY);
    }
    this.#applyFollow(); // "zooming keeps following": re-centre even without a tween running
    // No end event for wheel bursts — the rest-reprojection timer covers them.
  }

  #emitSelect(kind: LifSelectDetail["kind"], id: string | null): void {
    this.dispatchEvent(
      new CustomEvent<LifSelectDetail>("lif-select", {
        detail: { kind, id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #emitNodePointer(
    phase: LifNodePointerDetail["phase"],
    nodeId: string,
    x: number,
    y: number,
  ): void {
    this.dispatchEvent(
      new CustomEvent<LifNodePointerDetail>("lif-node-pointer", {
        detail: { phase, nodeId, x, y },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Smallest of 1/2/5×10ⁿ that is ≥ the requested world spacing. */
function niceGridStep(minStep: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(minStep, 1e-9))));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= minStep) return m * pow;
  }
  return 10 * pow;
}

function formatMetres(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return `${v.toFixed(decimals)} m`;
}

/** Measurement number: two decimals with trailing zeros stripped ("12.68", "9.7", "35"). */
function formatMeasure(v: number): string {
  return String(parseFloat(v.toFixed(2)));
}

/** Shoelace formula. */
function polygonArea(points: readonly { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Interpolate an angle along the shortest arc; missing angles jump to the target. */
function lerpAngle(from: number | undefined, to: number | undefined, k: number): number | undefined {
  if (from === undefined || to === undefined) return to;
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * k;
}

/** Keep SVG attribute data readable (0.01 px precision is plenty). */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}

customElements.define("lif-viewer", LifViewer);

declare global {
  interface HTMLElementTagNameMap {
    "lif-viewer": LifViewer;
  }
}
