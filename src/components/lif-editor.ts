/**
 * <lif-editor> — a LIF editor built on <lif-viewer>: tools for creating and
 * moving nodes, connecting edges, placing stations; a properties panel with a
 * raw-JSON escape hatch; live validation; snapshot undo/redo;
 * import/export of .lif.json files.
 *
 * Public API:
 * - `lif` property (get/set) — setting loads a document and resets history
 * - `loadJson(text)` — import with lenient parsing; returns diagnostics
 * - `exportJson()` — serialized current document (with touched timestamp)
 * - events: "lif-change" { lif }, plus the viewer's bubbling events
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  addEdge,
  addLayout,
  addNode,
  addStation,
  addVehicleTypeEverywhere,
  addVehicleTypeToElements,
  analyzeLif,
  createEmptyLif,
  findEdge,
  findLayout,
  findNode,
  findStation,
  generateNodeGrid,
  hasErrors,
  moveNode,
  parseLif,
  removeEdge,
  removeElements,
  removeLayout,
  removeNode,
  removeStation,
  removeVehicleType,
  removeVehicleTypeFromElements,
  renameEdge,
  renameLayout,
  renameNode,
  renameStation,
  renameVehicleType,
  replaceEdge,
  replaceNode,
  replaceStation,
  serializeLif,
  touchExportTimestamp,
  updateEdge,
  updateEdgePropertiesBulk,
  updateLayout,
  updateMetaInformation,
  updateNode,
  updateStation,
  validateLif,
  vehicleTypeCoverage,
  type VehicleTypeCoverage,
  type BlockingType,
  type Diagnostic,
  type GridGeneratorOptions,
  type Lif,
  type LifAction,
  type LifEdge,
  type LifNode,
  type OrientationType,
  type RequirementType,
  type RotationDirection,
  type Station,
  type VehicleTypeEdgeProperty,
  type VehicleTypeNodeProperty,
} from "../lif";
import {
  LifViewer,
  type LifBackground,
  type LifNodePointerDetail,
  type LifSelectDetail,
  type MeasureMode,
} from "./lif-viewer";
import { editorStructure } from "./editor-structure";
import { editorTheme } from "./editor-theme";
import { icons } from "./icons";

// Referencing the class keeps the side-effectful viewer registration alive
// even if a bundler tree-shakes plain `import "./lif-viewer"` side effects.
void LifViewer;

type Tool = "select" | "add-node" | "add-edge" | "add-station";

interface Selection {
  kind: "node" | "edge" | "station";
  id: string;
}

/**
 * Host-supplied description of the vehicle this editor runs on:
 * its type id, creation defaults, physical limits and supported actions —
 * typically derived from the vehicle's VDA 5050 factsheet.
 */
export interface VehicleProfile {
  vehicleTypeId: string;
  /** Applied to every newly created edge property. */
  defaults?: {
    rotationAllowed?: boolean;
    orientationType?: OrientationType;
    rotationAtStartNodeAllowed?: RotationDirection;
    rotationAtEndNodeAllowed?: RotationDirection;
    maxSpeed?: number;
    maxRotationSpeed?: number;
    minHeight?: number;
    maxHeight?: number;
    reentryAllowed?: boolean;
  };
  /** Physical capabilities; the forms warn (never block) beyond these. */
  limits?: {
    maxSpeed?: number;
    maxRotationSpeed?: number;
    minHeight?: number;
    maxHeight?: number;
  };
  /** Action palette; when absent, action types are free text. */
  supportedActions?: SupportedAction[];
}

export interface SupportedAction {
  actionType: string;
  description?: string;
  /** Where this action may be attached; default: both. */
  scopes?: Array<"NODE" | "EDGE">;
  defaultRequirementType?: RequirementType;
  defaultBlockingType?: BlockingType;
}

interface LayoutDialogState {
  mode: "create" | "edit";
  /** The layout being edited (edit mode). */
  originalId?: string;
  layoutId: string;
  layoutName: string;
  layoutVersion: string;
  layoutLevelId: string;
  layoutDescription: string;
  /** Background image draft (runtime-only). */
  bgHref: string;
  bgX: string;
  bgY: string;
  bgWidth: string;
  bgHeight: string;
  bgOpacity: string;
  confirmDelete: boolean;
  error: string | null;
}

interface GridDialogState {
  xCount: string;
  yCount: string;
  spacing: string;
  startX: string;
  startY: string;
  idPrefix: string;
  connect: GridGeneratorOptions["connect"];
  error: string | null;
}

interface SearchResult {
  kind: "node" | "edge" | "station";
  id: string;
  name?: string;
  layoutId: string;
  x: number;
  y: number;
}

const UNDO_LIMIT = 100;
const MIN_SIDEBAR_WIDTH = 180;
/** Keep at least this much room for the canvas when resizing the sidebar. */
const MIN_CANVAS_WIDTH = 320;
const SIDEBAR_KEY_STEP = 16;

export class LifEditor extends LitElement {
  static properties = {
    tool: { type: String, state: true },
    selection: { attribute: false, state: true },
    diagnostics: { attribute: false, state: true },
    showDiagnostics: { type: Boolean, state: true },
    showDocumentPanel: { type: Boolean, state: true },
    showTypesPanel: { type: Boolean, state: true },
    vehicleTypeFilter: { type: String, state: true },
    pendingEdgeStart: { type: String, state: true },
    jsonDraft: { type: String, state: true },
    jsonError: { type: String, state: true },
    opError: { type: String, state: true },
    typeRemovalArmed: { type: String, state: true },
    bulkSelection: { state: true },
    bulkDeleteArmed: { type: Boolean, state: true },
    docRevision: { type: Number, state: true },
    sidebarWidth: { attribute: false, state: true },
    doubleWay: { type: Boolean, state: true },
    chainNodes: { type: Boolean, state: true },
    measureMode: { type: Boolean, state: true },
    measureKind: { type: String, state: true },
    measureSegments: { type: Boolean, state: true },
    layoutDialog: { attribute: false, state: true },
    gridDialog: { attribute: false, state: true },
    shortcutsOpen: { type: Boolean, state: true },
    searchQuery: { type: String, state: true },
    backgrounds: { attribute: false, state: true },
    vehicleProfile: { attribute: false },
    theme: { type: String, reflect: true },
  };

  declare tool: Tool;
  declare selection: Selection | null;
  declare diagnostics: Diagnostic[];
  declare showDiagnostics: boolean;
  /** Sidebar sections with nothing selected; each has a toolbar toggle. */
  declare showDocumentPanel: boolean;
  declare showTypesPanel: boolean;
  declare vehicleTypeFilter: string;
  declare pendingEdgeStart: string | null;
  declare jsonDraft: string | null;
  declare jsonError: string | null;
  /** Error from a failed edit operation (e.g. duplicate id on rename), shown in the properties panel. */
  declare opError: string | null;
  /** Two-click confirm state for document-wide type removal. */
  declare typeRemovalArmed: string | null;
  /** Marquee (Shift+drag) selection on the current layout. */
  declare bulkSelection: { nodes: string[]; edges: string[]; stations: string[] } | null;
  declare bulkDeleteArmed: boolean;
  declare docRevision: number;
  /** Dragged sidebar width in px; null = default (the --lif-sidebar-width CSS property). */
  declare sidebarWidth: number | null;
  /** Edge creation places both directions at once. */
  declare doubleWay: boolean;
  /** Node placement auto-connects from the selected node. */
  declare chainNodes: boolean;
  declare measureMode: boolean;
  /** Length (polyline) or area (polygon) measuring. */
  declare measureKind: MeasureMode;
  /** Show per-segment length labels. */
  declare measureSegments: boolean;
  declare layoutDialog: LayoutDialogState | null;
  declare gridDialog: GridDialogState | null;
  declare shortcutsOpen: boolean;
  declare searchQuery: string;
  /** Per-layout background images (runtime-only). */
  declare backgrounds: Record<string, LifBackground>;
  /** The vehicle this editor runs on; null = generic mode. */
  declare vehicleProfile: VehicleProfile | null;
  /** "light" (default) or "dark"; propagated to the embedded viewer. */
  declare theme: "light" | "dark";

  #doc: Lif;
  #undo: Lif[] = [];
  #redo: Lif[] = [];
  #importDiagnostics: Diagnostic[] = [];
  #editedSinceLoad = false;
  #lastCommitError: string | null = null;
  #dragDoc: Lif | null = null;
  #dragMoved = false;
  #layoutId: string | null = null;
  #resizePointer: number | null = null;

  constructor() {
    super();
    this.tool = "select";
    this.selection = null;
    this.showDiagnostics = false;
    this.showDocumentPanel = true;
    this.showTypesPanel = true;
    this.vehicleTypeFilter = "";
    this.pendingEdgeStart = null;
    this.jsonDraft = null;
    this.jsonError = null;
    this.opError = null;
    this.typeRemovalArmed = null;
    this.bulkSelection = null;
    this.bulkDeleteArmed = false;
    this.docRevision = 0;
    this.sidebarWidth = null;
    this.doubleWay = false;
    this.chainNodes = false;
    this.measureMode = false;
    this.measureKind = "length";
    this.measureSegments = true;
    this.layoutDialog = null;
    this.gridDialog = null;
    this.shortcutsOpen = false;
    this.searchQuery = "";
    this.backgrounds = {};
    this.vehicleProfile = null;
    this.theme = "light";
    this.#doc = createEmptyLif();
    this.diagnostics = this.#collectDiagnostics();
  }

  /** The edited document (a live reference; treat as read-only). */
  get lif(): Lif {
    return this.#doc;
  }

  /** Load a document programmatically; resets history and selection. */
  set lif(value: Lif) {
    this.#doc = structuredClone(value);
    this.#resetForNewDocument([]);
  }

  /** Import LIF JSON (lenient); returns the parse diagnostics. */
  loadJson(text: string): Diagnostic[] {
    const { lif, diagnostics } = parseLif(text);
    this.#doc = lif;
    this.#resetForNewDocument(diagnostics);
    return diagnostics;
  }

  /** Serialize the current document, updating metaInformation.exportTimestamp. */
  exportJson(): string {
    return serializeLif(touchExportTimestamp(this.#doc));
  }

  undo(): void {
    const prev = this.#undo.pop();
    if (!prev) return;
    this.#redo.push(this.#doc);
    this.#doc = prev;
    this.#afterDocChange();
  }

  redo(): void {
    const next = this.#redo.pop();
    if (!next) return;
    this.#undo.push(this.#doc);
    this.#doc = next;
    this.#afterDocChange();
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  #resetForNewDocument(importDiagnostics: Diagnostic[]): void {
    this.#undo = [];
    this.#redo = [];
    this.#importDiagnostics = importDiagnostics;
    this.#editedSinceLoad = false;
    this.selection = null;
    this.pendingEdgeStart = null;
    this.#layoutId = null;
    this.backgrounds = {};
    this.layoutDialog = null;
    this.gridDialog = null;
    this.searchQuery = "";
    this.#afterDocChange();
  }

  /**
   * Apply an operation as one undoable step. On failure the message is stored
   * in `#lastCommitError` (not shown anywhere by itself) and `false` is
   * returned; the caller decides where to surface it.
   */
  #commit(op: (doc: Lif) => Lif): boolean {
    let next: Lif;
    try {
      next = op(this.#doc);
    } catch (e) {
      this.#lastCommitError = (e as Error).message;
      return false;
    }
    this.#lastCommitError = null;
    this.#undo.push(this.#doc);
    if (this.#undo.length > UNDO_LIMIT) this.#undo.shift();
    this.#redo = [];
    this.#doc = next;
    // Load-time normalization notices describe the imported bytes; once the
    // document is edited they no longer describe its current state.
    this.#editedSinceLoad = true;
    this.#afterDocChange();
    return true;
  }

  #afterDocChange(): void {
    this.diagnostics = this.#collectDiagnostics();
    this.jsonDraft = null;
    this.jsonError = null;
    this.opError = null;
    this.docRevision++;
    // Drop a selection that no longer resolves (e.g. after undo of an add).
    if (this.selection && !this.#resolveSelection(this.selection)) this.selection = null;
    if (this.bulkSelection) {
      const pruned = {
        nodes: this.bulkSelection.nodes.filter((id) => findNode(this.#doc, id)),
        edges: this.bulkSelection.edges.filter((id) => findEdge(this.#doc, id)),
        stations: this.bulkSelection.stations.filter((id) => findStation(this.#doc, id)),
      };
      this.bulkSelection =
        pruned.nodes.length + pruned.edges.length + pruned.stations.length > 0 ? pruned : null;
    }
    this.dispatchEvent(
      new CustomEvent("lif-change", {
        detail: { lif: this.#doc },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Diagnostics reflect the *current* document, not a stale import snapshot:
   * the document is re-parsed each time so structural problems introduced
   * through the raw-JSON escape hatch (which bypasses parseLif) surface, and
   * semantics are re-validated. Load-time normalization notices are shown
   * until the first edit, then age out. Deduplicated so a persistent
   * structural error is not double-counted with its import notice.
   */
  #collectDiagnostics(): Diagnostic[] {
    const current = [
      ...parseLif(this.#doc).diagnostics,
      ...validateLif(this.#doc),
      ...analyzeLif(this.#doc),
    ];
    const combined = this.#editedSinceLoad ? current : [...this.#importDiagnostics, ...current];
    const seen = new Set<string>();
    return combined.filter((d) => {
      const key = `${d.severity}|${d.code}|${d.path}|${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  #resolveSelection(sel: Selection): LifNode | LifEdge | Station | undefined {
    if (sel.kind === "node") return findNode(this.#doc, sel.id)?.node;
    if (sel.kind === "edge") return findEdge(this.#doc, sel.id)?.edge;
    return findStation(this.#doc, sel.id)?.station;
  }

  get #currentLayoutId(): string {
    const layouts = this.#doc.layouts;
    const found = layouts.find((l) => l.layoutId === this.#layoutId);
    return (found ?? layouts[0])?.layoutId ?? "";
  }

  get #vehicleTypes(): string[] {
    const types = new Set<string>();
    for (const layout of this.#doc.layouts) {
      for (const n of layout.nodes)
        for (const p of n.vehicleTypeNodeProperties) types.add(p.vehicleTypeId);
      for (const e of layout.edges)
        for (const p of e.vehicleTypeEdgeProperties) types.add(p.vehicleTypeId);
    }
    return [...types].sort();
  }

  #freshId(prefix: string, exists: (id: string) => boolean): string {
    for (let i = 1; ; i++) {
      const id = `${prefix}${i}`;
      if (!exists(id)) return id;
    }
  }

  /* ------------------------------ styles ------------------------------ */

  static styles = [editorStructure, editorTheme];

  /* ------------------------------ render ------------------------------ */

  protected willUpdate(): void {
    this.setAttribute("data-tool", this.tool);
    if (this.sidebarWidth !== null) {
      this.style.setProperty("--lif-sidebar-width", `${this.sidebarWidth}px`);
    } else {
      this.style.removeProperty("--lif-sidebar-width");
    }
  }

  protected render(): TemplateResult {
    const errors = this.diagnostics.filter((d) => d.severity === "error").length;
    return html`
      <div class="toolbar" part="toolbar">
        <div class="group" role="group" aria-label="Canvas">
          <button class="icon-only" data-action="create-layout" title="Create layout" @click=${() => this.#openLayoutDialog("create")}>
            ${icons.layerplus()}
          </button>
          <button class="icon-only" data-action="edit-layout" title="Edit current layout" @click=${() => this.#openLayoutDialog("edit")}>
            ${icons.layeredit()}
          </button>
        </div>
        <label title="Vehicle type filter">
          Type
          <select data-action="vehicle-filter" @change=${(e: Event) => (this.vehicleTypeFilter = (e.target as HTMLSelectElement).value)}>
            <option value="">(all)</option>
            ${this.#vehicleTypes.map(
              (t) => html`<option value=${t} ?selected=${t === this.vehicleTypeFilter}>${t}</option>`,
            )}
          </select>
        </label>
        <span class="spacer"></span>
        <div class="group" role="group" aria-label="File">
          <button data-action="new" title="New document" @click=${this.#newDocument}>${icons.file()} New</button>
          <button data-action="import" title="Import a .lif.json file" @click=${() => this.#fileInput?.click()}>
            ${icons.open()} Import
          </button>
          <button data-action="export" title="Export LIF JSON" @click=${this.#download}>${icons.download()} Export</button>
        </div>
        <div class="group" role="group" aria-label="Status">
          <button
            data-action="toggle-document"
            aria-pressed=${this.showDocumentPanel ? "true" : "false"}
            title="Document panel (project, creator, export info)"
            @click=${() => (this.showDocumentPanel = !this.showDocumentPanel)}
          >
            ${icons.file()} Document
          </button>
          <button
            data-action="toggle-types"
            aria-pressed=${this.showTypesPanel ? "true" : "false"}
            title="Vehicle types manager"
            @click=${() => (this.showTypesPanel = !this.showTypesPanel)}
          >
            ${icons.truck()} Types
          </button>
          <button
            data-action="toggle-diagnostics"
            aria-pressed=${this.showDiagnostics ? "true" : "false"}
            title="Validation findings"
            @click=${() => (this.showDiagnostics = !this.showDiagnostics)}
          >
            ${icons.shield()} Checks<span class="badge ${errors ? "has-errors" : ""}">${this.diagnostics.length}</span>
          </button>
          <button
            class="icon-only"
            data-action="theme"
            title=${this.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            @click=${() => (this.theme = this.theme === "dark" ? "light" : "dark")}
          >
            ${this.theme === "dark" ? icons.sun() : icons.moon()}
          </button>
        </div>
        <input
          type="file"
          accept=".json,.lif,application/json"
          hidden
          @change=${this.#onFileChosen}
        />
      </div>

      <div
        class="canvas-wrap"
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${this.#onDrop}
      >
        <lif-viewer
          theme=${this.theme}
          .fullscreenTarget=${this}
          .lif=${this.#dragDoc ?? this.#doc}
          .selectedId=${this.pendingEdgeStart ?? this.selection?.id ?? null}
          .selectedKind=${this.pendingEdgeStart ? "node" : (this.selection?.kind ?? null)}
          .vehicleTypeId=${this.vehicleTypeFilter || null}
          .layoutId=${this.#currentLayoutId}
          .backgrounds=${this.backgrounds}
          .measuring=${this.measureMode}
          .measureMode=${this.measureKind}
          .measureSegmentLabels=${this.measureSegments}
          .multiSelectedIds=${this.bulkSelection
            ? [...this.bulkSelection.nodes, ...this.bulkSelection.edges, ...this.bulkSelection.stations]
            : []}
          interactive-nodes
          @lif-select=${this.#onSelect}
          @lif-canvas-click=${this.#onCanvasClick}
          @lif-node-pointer=${this.#onNodePointer}
          @lif-marquee=${this.#onMarquee}
          @lif-layout-change=${(e: CustomEvent<{ layoutId: string }>) => {
            this.#layoutId = e.detail.layoutId;
            this.requestUpdate();
          }}
        ></lif-viewer>
        ${this.tool === "add-edge"
          ? html`<div class="hint">
              ${this.pendingEdgeStart
                ? `Edge from "${this.pendingEdgeStart}" — click the end node (Esc cancels)`
                : "Click the start node"}
            </div>`
          : nothing}
        ${this.tool === "add-station" ? html`<div class="hint">Click a node to attach a station</div>` : nothing}
        ${this.#renderToolPalette()}
      </div>

      <div
        class="resizer"
        part="resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar (drag, arrow keys, double-click to reset)"
        tabindex="0"
        @pointerdown=${this.#onResizerPointerDown}
        @pointermove=${this.#onResizerPointerMove}
        @pointerup=${this.#onResizerPointerUp}
        @pointercancel=${this.#onResizerPointerUp}
        @dblclick=${() => (this.sidebarWidth = null)}
        @keydown=${this.#onResizerKeyDown}
      ></div>

      <div class="sidebar" part="sidebar">
        <div class="search-box">
          <input
            data-field="search"
            type="search"
            placeholder="Search elements…"
            .value=${this.searchQuery}
            @input=${(e: Event) => (this.searchQuery = (e.target as HTMLInputElement).value)}
          />
        </div>
        ${this.searchQuery.trim() ? this.#renderSearchResults() : nothing}
        ${this.#renderProperties()}
        ${this.showDiagnostics ? this.#renderDiagnostics() : nothing}
      </div>

      ${this.#renderStatusBar()}
      ${this.layoutDialog ? this.#renderLayoutDialog(this.layoutDialog) : nothing}
      ${this.gridDialog ? this.#renderGridDialog(this.gridDialog) : nothing}
      ${this.shortcutsOpen ? this.#renderShortcuts() : nothing}
    `;
  }

  /* --------------------------- shortcuts help --------------------------- */

  #renderShortcuts(): TemplateResult {
    const rows: Array<[keys: string, what: string]> = [
      ["V", "Select tool"],
      ["N", "Add node tool"],
      ["E", "Add edge tool"],
      ["S", "Add station tool"],
      ["M", "Measure on/off"],
      ["D", "2-way edges on/off"],
      ["C", "Chain placement on/off"],
      ["G", "Grid on/off (rulers follow)"],
      ["F", "Fullscreen on/off"],
      ["+ / −", "Zoom in / out"],
      ["0", "Fit & centre the layout"],
      ["← ↑ → ↓", "Nudge selected node 0.1 m"],
      ["Shift + arrows", "Nudge selected node 1 m"],
      ["Shift + drag", "Marquee: select many elements"],
      ["Del", "Delete selection"],
      ["Ctrl+Z", "Undo"],
      ["Ctrl+Shift+Z / Ctrl+Y", "Redo"],
      ["Ctrl+O", "Import LIF file"],
      ["Ctrl+S", "Export LIF file"],
      ["/", "Search elements"],
      ["Esc", "Cancel / close / deselect"],
      ["?", "This overview"],
    ];
    return html`
      <div class="dialog-backdrop" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.shortcutsOpen = false;
      }}>
        <div class="dialog" data-panel="shortcuts">
          <h2>Keyboard shortcuts</h2>
          <div class="shortcut-grid">
            ${rows.map(
              ([keys, what]) => html`
                <span class="keys">${keys.split(" ").map((k) =>
                  k === "/" || /^[+−?]$/.test(k) || k.length > 1
                    ? html`<kbd>${k}</kbd> `
                    : html`${k} `,
                )}</span>
                <span>${what}</span>
              `,
            )}
          </div>
          <div class="buttons">
            <button data-action="close-shortcuts" @click=${() => (this.shortcutsOpen = false)}>Close</button>
          </div>
        </div>
      </div>
    `;
  }

  /* ---------------------------- tool palette ---------------------------- */

  /** Floating vertical tool palette, overlaid mid-right on the map view. */
  #renderToolPalette(): TemplateResult {
    const toolIcon = {
      select: icons.pointer(),
      "add-node": icons.node(),
      "add-edge": icons.edge(),
      "add-station": icons.station(),
    } as const;
    const toolTitle = {
      select: "Select — drag nodes to move them",
      "add-node": "Add node — click the map",
      "add-edge": "Add edge — click start node, then end node",
      "add-station": "Add station — click a node",
    } as const;
    return html`
      <div
        class="tool-palette"
        part="tool-palette"
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Editing tools"
      >
        ${(["select", "add-node", "add-edge", "add-station"] as const).map(
          (tool) => html`
            <button
              class="icon-only"
              data-tool-button=${tool}
              title=${toolTitle[tool]}
              aria-pressed=${this.tool === tool ? "true" : "false"}
              @click=${() => this.#setTool(tool)}
            >
              ${toolIcon[tool]}
            </button>
          `,
        )}
        <span class="palette-sep"></span>
        <button
          class="icon-only"
          data-action="double-way"
          aria-pressed=${this.doubleWay ? "true" : "false"}
          title="2-way: create edges in both directions"
          @click=${() => (this.doubleWay = !this.doubleWay)}
        >
          ${icons.twoway()}
        </button>
        <button
          class="icon-only"
          data-action="chain"
          aria-pressed=${this.chainNodes ? "true" : "false"}
          title="Chain: connect each placed node from the selected one"
          @click=${() => (this.chainNodes = !this.chainNodes)}
        >
          ${icons.chain()}
        </button>
        <span class="palette-sep"></span>
        <button
          class="icon-only"
          data-action="measure"
          aria-pressed=${this.measureMode ? "true" : "false"}
          title="Measure (Esc exits)"
          @click=${() => (this.measureMode = !this.measureMode)}
        >
          ${icons.ruler()}
        </button>
        ${this.measureMode
          ? html`
              <div class="palette-sub" role="group" aria-label="Measure options">
                <button
                  class="icon-only"
                  data-action="measure-length"
                  title="Measure Length"
                  aria-pressed=${this.measureKind === "length" ? "true" : "false"}
                  @click=${() => (this.measureKind = "length")}
                >
                  ${icons.length()}
                </button>
                <button
                  class="icon-only"
                  data-action="measure-area"
                  title="Measure Area"
                  aria-pressed=${this.measureKind === "area" ? "true" : "false"}
                  @click=${() => (this.measureKind = "area")}
                >
                  ${icons.area()}
                </button>
                <button
                  class="icon-only"
                  data-action="measure-segments"
                  title="Show Segment Lengths"
                  aria-pressed=${this.measureSegments ? "true" : "false"}
                  @click=${() => (this.measureSegments = !this.measureSegments)}
                >
                  ${icons.hash()}
                </button>
                <button
                  class="icon-only"
                  data-action="measure-clear"
                  title="Clear Previous Measure"
                  @click=${() => this.#viewer?.clearLastMeasurement()}
                >
                  ${icons.eraser()}
                </button>
              </div>
            `
          : nothing}
        <span class="palette-sep"></span>
        <button
          class="icon-only"
          data-action="grid-generator"
          title="Generate a grid of nodes"
          @click=${this.#openGridDialog}
        >
          ${icons.gridgen()}
        </button>
        <span class="palette-sep"></span>
        <button
          class="icon-only"
          data-action="undo"
          ?disabled=${!this.canUndo}
          title="Undo (Ctrl+Z)"
          @click=${() => this.undo()}
        >
          ${icons.undo()}
        </button>
        <button
          class="icon-only"
          data-action="redo"
          ?disabled=${!this.canRedo}
          title="Redo (Ctrl+Shift+Z)"
          @click=${() => this.redo()}
        >
          ${icons.redo()}
        </button>
        <button
          class="icon-only"
          data-action="delete"
          ?disabled=${!this.selection}
          title="Delete selected (Del)"
          @click=${this.#deleteSelection}
        >
          ${icons.trash()}
        </button>
      </div>
    `;
  }

  /* ------------------------------ search ------------------------------ */

  #searchResults(): SearchResult[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return [];
    const results: SearchResult[] = [];
    const nodePos = new Map<string, { x: number; y: number }>();
    for (const layout of this.#doc.layouts) {
      for (const n of layout.nodes) nodePos.set(n.nodeId, n.nodePosition);
    }
    const matches = (id: string, name?: string) =>
      id.toLowerCase().includes(q) || (name ?? "").toLowerCase().includes(q);
    for (const layout of this.#doc.layouts) {
      for (const n of layout.nodes) {
        if (matches(n.nodeId, n.nodeName)) {
          results.push({ kind: "node", id: n.nodeId, name: n.nodeName, layoutId: layout.layoutId, ...n.nodePosition });
        }
      }
      for (const e of layout.edges) {
        if (matches(e.edgeId, e.edgeName)) {
          const a = nodePos.get(e.startNodeId);
          const b = nodePos.get(e.endNodeId);
          const x = a && b ? (a.x + b.x) / 2 : (a?.x ?? b?.x ?? 0);
          const y = a && b ? (a.y + b.y) / 2 : (a?.y ?? b?.y ?? 0);
          results.push({ kind: "edge", id: e.edgeId, name: e.edgeName, layoutId: layout.layoutId, x, y });
        }
      }
      for (const s of layout.stations) {
        if (matches(s.stationId, s.stationName)) {
          const p = s.stationPosition ?? nodePos.get(s.interactionNodeIds[0] ?? "") ?? { x: 0, y: 0 };
          results.push({ kind: "station", id: s.stationId, name: s.stationName, layoutId: layout.layoutId, x: p.x, y: p.y });
        }
      }
    }
    return results.slice(0, 30);
  }

  #renderSearchResults(): TemplateResult {
    const results = this.#searchResults();
    return html`
      <ul class="search-results" data-panel="search-results">
        ${results.length === 0 ? html`<li class="muted">No matches</li>` : nothing}
        ${results.map(
          (r) => html`
            <li data-result-id=${r.id} @click=${() => this.#gotoSearchResult(r)}>
              <span class="kind kind-${r.kind}">${r.kind[0]!.toUpperCase()}</span>
              <span>${r.id}${r.name ? ` — ${r.name}` : ""}</span>
              <span class="layout-tag">${r.layoutId}</span>
            </li>
          `,
        )}
      </ul>
    `;
  }

  #gotoSearchResult(r: SearchResult): void {
    this.#layoutId = r.layoutId;
    this.selection = { kind: r.kind, id: r.id };
    this.requestUpdate();
    // A layout switch schedules the viewer's auto-fit; centre after it settled.
    this.updateComplete.then(async () => {
      const viewer = this.#viewer;
      if (!viewer) return;
      await viewer.updateComplete;
      setTimeout(() => viewer.centerOn(r.x, r.y), 0);
    });
  }

  /* ------------------------------ status bar ------------------------------ */

  #renderStatusBar(): TemplateResult {
    const layout = findLayout(this.#doc, this.#currentLayoutId);
    const errors = this.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = this.diagnostics.filter((d) => d.severity === "warning").length;
    return html`
      <div class="status" part="status" data-panel="status">
        <span data-stat="layout">Layout: ${layout?.layoutId ?? "—"} (${this.#doc.layouts.length} total)</span>
        <span data-stat="nodes">Nodes: ${layout?.nodes.length ?? 0}</span>
        <span data-stat="edges">Edges: ${layout?.edges.length ?? 0}</span>
        <span data-stat="stations">Stations: ${layout?.stations.length ?? 0}</span>
        ${this.measureMode
          ? html`<span data-stat="measure">
              Measuring ${this.measureKind === "area" ? "area" : "length"} — click points,
              double-click to finish, Esc cancels/exits
            </span>`
          : nothing}
        <span class="spacer"></span>
        <button
          data-action="shortcuts"
          title="Keyboard shortcuts (?)"
          @click=${() => (this.shortcutsOpen = true)}
        >
          ${icons.keyboard()}
        </button>
        <button data-action="status-checks" @click=${() => (this.showDiagnostics = !this.showDiagnostics)}>
          ${errors > 0 ? html`<span class="stat-errors">${errors} error${errors === 1 ? "" : "s"}</span>` : "no errors"}
          ${warnings > 0 ? html`<span class="stat-warnings">· ${warnings} warning${warnings === 1 ? "" : "s"}</span>` : nothing}
        </button>
      </div>
    `;
  }

  /* --------------------------- sidebar resize --------------------------- */

  get #currentSidebarWidth(): number {
    if (this.sidebarWidth !== null) return this.sidebarWidth;
    const sidebar = this.renderRoot.querySelector(".sidebar");
    return sidebar?.getBoundingClientRect().width ?? 280;
  }

  #clampSidebarWidth(width: number): number {
    const host = this.getBoundingClientRect().width || 1000;
    const max = Math.max(MIN_SIDEBAR_WIDTH, host - MIN_CANVAS_WIDTH);
    return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), max));
  }

  #onResizerPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.#resizePointer = ev.pointerId;
  };

  #onResizerPointerMove = (ev: PointerEvent): void => {
    if (this.#resizePointer !== ev.pointerId) return;
    // The sidebar spans from just right of the pointer to the host's right edge.
    const width = this.getBoundingClientRect().right - ev.clientX - 3;
    this.sidebarWidth = this.#clampSidebarWidth(width);
  };

  #onResizerPointerUp = (ev: PointerEvent): void => {
    if (this.#resizePointer === ev.pointerId) this.#resizePointer = null;
  };

  #onResizerKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    ev.stopPropagation();
    const delta = ev.key === "ArrowLeft" ? SIDEBAR_KEY_STEP : -SIDEBAR_KEY_STEP;
    this.sidebarWidth = this.#clampSidebarWidth(this.#currentSidebarWidth + delta);
  };

  get #fileInput(): HTMLInputElement | null {
    return this.renderRoot.querySelector('input[type="file"]');
  }

  get #viewer(): LifViewer | null {
    return this.renderRoot.querySelector("lif-viewer");
  }

  #renderDiagnostics(): TemplateResult {
    return html`
      <div class="panel">
        <h3>Checks</h3>
        ${this.diagnostics.length === 0
          ? html`<div class="muted">No findings — document is clean.</div>`
          : html`
              <ul class="diagnostics">
                ${this.diagnostics.map(
                  (d) => html`
                    <li class="severity-${d.severity}">
                      <span class="code">${d.code}</span>${d.message}
                      <span class="path">${d.path}</span>
                    </li>
                  `,
                )}
              </ul>
            `}
      </div>
    `;
  }

  #renderProperties(): TemplateResult {
    if (this.bulkSelection) return this.#renderBulkPanel();
    const sel = this.selection;
    const element = sel ? this.#resolveSelection(sel) : undefined;
    // Nothing selected: independent sections, each with a toolbar toggle so
    // e.g. the checks list can take the whole sidebar height.
    if (!sel || !element) {
      return html`
        ${this.showDocumentPanel ? this.#renderDocumentProperties() : nothing}
        ${this.showTypesPanel
          ? html`<div class="panel" data-panel="vehicle-types">${this.#renderTypesManager()}</div>`
          : nothing}
      `;
    }
    return html`
      <div class="panel" data-panel="properties">
        <h3>${sel.kind} properties</h3>
        ${this.opError ? html`<div class="error" data-op-error>${this.opError}</div>` : nothing}
        ${sel.kind === "node" ? this.#renderNodeFields(element as LifNode) : nothing}
        ${sel.kind === "edge" ? this.#renderEdgeFields(element as LifEdge) : nothing}
        ${sel.kind === "station" ? this.#renderStationFields(element as Station) : nothing}
        ${this.#renderJsonEditor(element)}
      </div>
    `;
  }

  /* ------------------------ bulk selection ------------------------ */

  #bulkDelete(): void {
    if (!this.bulkSelection) return;
    if (!this.bulkDeleteArmed) {
      this.bulkDeleteArmed = true;
      return;
    }
    const { nodes, edges, stations } = this.bulkSelection;
    this.bulkDeleteArmed = false;
    if (
      this.#commit((d) =>
        removeElements(d, { nodeIds: nodes, edgeIds: edges, stationIds: stations }),
      )
    ) {
      this.bulkSelection = null;
    }
  }

  #renderBulkPanel(): TemplateResult {
    const { nodes, edges, stations } = this.bulkSelection!;
    const total = nodes.length + edges.length + stations.length;
    const types = [
      ...new Set([
        ...(this.vehicleProfile ? [this.vehicleProfile.vehicleTypeId] : []),
        ...this.#vehicleTypes,
      ]),
    ];
    return html`
      <div class="panel" data-panel="bulk">
        <h3>Bulk selection</h3>
        ${this.opError ? html`<div class="error" data-op-error>${this.opError}</div>` : nothing}
        <div class="muted" data-bulk-counts>
          ${nodes.length} node${nodes.length === 1 ? "" : "s"} ·
          ${edges.length} edge${edges.length === 1 ? "" : "s"} ·
          ${stations.length} station${stations.length === 1 ? "" : "s"}
        </div>
        <button data-action="clear-bulk" @click=${() => this.#clearBulkSelection()}>
          Clear selection (Esc)
        </button>

        <h3>Vehicle type</h3>
        <div class="field">
          <label>Type</label>
          <select data-field="bulkType">
            ${types.map((t) => html`<option value=${t}>${t}</option>`)}
          </select>
        </div>
        <button
          data-action="bulk-enable-type"
          title="Add the type to every selected node and edge that lacks it"
          @click=${() => {
            const typeId = this.#bulkTypeChoice();
            if (!typeId) return;
            this.#commit((d) =>
              addVehicleTypeToElements(
                d,
                { nodeIds: nodes, edgeIds: edges },
                typeId,
                typeId === this.vehicleProfile?.vehicleTypeId
                  ? { edge: { rotationAllowed: false, ...this.#profileEdgeDefaults() } }
                  : undefined,
              ),
            );
          }}
        >
          Enable on selection
        </button>
        <button
          data-action="bulk-remove-type"
          title="Remove the type from every selected node and edge"
          @click=${() => {
            const typeId = this.#bulkTypeChoice();
            if (!typeId) return;
            this.#commit((d) =>
              removeVehicleTypeFromElements(d, { nodeIds: nodes, edgeIds: edges }, typeId),
            );
          }}
        >
          Remove from selection
        </button>

        ${edges.length > 0
          ? html`
              <h3>Edge properties (${edges.length})</h3>
              <div class="field">
                <label>Max speed</label>
                <input data-field="bulkMaxSpeed" type="number" step="0.1" placeholder="(leave)" />
              </div>
              <div class="field">
                <label>Rotation</label>
                <select data-field="bulkRotation">
                  <option value="">(leave)</option>
                  <option value="true">allowed</option>
                  <option value="false">forbidden</option>
                </select>
              </div>
              <button
                data-action="bulk-apply-edges"
                title="Merge into the chosen type's entries on the selected edges"
                @click=${() => this.#bulkApplyEdges(edges)}
              >
                Apply to edges
              </button>
            `
          : nothing}

        <h3>Danger</h3>
        <button data-action="bulk-delete" @click=${() => this.#bulkDelete()}>
          ${this.bulkDeleteArmed ? "Confirm: delete" : "Delete"} ${total} element${total === 1 ? "" : "s"}
        </button>
      </div>
    `;
  }

  #bulkTypeChoice(): string | null {
    return (
      this.renderRoot.querySelector<HTMLSelectElement>('select[data-field="bulkType"]')?.value ??
      null
    );
  }

  #bulkApplyEdges(edgeIds: string[]): void {
    const typeId = this.#bulkTypeChoice();
    if (!typeId) return;
    const speedRaw = this.renderRoot
      .querySelector<HTMLInputElement>('input[data-field="bulkMaxSpeed"]')
      ?.value.trim();
    const rotationRaw = this.renderRoot.querySelector<HTMLSelectElement>(
      'select[data-field="bulkRotation"]',
    )?.value;
    const patch: { maxSpeed?: number; rotationAllowed?: boolean } = {};
    if (speedRaw) {
      const v = Number(speedRaw);
      if (Number.isFinite(v)) patch.maxSpeed = v;
    }
    if (rotationRaw === "true" || rotationRaw === "false") {
      patch.rotationAllowed = rotationRaw === "true";
    }
    if (Object.keys(patch).length === 0) return;
    this.#commit((d) => updateEdgePropertiesBulk(d, edgeIds, typeId, patch));
  }

  #renderDocumentProperties(): TemplateResult {
    const meta = this.#doc.metaInformation;
    return html`
      <div class="panel" data-panel="document">
        <h3>Document</h3>
        <div class="field">
          <label>Project</label>
          <input
            data-field="projectIdentification"
            .value=${meta.projectIdentification ?? ""}
            @change=${(e: Event) =>
              this.#commit((d) =>
                updateMetaInformation(d, {
                  projectIdentification: (e.target as HTMLInputElement).value,
                }),
              )}
          />
        </div>
        <div class="field">
          <label>Creator</label>
          <input
            data-field="creator"
            .value=${meta.creator ?? ""}
            @change=${(e: Event) =>
              this.#commit((d) =>
                updateMetaInformation(d, { creator: (e.target as HTMLInputElement).value }),
              )}
          />
        </div>
        <div class="field">
          <label>LIF version</label>
          <input .value=${meta.lifVersion ?? ""} disabled />
        </div>
        <div class="field">
          <label>Exported</label>
          <input .value=${meta.exportTimestamp ?? ""} disabled />
        </div>
        <div class="muted">
          Select an element to edit it. Layouts: ${this.#doc.layouts.length}, current:
          ${this.#currentLayoutId || "—"}
        </div>
      </div>
    `;
  }

  /* ------------------- vehicle types manager ------------------- */

  #renderTypesManager(): TemplateResult {
    const coverage = vehicleTypeCoverage(this.#doc);
    return html`
      <h3>Vehicle types</h3>
      ${this.opError ? html`<div class="error" data-op-error>${this.opError}</div>` : nothing}
      ${coverage.length === 0
        ? html`<div class="muted">No vehicle types in the document yet.</div>`
        : coverage.map((c) => this.#renderTypeRow(c))}
      <div class="field">
        <label>New type</label>
        <input data-field="newTypeId" placeholder="e.g. acme.lifter" />
      </div>
      <button data-action="add-type-everywhere" @click=${this.#addNewTypeEverywhere}>
        Add to all nodes &amp; edges
      </button>
      <div class="muted">
        LIF has no type registry: a type exists where node/edge properties reference it, so these
        operations sweep the whole document.
      </div>
    `;
  }

  #renderTypeRow(c: VehicleTypeCoverage): TemplateResult {
    const armed = this.typeRemovalArmed === c.vehicleTypeId;
    const complete = c.nodesWithType === c.totalNodes && c.edgesWithType === c.totalEdges;
    const filtered = this.vehicleTypeFilter === c.vehicleTypeId;
    return html`
      <div class="type-row" data-type-row=${c.vehicleTypeId}>
        <input
          data-field="typeId"
          title="Rename this vehicle type across the document"
          .value=${live(c.vehicleTypeId)}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            if (!value || value === c.vehicleTypeId) return;
            if (this.#commit((d) => renameVehicleType(d, c.vehicleTypeId, value))) {
              if (this.vehicleTypeFilter === c.vehicleTypeId) this.vehicleTypeFilter = value;
            } else {
              this.opError = this.#lastCommitError;
            }
          }}
        />
        <span class="muted" data-type-coverage>
          ${c.nodesWithType}/${c.totalNodes} nodes · ${c.edgesWithType}/${c.totalEdges} edges
        </span>
        <button
          class="icon-only"
          data-action="filter-type"
          title=${filtered ? "Clear the map highlight" : "Highlight this type's coverage on the map"}
          aria-pressed=${filtered ? "true" : "false"}
          @click=${() => (this.vehicleTypeFilter = filtered ? "" : c.vehicleTypeId)}
        >
          ${icons.eye()}
        </button>
        ${complete
          ? nothing
          : html`
              <button
                data-action="complete-type"
                title="Add this type to every node and edge that lacks it"
                @click=${() => this.#commit((d) => addVehicleTypeEverywhere(d, c.vehicleTypeId))}
              >
                Complete
              </button>
            `}
        <button
          data-action="remove-type"
          title="Remove this type's properties from every node and edge"
          @click=${() => {
            if (!armed) {
              this.typeRemovalArmed = c.vehicleTypeId;
              return;
            }
            this.typeRemovalArmed = null;
            if (this.#commit((d) => removeVehicleType(d, c.vehicleTypeId))) {
              if (this.vehicleTypeFilter === c.vehicleTypeId) this.vehicleTypeFilter = "";
            }
          }}
        >
          ${armed ? "Confirm removal" : "Remove"}
        </button>
      </div>
    `;
  }

  #addNewTypeEverywhere = (): void => {
    const input = this.renderRoot.querySelector<HTMLInputElement>('input[data-field="newTypeId"]');
    const typeId = input?.value.trim();
    if (!typeId) return;
    if (this.#vehicleTypes.includes(typeId)) {
      this.opError = `vehicle type "${typeId}" already exists`;
      return;
    }
    if (this.#commit((d) => addVehicleTypeEverywhere(d, typeId)) && input) {
      input.value = "";
    }
  };

  #renderNodeFields(node: LifNode): TemplateResult {
    return html`
      <div class="field">
        <label>ID</label>
        <input
          data-field="nodeId"
          .value=${live(node.nodeId)}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            if (value && value !== node.nodeId) {
              if (this.#commit((d) => renameNode(d, node.nodeId, value))) {
                this.selection = { kind: "node", id: value };
              } else {
                this.opError = this.#lastCommitError;
              }
            }
          }}
        />
      </div>
      <div class="field">
        <label>Name</label>
        <input
          data-field="nodeName"
          .value=${node.nodeName ?? ""}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            this.#commit((d) => updateNode(d, node.nodeId, value ? { nodeName: value } : { nodeName: undefined }));
          }}
        />
      </div>
      <div class="field">
        <label>x (m)</label>
        <input
          data-field="x"
          type="number"
          step="0.05"
          .value=${String(node.nodePosition.x)}
          @change=${(e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) this.#commit((d) => moveNode(d, node.nodeId, v, node.nodePosition.y));
          }}
        />
      </div>
      <div class="field">
        <label>y (m)</label>
        <input
          data-field="y"
          type="number"
          step="0.05"
          .value=${String(node.nodePosition.y)}
          @change=${(e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) this.#commit((d) => moveNode(d, node.nodeId, node.nodePosition.x, v));
          }}
        />
      </div>
      ${this.#renderNodeVehicleSections(node)}
    `;
  }

  /* --------------------- vehicle sections --------------------- */

  get #profileTypeId(): string {
    return this.#defaultVehicleType();
  }

  /** The factsheet palette/limits describe one physical vehicle — only its type. */
  #isProfileType(typeId: string): boolean {
    return this.vehicleProfile?.vehicleTypeId === typeId;
  }

  /** Types on other elements that this element doesn't carry yet. */
  #renderAddTypeToElement(
    presentIds: string[],
    add: (typeId: string) => void,
  ): TemplateResult | typeof nothing {
    const present = new Set(presentIds);
    const addable = this.#vehicleTypes.filter((t) => !present.has(t) && t !== this.#profileTypeId);
    if (addable.length === 0) return nothing;
    return html`
      <select
        data-action="add-type-to-element"
        @change=${(e: Event) => {
          const select = e.target as HTMLSelectElement;
          const chosen = select.value;
          select.value = "";
          if (chosen) add(chosen);
        }}
      >
        <option value="" selected>+ Add vehicle type…</option>
        ${addable.map((t) => html`<option value=${t}>${t}</option>`)}
      </select>
    `;
  }

  #patchNodeVehicleProps(
    nodeId: string,
    mutate: (props: VehicleTypeNodeProperty[]) => void,
  ): boolean {
    const found = findNode(this.#doc, nodeId);
    if (!found) return false;
    const props = structuredClone(found.node.vehicleTypeNodeProperties);
    mutate(props);
    return this.#commit((d) => updateNode(d, nodeId, { vehicleTypeNodeProperties: props }));
  }

  #patchEdgeVehicleProps(
    edgeId: string,
    mutate: (props: VehicleTypeEdgeProperty[]) => void,
  ): boolean {
    const found = findEdge(this.#doc, edgeId);
    if (!found) return false;
    const props = structuredClone(found.edge.vehicleTypeEdgeProperties);
    mutate(props);
    return this.#commit((d) => updateEdge(d, edgeId, { vehicleTypeEdgeProperties: props }));
  }

  /**
   * All vehicle sections of a node: the primary type (profile lens)
   * expanded, every other type present on the node as a collapsible section
   * (full forms — the raw-JSON hatch is no longer required for them),
   * plus an add-type control fed by the derived roster.
   */
  #renderNodeVehicleSections(node: LifNode): TemplateResult {
    const primary = this.#profileTypeId;
    const props = node.vehicleTypeNodeProperties;
    const primaryIndex = props.findIndex((p) => p.vehicleTypeId === primary);
    return html`
      <div data-vehicle-section="node">
        <h3>Vehicle · ${primary}</h3>
        ${primaryIndex < 0
          ? html`
              <div class="muted">This node is not enabled for ${primary}.</div>
              <button
                data-action="enable-vehicle"
                @click=${() =>
                  this.#patchNodeVehicleProps(node.nodeId, (p) => p.push({ vehicleTypeId: primary }))}
              >
                Enable for this vehicle
              </button>
            `
          : this.#renderNodeVehicleForm(node, primaryIndex)}
      </div>
      ${props.map((prop, index) =>
        index === primaryIndex
          ? nothing
          : html`
              <details class="vehicle-other" data-vehicle-other=${prop.vehicleTypeId}>
                <summary>Vehicle · ${prop.vehicleTypeId}</summary>
                ${this.#renderNodeVehicleForm(node, index)}
              </details>
            `,
      )}
      ${this.#renderAddTypeToElement(
        props.map((p) => p.vehicleTypeId),
        (typeId) =>
          this.#patchNodeVehicleProps(node.nodeId, (p) => p.push({ vehicleTypeId: typeId })),
      )}
    `;
  }

  #renderNodeVehicleForm(node: LifNode, index: number): TemplateResult {
    const prop = node.vehicleTypeNodeProperties[index]!;
    const typeId = prop.vehicleTypeId;
    const patch = (mutate: (p: VehicleTypeNodeProperty) => void) =>
      this.#patchNodeVehicleProps(node.nodeId, (props) => mutate(props[index]!));
    return html`
      <div class="field">
        <label>θ (rad)</label>
        <input
          data-field="vehicleTheta"
          type="number"
          step="0.01"
          .value=${prop.theta !== undefined ? String(prop.theta) : ""}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value.trim();
            const v = raw === "" ? undefined : Number(raw);
            if (v === undefined || Number.isFinite(v)) {
              patch((p) => {
                if (v === undefined) delete p.theta;
                else p.theta = v;
              });
            }
          }}
        />
      </div>
      ${this.#renderActionsEditor(
        prop.actions,
        "NODE",
        (mutate) =>
          this.#patchNodeVehicleProps(node.nodeId, (props) => {
            const p = props[index]!;
            const actions = p.actions ?? [];
            mutate(actions);
            if (actions.length === 0) delete p.actions;
            else p.actions = actions;
          }),
        this.#isProfileType(typeId) ? this.#paletteFor("NODE") : [],
      )}
      <button
        data-action="remove-vehicle"
        @click=${() => this.#patchNodeVehicleProps(node.nodeId, (props) => props.splice(index, 1))}
      >
        Remove vehicle from this node
      </button>
    `;
  }

  #limitWarning(
    key: "maxSpeed" | "maxRotationSpeed" | "minHeight" | "maxHeight",
    value: number | undefined,
    typeId: string,
  ): TemplateResult | typeof nothing {
    if (!this.#isProfileType(typeId)) return nothing; // limits describe the profile's vehicle
    const limit = this.vehicleProfile?.limits?.[key];
    if (limit === undefined || value === undefined) return nothing;
    // minHeight is a lower capability bound; the rest are upper bounds.
    const exceeded = key === "minHeight" ? value < limit : value > limit;
    if (!exceeded) return nothing;
    return html`<div class="warn" data-limit-warning=${key}>
      ${key} ${key === "minHeight" ? "below" : "exceeds"} the vehicle limit (${limit})
    </div>`;
  }

  #renderEdgeVehicleSections(edge: LifEdge): TemplateResult {
    const primary = this.#profileTypeId;
    const props = edge.vehicleTypeEdgeProperties;
    const primaryIndex = props.findIndex((p) => p.vehicleTypeId === primary);
    return html`
      <div data-vehicle-section="edge">
        <h3>Vehicle · ${primary}</h3>
        ${primaryIndex < 0
          ? html`
              <div class="muted">This edge is not enabled for ${primary}.</div>
              <button
                data-action="enable-vehicle"
                @click=${() =>
                  this.#patchEdgeVehicleProps(edge.edgeId, (p) =>
                    p.push({
                      vehicleTypeId: primary,
                      rotationAllowed: false,
                      ...this.#profileEdgeDefaults(),
                    }),
                  )}
              >
                Enable for this vehicle
              </button>
            `
          : this.#renderEdgeVehicleForm(edge, primaryIndex)}
      </div>
      ${props.map((prop, index) =>
        index === primaryIndex
          ? nothing
          : html`
              <details class="vehicle-other" data-vehicle-other=${prop.vehicleTypeId}>
                <summary>Vehicle · ${prop.vehicleTypeId}</summary>
                ${this.#renderEdgeVehicleForm(edge, index)}
              </details>
            `,
      )}
      ${this.#renderAddTypeToElement(
        props.map((p) => p.vehicleTypeId),
        (typeId) =>
          this.#patchEdgeVehicleProps(edge.edgeId, (p) =>
            p.push({ vehicleTypeId: typeId, rotationAllowed: false }),
          ),
      )}
    `;
  }

  #renderEdgeVehicleForm(edge: LifEdge, index: number): TemplateResult {
    const prop = edge.vehicleTypeEdgeProperties[index]!;
    const typeId = prop.vehicleTypeId;
    const patch = (mutate: (p: VehicleTypeEdgeProperty) => void) =>
      this.#patchEdgeVehicleProps(edge.edgeId, (props) => mutate(props[index]!));

    const numberField = (
      label: string,
      key: "vehicleOrientation" | "maxSpeed" | "maxRotationSpeed" | "minHeight" | "maxHeight",
      step: string,
    ) => html`
      <div class="field">
        <label>${label}</label>
        <input
          data-field=${key}
          type="number"
          step=${step}
          .value=${prop[key] !== undefined ? String(prop[key]) : ""}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value.trim();
            const v = raw === "" ? undefined : Number(raw);
            if (v === undefined || Number.isFinite(v)) {
              patch((p) => {
                if (v === undefined) delete p[key];
                else p[key] = v;
              });
            }
          }}
        />
      </div>
      ${key === "vehicleOrientation" ? nothing : this.#limitWarning(key, prop[key], typeId)}
    `;

    const enumField = <K extends "orientationType" | "rotationAtStartNodeAllowed" | "rotationAtEndNodeAllowed" | "reentryAllowed">(
      label: string,
      key: K,
      options: string[],
      defaultLabel: string,
    ) => html`
      <div class="field">
        <label>${label}</label>
        <select
          data-field=${key}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLSelectElement).value;
            patch((p) => {
              if (raw === "") delete p[key];
              else if (key === "reentryAllowed") p.reentryAllowed = raw === "true";
              else (p as unknown as Record<string, unknown>)[key] = raw;
            });
          }}
        >
          <option value="" ?selected=${prop[key] === undefined}>${defaultLabel}</option>
          ${options.map(
            (o) => html`<option value=${o} ?selected=${String(prop[key]) === o}>${o}</option>`,
          )}
        </select>
      </div>
    `;

    return html`
      <div class="field">
        <label>Rotation</label>
        <label style="justify-self:start">
          <input
            type="checkbox"
            data-field="rotationAllowed"
            .checked=${prop.rotationAllowed}
            @change=${(e: Event) =>
              patch((p) => (p.rotationAllowed = (e.target as HTMLInputElement).checked))}
          />
          allowed on edge
        </label>
      </div>
      ${enumField("Orientation", "orientationType", ["GLOBAL", "TANGENTIAL"], "(default TANGENTIAL)")}
      ${numberField("Vehicle θ (rad)", "vehicleOrientation", "0.01")}
      ${enumField("Rot @ start", "rotationAtStartNodeAllowed", ["NONE", "CCW", "CW", "BOTH"], "(default BOTH)")}
      ${enumField("Rot @ end", "rotationAtEndNodeAllowed", ["NONE", "CCW", "CW", "BOTH"], "(default BOTH)")}
      ${numberField("Max speed (m/s)", "maxSpeed", "0.1")}
      ${numberField("Max rot. (rad/s)", "maxRotationSpeed", "0.1")}
      ${numberField("Min height (m)", "minHeight", "0.05")}
      ${numberField("Max height (m)", "maxHeight", "0.05")}
      ${enumField("Re-entry", "reentryAllowed", ["true", "false"], "(default true)")}
      ${this.#renderActionsEditor(
        prop.actions,
        "EDGE",
        (mutate) =>
          this.#patchEdgeVehicleProps(edge.edgeId, (props) => {
            const p = props[index]!;
            const actions = p.actions ?? [];
            mutate(actions);
            if (actions.length === 0) delete p.actions;
            else p.actions = actions;
          }),
        this.#isProfileType(typeId) ? this.#paletteFor("EDGE") : [],
      )}
      <button
        data-action="remove-vehicle"
        @click=${() => this.#patchEdgeVehicleProps(edge.edgeId, (props) => props.splice(index, 1))}
      >
        Remove vehicle from this edge
      </button>
    `;
  }

  #renderEdgeFields(edge: LifEdge): TemplateResult {
    const nodes = this.#doc.layouts.flatMap((l) => l.nodes.map((n) => n.nodeId));
    return html`
      <div class="field">
        <label>ID</label>
        <input
          data-field="edgeId"
          .value=${live(edge.edgeId)}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            if (value && value !== edge.edgeId) {
              if (this.#commit((d) => renameEdge(d, edge.edgeId, value))) {
                this.selection = { kind: "edge", id: value };
              } else {
                this.opError = this.#lastCommitError;
              }
            }
          }}
        />
      </div>
      <div class="field">
        <label>Name</label>
        <input
          data-field="edgeName"
          .value=${edge.edgeName ?? ""}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            this.#commit((d) => updateEdge(d, edge.edgeId, value ? { edgeName: value } : { edgeName: undefined }));
          }}
        />
      </div>
      <div class="field">
        <label>Start</label>
        <select
          data-field="startNodeId"
          @change=${(e: Event) =>
            this.#commit((d) => updateEdge(d, edge.edgeId, { startNodeId: (e.target as HTMLSelectElement).value }))}
        >
          ${nodes.map((id) => html`<option value=${id} ?selected=${id === edge.startNodeId}>${id}</option>`)}
        </select>
      </div>
      <div class="field">
        <label>End</label>
        <select
          data-field="endNodeId"
          @change=${(e: Event) =>
            this.#commit((d) => updateEdge(d, edge.edgeId, { endNodeId: (e.target as HTMLSelectElement).value }))}
        >
          ${nodes.map((id) => html`<option value=${id} ?selected=${id === edge.endNodeId}>${id}</option>`)}
        </select>
      </div>
      ${this.#renderEdgeVehicleSections(edge)}
    `;
  }

  /* ----------------------- actions editor (A2) ----------------------- */

  #paletteFor(scope: "NODE" | "EDGE"): SupportedAction[] {
    return (this.vehicleProfile?.supportedActions ?? []).filter(
      (a) => !a.scopes || a.scopes.includes(scope),
    );
  }

  #renderActionsEditor(
    actions: LifAction[] | undefined,
    scope: "NODE" | "EDGE",
    apply: (mutate: (actions: LifAction[]) => void) => void,
    palette: SupportedAction[],
  ): TemplateResult {
    const list = actions ?? [];
    return html`
      <h4 class="actions-head">Actions</h4>
      ${list.length === 0 ? html`<div class="muted">No actions defined here.</div>` : nothing}
      ${list.map((action, ai) => this.#renderActionRow(action, ai, palette, apply))}
      ${palette.length > 0
        ? html`
            <select
              data-action="add-action"
              @change=${(e: Event) => {
                const select = e.target as HTMLSelectElement;
                const chosen = palette.find((p) => p.actionType === select.value);
                select.value = "";
                if (!chosen) return;
                apply((a) =>
                  a.push({
                    actionType: chosen.actionType,
                    ...(chosen.description !== undefined ? { actionDescription: chosen.description } : {}),
                    ...(chosen.defaultRequirementType !== undefined
                      ? { requirementType: chosen.defaultRequirementType }
                      : {}),
                    blockingType: chosen.defaultBlockingType ?? "NONE",
                  }),
                );
              }}
            >
              <option value="" selected>+ Add action…</option>
              ${palette.map(
                (p) => html`<option value=${p.actionType} title=${p.description ?? ""}>${p.actionType}</option>`,
              )}
            </select>
          `
        : html`
            <button
              data-action="add-action"
              @click=${() => apply((a) => a.push({ actionType: "action", blockingType: "NONE" }))}
            >
              ＋ Add action
            </button>
          `}
    `;
  }

  #renderActionRow(
    action: LifAction,
    ai: number,
    palette: SupportedAction[],
    apply: (mutate: (actions: LifAction[]) => void) => void,
  ): TemplateResult {
    const patch = (mutate: (a: LifAction) => void) => apply((list) => mutate(list[ai]!));
    const typeOptions = [...new Set([...palette.map((p) => p.actionType), action.actionType])];
    return html`
      <div class="action-row" data-action-row=${ai}>
        <div class="action-row-head">
          ${palette.length > 0
            ? html`
                <select
                  data-afield="actionType"
                  @change=${(e: Event) =>
                    patch((a) => (a.actionType = (e.target as HTMLSelectElement).value))}
                >
                  ${typeOptions.map(
                    (t) => html`<option value=${t} ?selected=${t === action.actionType}>${t}</option>`,
                  )}
                </select>
              `
            : html`
                <input
                  data-afield="actionType"
                  .value=${action.actionType}
                  @change=${(e: Event) =>
                    patch((a) => (a.actionType = (e.target as HTMLInputElement).value.trim()))}
                />
              `}
          <button
            class="icon"
            data-action="remove-action"
            title="Remove action"
            @click=${() => apply((list) => list.splice(ai, 1))}
          >
            ✕
          </button>
        </div>
        <div class="action-grid">
          <select
            data-afield="requirementType"
            title="requirementType"
            @change=${(e: Event) => {
              const raw = (e.target as HTMLSelectElement).value;
              patch((a) => {
                if (raw === "") delete a.requirementType;
                else a.requirementType = raw as RequirementType;
              });
            }}
          >
            <option value="" ?selected=${action.requirementType === undefined}>(requirement?)</option>
            ${(["REQUIRED", "CONDITIONAL", "OPTIONAL"] as const).map(
              (r) => html`<option value=${r} ?selected=${action.requirementType === r}>${r}</option>`,
            )}
          </select>
          <select
            data-afield="blockingType"
            title="blockingType"
            @change=${(e: Event) =>
              patch((a) => (a.blockingType = (e.target as HTMLSelectElement).value as BlockingType))}
          >
            ${(["NONE", "SOFT", "HARD"] as const).map(
              (b) => html`<option value=${b} ?selected=${action.blockingType === b}>${b}</option>`,
            )}
          </select>
        </div>
        <input
          data-afield="actionDescription"
          placeholder="description"
          .value=${action.actionDescription ?? ""}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            patch((a) => {
              if (v) a.actionDescription = v;
              else delete a.actionDescription;
            });
          }}
        />
        ${(action.actionParameters ?? []).map(
          (param, pi) => html`
            <div class="param-row" data-param-row=${pi}>
              <input
                data-pfield="key"
                placeholder="key"
                .value=${param.key}
                @change=${(e: Event) =>
                  patch((a) => (a.actionParameters![pi]!.key = (e.target as HTMLInputElement).value.trim()))}
              />
              <input
                data-pfield="value"
                placeholder="value"
                .value=${param.value}
                @change=${(e: Event) =>
                  patch((a) => (a.actionParameters![pi]!.value = (e.target as HTMLInputElement).value))}
              />
              <button
                class="icon"
                data-action="remove-param"
                title="Remove parameter"
                @click=${() =>
                  patch((a) => {
                    a.actionParameters!.splice(pi, 1);
                    if (a.actionParameters!.length === 0) delete a.actionParameters;
                  })}
              >
                ✕
              </button>
            </div>
          `,
        )}
        <button
          data-action="add-param"
          @click=${() =>
            patch((a) => {
              a.actionParameters ??= [];
              a.actionParameters.push({ key: `key${a.actionParameters.length + 1}`, value: "" });
            })}
        >
          + Parameter
        </button>
      </div>
    `;
  }

  #renderStationFields(station: Station): TemplateResult {
    return html`
      <div class="field">
        <label>ID</label>
        <input
          data-field="stationId"
          .value=${live(station.stationId)}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            if (value && value !== station.stationId) {
              if (this.#commit((d) => renameStation(d, station.stationId, value))) {
                this.selection = { kind: "station", id: value };
              } else {
                this.opError = this.#lastCommitError;
              }
            }
          }}
        />
      </div>
      <div class="field">
        <label>Name</label>
        <input
          data-field="stationName"
          .value=${station.stationName ?? ""}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            this.#commit((d) =>
              updateStation(d, station.stationId, value ? { stationName: value } : { stationName: undefined }),
            );
          }}
        />
      </div>
      <div class="field">
        <label>Height (m)</label>
        <input
          data-field="stationHeight"
          type="number"
          step="0.05"
          min="0"
          .value=${station.stationHeight !== undefined ? String(station.stationHeight) : ""}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            const v = raw === "" ? undefined : Number(raw);
            if (v === undefined || Number.isFinite(v)) {
              this.#commit((d) => updateStation(d, station.stationId, { stationHeight: v }));
            }
          }}
        />
      </div>
      <div class="field">
        <label>Nodes</label>
        <input
          data-field="interactionNodeIds"
          .value=${station.interactionNodeIds.join(", ")}
          @change=${(e: Event) => {
            const ids = (e.target as HTMLInputElement).value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            this.#commit((d) => updateStation(d, station.stationId, { interactionNodeIds: ids }));
          }}
        />
      </div>
      ${this.#renderStationPositionFields(station)}
    `;
  }

  /** stationPosition is optional (visualization only); blank X and Y unsets it. */
  #renderStationPositionFields(station: Station): TemplateResult {
    const pos = station.stationPosition;
    const apply = (x: string, y: string, theta: string) => {
      if (x.trim() === "" && y.trim() === "") {
        this.#commit((d) => updateStation(d, station.stationId, { stationPosition: undefined }));
        return;
      }
      const nx = Number(x || "0");
      const ny = Number(y || "0");
      const nt = theta.trim() === "" ? undefined : Number(theta);
      if (!Number.isFinite(nx) || !Number.isFinite(ny) || (nt !== undefined && !Number.isFinite(nt))) return;
      this.#commit((d) =>
        updateStation(d, station.stationId, {
          stationPosition: { x: nx, y: ny, ...(nt !== undefined ? { theta: nt } : {}) },
        }),
      );
    };
    const current = () => {
      const root = this.renderRoot;
      const get = (name: string) =>
        (root.querySelector(`input[data-field="${name}"]`) as HTMLInputElement | null)?.value ?? "";
      return { x: get("stationX"), y: get("stationY"), theta: get("stationTheta") };
    };
    const onChange = () => {
      const v = current();
      apply(v.x, v.y, v.theta);
    };
    return html`
      <div class="field">
        <label>Pos X (m)</label>
        <input data-field="stationX" type="number" step="0.05" .value=${pos ? String(pos.x) : ""} @change=${onChange} />
      </div>
      <div class="field">
        <label>Pos Y (m)</label>
        <input data-field="stationY" type="number" step="0.05" .value=${pos ? String(pos.y) : ""} @change=${onChange} />
      </div>
      <div class="field">
        <label>θ (rad)</label>
        <input
          data-field="stationTheta"
          type="number"
          step="0.01"
          .value=${pos?.theta !== undefined ? String(pos.theta) : ""}
          @change=${onChange}
        />
      </div>
      ${pos
        ? html`
            <button
              data-action="clear-station-position"
              @click=${() =>
                this.#commit((d) => updateStation(d, station.stationId, { stationPosition: undefined }))}
            >
              Unset position (derive from nodes)
            </button>
          `
        : nothing}
      <div class="muted">Marker position (visualization only).</div>
    `;
  }

  #renderJsonEditor(element: LifNode | LifEdge | Station): TemplateResult {
    const current = this.jsonDraft ?? JSON.stringify(element, null, 2);
    return html`
      <h3>Raw JSON</h3>
      <textarea
        class="json"
        data-field="json"
        .value=${current}
        @input=${(e: Event) => (this.jsonDraft = (e.target as HTMLTextAreaElement).value)}
        spellcheck="false"
      ></textarea>
      ${this.jsonError ? html`<div class="error" data-json-error>${this.jsonError}</div>` : nothing}
      <button data-action="apply-json" ?disabled=${this.jsonDraft === null} @click=${this.#applyJson}>
        Apply JSON
      </button>
    `;
  }

  /* ------------------------------ layout dialog ------------------------------ */

  #openLayoutDialog(mode: "create" | "edit"): void {
    if (mode === "edit") {
      const layout = findLayout(this.#doc, this.#currentLayoutId);
      if (!layout) return;
      const bg = this.backgrounds[layout.layoutId];
      this.layoutDialog = {
        mode,
        originalId: layout.layoutId,
        layoutId: layout.layoutId,
        layoutName: layout.layoutName ?? "",
        layoutVersion: layout.layoutVersion ?? "1",
        layoutLevelId: layout.layoutLevelId ?? "",
        layoutDescription: layout.layoutDescription ?? "",
        bgHref: bg?.href ?? "",
        bgX: bg ? String(bg.x) : "0",
        bgY: bg ? String(bg.y) : "0",
        bgWidth: bg ? String(bg.width) : "",
        bgHeight: bg ? String(bg.height) : "",
        bgOpacity: bg?.opacity !== undefined ? String(bg.opacity) : "0.7",
        confirmDelete: false,
        error: null,
      };
    } else {
      this.layoutDialog = {
        mode,
        layoutId: this.#freshId("layout-", (id) => !!findLayout(this.#doc, id)),
        layoutName: "",
        layoutVersion: "1",
        layoutLevelId: "",
        layoutDescription: "",
        bgHref: "",
        bgX: "0",
        bgY: "0",
        bgWidth: "",
        bgHeight: "",
        bgOpacity: "0.7",
        confirmDelete: false,
        error: null,
      };
    }
  }

  #patchLayoutDialog(patch: Partial<LayoutDialogState>): void {
    if (this.layoutDialog) this.layoutDialog = { ...this.layoutDialog, ...patch, error: null };
  }

  #renderLayoutDialog(d: LayoutDialogState): TemplateResult {
    const field = (label: string, key: keyof LayoutDialogState, type = "text") => html`
      <div class="field">
        <label>${label}</label>
        <input
          data-dialog-field=${key}
          type=${type}
          step="any"
          .value=${String(d[key] ?? "")}
          @input=${(e: Event) => this.#patchLayoutDialog({ [key]: (e.target as HTMLInputElement).value })}
        />
      </div>
    `;
    return html`
      <div class="dialog-backdrop" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.layoutDialog = null;
      }}>
        <div class="dialog" data-panel="layout-dialog">
          <h2>${d.mode === "create" ? "Create layout" : `Edit layout "${d.originalId}"`}</h2>
          ${field("ID", "layoutId")}
          ${field("Name", "layoutName")}
          ${field("Version", "layoutVersion")}
          ${field("Level ID", "layoutLevelId")}
          ${field("Description", "layoutDescription")}

          <h4>Background map (runtime only, not exported)</h4>
          <div class="field">
            <label>Image</label>
            <input type="file" accept="image/*" data-dialog-field="bgFile" @change=${this.#onBackgroundFile} />
          </div>
          ${d.bgHref
            ? html`
                ${field("X (m)", "bgX", "number")}
                ${field("Y (m)", "bgY", "number")}
                ${field("Width (m)", "bgWidth", "number")}
                ${field("Height (m)", "bgHeight", "number")}
                ${field("Opacity", "bgOpacity", "number")}
                <div class="muted">X/Y = lower-left corner (ROS map origin convention).</div>
                <button data-action="clear-background" @click=${() => this.#patchLayoutDialog({ bgHref: "" })}>
                  Remove background
                </button>
              `
            : html`<div class="muted">No background image set.</div>`}

          ${d.error ? html`<div class="error" data-dialog-error>${d.error}</div>` : nothing}
          <div class="buttons">
            ${d.mode === "edit"
              ? html`
                  <button
                    class="danger"
                    data-action="delete-layout"
                    ?data-confirm=${d.confirmDelete}
                    @click=${this.#deleteLayoutFromDialog}
                  >
                    ${d.confirmDelete ? "Really delete layout?" : "Delete layout"}
                  </button>
                `
              : nothing}
            <span style="flex:1"></span>
            <button data-action="cancel-layout" @click=${() => (this.layoutDialog = null)}>Cancel</button>
            <button data-action="save-layout" @click=${this.#saveLayoutDialog}>Save</button>
          </div>
        </div>
      </div>
    `;
  }

  #onBackgroundFile = async (ev: Event): Promise<void> => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file || !this.layoutDialog) return;
    const href = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    // Default calibration: keep the image's pixel aspect at 20 px/m.
    const img = new Image();
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = href;
    });
    const patch: Partial<LayoutDialogState> = { bgHref: href };
    if (!this.layoutDialog.bgWidth && img.naturalWidth > 0) {
      patch.bgWidth = String(img.naturalWidth / 20);
      patch.bgHeight = String(img.naturalHeight / 20);
    }
    this.#patchLayoutDialog(patch);
  };

  #saveLayoutDialog = (): void => {
    const d = this.layoutDialog;
    if (!d) return;
    const layoutId = d.layoutId.trim();
    if (!layoutId) {
      this.layoutDialog = { ...d, error: "Layout ID must not be empty" };
      return;
    }
    const meta = {
      layoutName: d.layoutName.trim() || undefined,
      layoutVersion: d.layoutVersion.trim() || "1",
      layoutLevelId: d.layoutLevelId.trim() || undefined,
      layoutDescription: d.layoutDescription.trim() || undefined,
    };
    const ok = this.#commit((doc) => {
      if (d.mode === "create") {
        return addLayout(doc, {
          layoutId,
          layoutVersion: meta.layoutVersion,
          ...(meta.layoutName !== undefined ? { layoutName: meta.layoutName } : {}),
          ...(meta.layoutLevelId !== undefined ? { layoutLevelId: meta.layoutLevelId } : {}),
          ...(meta.layoutDescription !== undefined ? { layoutDescription: meta.layoutDescription } : {}),
          nodes: [],
          edges: [],
          stations: [],
        });
      }
      let next = doc;
      if (layoutId !== d.originalId) next = renameLayout(next, d.originalId!, layoutId);
      return updateLayout(next, layoutId, meta);
    });
    if (!ok) {
      this.layoutDialog = { ...d, error: this.#lastCommitError };
      return;
    }

    // Apply the runtime background (keyed by the possibly renamed layoutId).
    const backgrounds = { ...this.backgrounds };
    if (d.originalId && d.originalId !== layoutId) delete backgrounds[d.originalId];
    if (d.bgHref) {
      backgrounds[layoutId] = {
        href: d.bgHref,
        x: Number(d.bgX) || 0,
        y: Number(d.bgY) || 0,
        width: Math.max(Number(d.bgWidth) || 1, 0.01),
        height: Math.max(Number(d.bgHeight) || 1, 0.01),
        opacity: Math.min(Math.max(Number(d.bgOpacity) || 0.7, 0.05), 1),
      };
    } else {
      delete backgrounds[layoutId];
    }
    this.backgrounds = backgrounds;
    this.#layoutId = layoutId;
    this.layoutDialog = null;
  };

  #deleteLayoutFromDialog = (): void => {
    const d = this.layoutDialog;
    if (!d || d.mode !== "edit" || !d.originalId) return;
    if (!d.confirmDelete) {
      this.layoutDialog = { ...d, confirmDelete: true };
      return;
    }
    if (this.#commit((doc) => removeLayout(doc, d.originalId!))) {
      const backgrounds = { ...this.backgrounds };
      delete backgrounds[d.originalId];
      this.backgrounds = backgrounds;
      this.#layoutId = null;
      this.layoutDialog = null;
    }
  };

  /* ------------------------------ grid dialog ------------------------------ */

  #openGridDialog = (): void => {
    this.gridDialog = {
      xCount: "3",
      yCount: "3",
      spacing: "2",
      startX: "0",
      startY: "0",
      idPrefix: "g",
      connect: "DOUBLE",
      error: null,
    };
  };

  #renderGridDialog(d: GridDialogState): TemplateResult {
    const field = (label: string, key: keyof GridDialogState, type = "number") => html`
      <div class="field">
        <label>${label}</label>
        <input
          data-grid-field=${key}
          type=${type}
          step="any"
          .value=${String(d[key] ?? "")}
          @input=${(e: Event) =>
            (this.gridDialog = { ...d, [key]: (e.target as HTMLInputElement).value, error: null })}
        />
      </div>
    `;
    return html`
      <div class="dialog-backdrop" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.gridDialog = null;
      }}>
        <div class="dialog" data-panel="grid-dialog">
          <h2>Generate node grid</h2>
          ${field("Columns", "xCount")}
          ${field("Rows", "yCount")}
          ${field("Spacing (m)", "spacing")}
          ${field("Start X (m)", "startX")}
          ${field("Start Y (m)", "startY")}
          ${field("ID prefix", "idPrefix", "text")}
          <div class="field">
            <label>Connect</label>
            <select
              data-grid-field="connect"
              @change=${(e: Event) =>
                (this.gridDialog = { ...d, connect: (e.target as HTMLSelectElement).value as GridDialogState["connect"], error: null })}
            >
              ${(["NONE", "SINGLE", "DOUBLE"] as const).map(
                (c) => html`<option value=${c} ?selected=${d.connect === c}>${c === "NONE" ? "No edges" : c === "SINGLE" ? "One direction" : "Both directions"}</option>`,
              )}
            </select>
          </div>
          ${d.error ? html`<div class="error" data-dialog-error>${d.error}</div>` : nothing}
          <div class="buttons">
            <button data-action="cancel-grid" @click=${() => (this.gridDialog = null)}>Cancel</button>
            <button data-action="generate-grid" @click=${this.#generateGrid}>Generate</button>
          </div>
        </div>
      </div>
    `;
  }

  #generateGrid = (): void => {
    const d = this.gridDialog;
    if (!d) return;
    const layoutId = this.#currentLayoutId;
    const opts: GridGeneratorOptions = {
      xCount: Number(d.xCount),
      yCount: Number(d.yCount),
      spacing: Number(d.spacing),
      startX: Number(d.startX) || 0,
      startY: Number(d.startY) || 0,
      idPrefix: d.idPrefix.trim() || "g",
      vehicleTypeId: this.#defaultVehicleType(),
      connect: d.connect,
      edgeDefaults: this.#profileEdgeDefaults(),
    };
    if (this.#commit((doc) => generateNodeGrid(doc, layoutId, opts))) {
      this.gridDialog = null;
      this.updateComplete.then(() => this.#viewer?.fitView());
    } else {
      this.gridDialog = { ...d, error: this.#lastCommitError };
    }
  };

  /* ------------------------------ behavior ------------------------------ */

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    this.addEventListener("keydown", this.#onKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.#onKeyDown);
  }

  #onKeyDown = (ev: KeyboardEvent): void => {
    const target = ev.composedPath()[0] as HTMLElement | undefined;
    const inField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    const mod = ev.ctrlKey || ev.metaKey;

    if (mod && ev.key.toLowerCase() === "z" && !inField) {
      ev.preventDefault();
      if (ev.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === "y" && !inField) {
      ev.preventDefault();
      this.redo();
      return;
    }
    if (mod && ev.key.toLowerCase() === "s" && !inField) {
      ev.preventDefault();
      this.#download();
      return;
    }
    if (mod && ev.key.toLowerCase() === "o" && !inField) {
      ev.preventDefault();
      this.#fileInput?.click();
      return;
    }
    if (ev.key === "Escape") {
      if (this.shortcutsOpen) {
        this.shortcutsOpen = false;
      } else if (this.layoutDialog) {
        this.layoutDialog = null;
      } else if (this.gridDialog) {
        this.gridDialog = null;
      } else if (this.#viewer?.displayMenuOpen) {
        this.#viewer.displayMenuOpen = false;
      } else if (this.measureMode && this.#viewer?.hasPendingMeasurement) {
        // First Esc cancels the in-progress measurement, staying in the tool.
        this.#viewer.cancelPendingMeasurement();
      } else if (this.measureMode) {
        this.measureMode = false;
      } else if (this.bulkSelection) {
        this.#clearBulkSelection();
      } else {
        this.pendingEdgeStart = null;
        this.selection = null;
      }
      return;
    }
    if ((ev.key === "Delete" || ev.key === "Backspace") && !inField) {
      ev.preventDefault();
      if (this.bulkSelection) this.#bulkDelete();
      else this.#deleteSelection();
      return;
    }

    // Bare-key bindings: never while typing, holding a modifier, or in a dialog.
    if (inField || mod || ev.altKey) return;
    if (this.layoutDialog || this.gridDialog || this.shortcutsOpen) {
      if (ev.key === "?") this.shortcutsOpen = !this.shortcutsOpen;
      return;
    }

    if (ev.key.startsWith("Arrow") && this.selection?.kind === "node") {
      ev.preventDefault();
      this.#nudgeSelectedNode(ev.key, ev.shiftKey ? 1 : 0.1);
      return;
    }

    switch (ev.key.toLowerCase()) {
      case "v":
        this.#setTool("select");
        return;
      case "n":
        this.#setTool("add-node");
        return;
      case "e":
        this.#setTool("add-edge");
        return;
      case "s":
        this.#setTool("add-station");
        return;
      case "m":
        this.measureMode = !this.measureMode;
        return;
      case "d":
        this.doubleWay = !this.doubleWay;
        return;
      case "c":
        this.chainNodes = !this.chainNodes;
        return;
      case "g": {
        const viewer = this.#viewer;
        if (viewer) viewer.showGrid = !viewer.showGrid;
        return;
      }
      case "f":
        void this.#viewer?.toggleFullscreen();
        return;
    }
    switch (ev.key) {
      case "+":
      case "=":
        this.#viewer?.zoomIn();
        return;
      case "-":
        this.#viewer?.zoomOut();
        return;
      case "0":
        this.#viewer?.fitView();
        return;
      case "/":
        ev.preventDefault();
        (this.renderRoot.querySelector('input[data-field="search"]') as HTMLInputElement | null)?.focus();
        return;
      case "?":
        this.shortcutsOpen = true;
        return;
    }
  };

  /** Arrow-key nudge for the selected node; world metres, y-up. */
  #nudgeSelectedNode(key: string, step: number): void {
    const nodeId = this.selection?.kind === "node" ? this.selection.id : null;
    if (!nodeId) return;
    const found = findNode(this.#doc, nodeId);
    if (!found) return;
    const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
    const dy = key === "ArrowDown" ? -step : key === "ArrowUp" ? step : 0;
    const x = Math.round((found.node.nodePosition.x + dx) * 1000) / 1000;
    const y = Math.round((found.node.nodePosition.y + dy) * 1000) / 1000;
    this.#commit((d) => moveNode(d, nodeId, x, y));
  }

  #setTool(tool: Tool): void {
    this.tool = tool;
    this.pendingEdgeStart = null;
  }

  /** Shift+drag marquee: everything inside the world rect, current layout. */
  #onMarquee = (
    ev: CustomEvent<{ minX: number; minY: number; maxX: number; maxY: number }>,
  ): void => {
    const { minX, minY, maxX, maxY } = ev.detail;
    const layout = findLayout(this.#doc, this.#currentLayoutId);
    if (!layout) return;
    const inside = (p: { x: number; y: number }): boolean =>
      p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    const nodes = layout.nodes.filter((n) => inside(n.nodePosition)).map((n) => n.nodeId);
    const nodeSet = new Set(nodes);
    const edges = layout.edges
      .filter((e) => nodeSet.has(e.startNodeId) && nodeSet.has(e.endNodeId))
      .map((e) => e.edgeId);
    const stations = layout.stations
      .filter((s) => s.stationPosition && inside(s.stationPosition))
      .map((s) => s.stationId);
    this.bulkDeleteArmed = false;
    if (nodes.length + edges.length + stations.length === 0) {
      this.bulkSelection = null;
      return;
    }
    this.selection = null;
    this.pendingEdgeStart = null;
    this.bulkSelection = { nodes, edges, stations };
  };

  #clearBulkSelection(): void {
    this.bulkSelection = null;
    this.bulkDeleteArmed = false;
  }

  #onSelect = (ev: CustomEvent<LifSelectDetail>): void => {
    const { kind, id } = ev.detail;
    if (this.bulkSelection) this.#clearBulkSelection();
    if (kind === "vehicle") {
      // Vehicles are a live overlay, not editable document state.
      this.selection = null;
      return;
    }
    if (this.tool === "add-node" && kind === null) {
      // The canvas click that follows will place a node; keep the current
      // selection so chain mode can connect from it.
      return;
    }
    if (this.tool === "add-edge" && kind === "node" && id) {
      if (!this.pendingEdgeStart) {
        this.pendingEdgeStart = id;
      } else if (this.pendingEdgeStart !== id) {
        const start = this.pendingEdgeStart;
        const layoutId = findNode(this.#doc, start)?.layout.layoutId ?? this.#currentLayoutId;
        const edgeId = this.#connectNodes(layoutId, start, id);
        if (edgeId) {
          this.pendingEdgeStart = null;
          this.selection = { kind: "edge", id: edgeId };
        }
      }
      return;
    }
    if (this.tool === "add-station" && kind === "node" && id) {
      const layoutId = findNode(this.#doc, id)?.layout.layoutId ?? this.#currentLayoutId;
      const stationId = this.#freshId("st", (x) => !!findStation(this.#doc, x));
      if (
        this.#commit((d) =>
          addStation(d, layoutId, {
            stationId,
            interactionNodeIds: [id],
            stationName: stationId,
          }),
        )
      ) {
        this.selection = { kind: "station", id: stationId };
        this.tool = "select";
      }
      return;
    }
    this.selection = kind && id ? { kind, id } : null;
  };

  /**
   * Create edge(s) between two nodes as one undoable step; both directions
   * when doubleWay is on. Returns the forward edgeId, or null on failure.
   */
  #connectNodes(layoutId: string, startNodeId: string, endNodeId: string): string | null {
    const forwardId = this.#freshId("e", (x) => !!findEdge(this.#doc, x));
    const reverseId = this.doubleWay
      ? this.#freshId("e", (x) => x === forwardId || !!findEdge(this.#doc, x))
      : null;
    const ok = this.#commit((d) => {
      let next = addEdge(d, layoutId, {
        edgeId: forwardId,
        startNodeId,
        endNodeId,
        vehicleTypeEdgeProperties: this.#newEdgeProps(),
      });
      if (reverseId) {
        next = addEdge(next, layoutId, {
          edgeId: reverseId,
          startNodeId: endNodeId,
          endNodeId: startNodeId,
          vehicleTypeEdgeProperties: this.#newEdgeProps(),
        });
      }
      return next;
    });
    return ok ? forwardId : null;
  }

  #onCanvasClick = (ev: CustomEvent<{ x: number; y: number }>): void => {
    if (this.tool !== "add-node" || this.measureMode) return;
    const layoutId = this.#currentLayoutId;
    if (!layoutId) return;
    // Chain mode: connect from the currently selected node in the same layout.
    const anchor =
      this.chainNodes && this.selection?.kind === "node"
        ? findNode(this.#doc, this.selection.id)
        : undefined;
    const chainFrom = anchor && anchor.layout.layoutId === layoutId ? anchor.node.nodeId : null;

    const nodeId = this.#freshId("n", (x) => !!findNode(this.#doc, x));
    const created: LifNode = {
      nodeId,
      nodePosition: { x: roundMm(ev.detail.x), y: roundMm(ev.detail.y) },
      vehicleTypeNodeProperties: [{ vehicleTypeId: this.#defaultVehicleType() }],
    };
    const forwardId = chainFrom ? this.#freshId("e", (x) => !!findEdge(this.#doc, x)) : null;
    const reverseId =
      chainFrom && this.doubleWay
        ? this.#freshId("e", (x) => x === forwardId || !!findEdge(this.#doc, x))
        : null;
    const ok = this.#commit((d) => {
      let next = addNode(d, layoutId, created);
      if (chainFrom && forwardId) {
        next = addEdge(next, layoutId, {
          edgeId: forwardId,
          startNodeId: chainFrom,
          endNodeId: nodeId,
          vehicleTypeEdgeProperties: this.#newEdgeProps(),
        });
        if (reverseId) {
          next = addEdge(next, layoutId, {
            edgeId: reverseId,
            startNodeId: nodeId,
            endNodeId: chainFrom,
            vehicleTypeEdgeProperties: this.#newEdgeProps(),
          });
        }
      }
      return next;
    });
    if (ok) {
      this.selection = { kind: "node", id: nodeId };
    }
  };

  #defaultVehicleType(): string {
    return (
      this.vehicleProfile?.vehicleTypeId ||
      this.vehicleTypeFilter ||
      this.#vehicleTypes[0] ||
      "vehicle-type-1"
    );
  }

  /** Profile defaults for new edge properties (without the type id). */
  #profileEdgeDefaults(): Partial<Omit<VehicleTypeEdgeProperty, "vehicleTypeId">> {
    const d = this.vehicleProfile?.defaults;
    if (!d) return {};
    const out: Partial<Omit<VehicleTypeEdgeProperty, "vehicleTypeId">> = {};
    if (d.rotationAllowed !== undefined) out.rotationAllowed = d.rotationAllowed;
    if (d.orientationType !== undefined) out.orientationType = d.orientationType;
    if (d.rotationAtStartNodeAllowed !== undefined) out.rotationAtStartNodeAllowed = d.rotationAtStartNodeAllowed;
    if (d.rotationAtEndNodeAllowed !== undefined) out.rotationAtEndNodeAllowed = d.rotationAtEndNodeAllowed;
    if (d.maxSpeed !== undefined) out.maxSpeed = d.maxSpeed;
    if (d.maxRotationSpeed !== undefined) out.maxRotationSpeed = d.maxRotationSpeed;
    if (d.minHeight !== undefined) out.minHeight = d.minHeight;
    if (d.maxHeight !== undefined) out.maxHeight = d.maxHeight;
    if (d.reentryAllowed !== undefined) out.reentryAllowed = d.reentryAllowed;
    return out;
  }

  #newEdgeProps(): VehicleTypeEdgeProperty[] {
    return [
      {
        vehicleTypeId: this.#defaultVehicleType(),
        rotationAllowed: false,
        ...this.#profileEdgeDefaults(),
      },
    ];
  }

  #onNodePointer = (ev: CustomEvent<LifNodePointerDetail>): void => {
    if (this.tool !== "select") return;
    const { phase, nodeId, x, y } = ev.detail;
    if (phase === "start") {
      this.#dragDoc = structuredClone(this.#doc);
      this.#dragMoved = false;
      this.selection = { kind: "node", id: nodeId };
      return;
    }
    if (!this.#dragDoc) return;
    const node = findNode(this.#dragDoc, nodeId)?.node;
    if (!node) return;
    if (phase === "move") {
      this.#dragMoved = true;
      node.nodePosition.x = roundMm(x);
      node.nodePosition.y = roundMm(y);
      this.requestUpdate();
      this.#viewer?.requestUpdate();
      return;
    }
    // phase === "end"
    const moved = this.#dragMoved;
    const finalX = roundMm(x);
    const finalY = roundMm(y);
    this.#dragDoc = null;
    this.#dragMoved = false;
    if (moved) {
      this.#commit((d) => moveNode(d, nodeId, finalX, finalY));
    } else {
      this.requestUpdate();
    }
  };

  #deleteSelection = (): void => {
    const sel = this.selection;
    if (!sel) return;
    const op =
      sel.kind === "node"
        ? (d: Lif) => removeNode(d, sel.id)
        : sel.kind === "edge"
          ? (d: Lif) => removeEdge(d, sel.id)
          : (d: Lif) => removeStation(d, sel.id);
    if (this.#commit(op)) this.selection = null;
  };

  #applyJson = (): void => {
    const sel = this.selection;
    if (!sel || this.jsonDraft === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.jsonDraft);
    } catch (e) {
      this.jsonError = `Invalid JSON: ${(e as Error).message}`;
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.jsonError = "The element must be a JSON object";
      return;
    }
    const op =
      sel.kind === "node"
        ? (d: Lif) => replaceNode(d, sel.id, parsed as LifNode)
        : sel.kind === "edge"
          ? (d: Lif) => replaceEdge(d, sel.id, parsed as LifEdge)
          : (d: Lif) => replaceStation(d, sel.id, parsed as Station);
    if (!this.#commit(op)) {
      // e.g. the id was changed inside the JSON (replace requires it unchanged).
      this.jsonError = this.#lastCommitError;
    }
  };

  #newDocument = (): void => {
    this.#doc = createEmptyLif();
    this.#resetForNewDocument([]);
  };

  #onFileChosen = async (ev: Event): Promise<void> => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) await this.#importFile(file);
  };

  #onDrop = async (ev: DragEvent): Promise<void> => {
    ev.preventDefault();
    const file = ev.dataTransfer?.files?.[0];
    if (file) await this.#importFile(file);
  };

  async #importFile(file: File): Promise<void> {
    try {
      this.loadJson(await file.text());
    } catch (e) {
      this.jsonError = (e as Error).message;
      this.requestUpdate();
    }
  }

  #download = (): void => {
    const name = (this.#doc.metaInformation.projectIdentification || "layout")
      .replace(/[^\w.-]+/g, "_")
      .toLowerCase();
    const blob = new Blob([this.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.lif.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
}

/** Millimetre precision is plenty for interactively placed geometry. */
function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000;
}

customElements.define("lif-editor", LifEditor);

declare global {
  interface HTMLElementTagNameMap {
    "lif-editor": LifEditor;
  }
}
