/**
 * <lif-fleet-panel> — fleet list for master-control UIs: search,
 * status-sorted rows (problems first), battery/order at a glance, and
 * click-to-follow. Composable: assign the same `vehicles` array you give the
 * viewer, and point `.viewer` at a <lif-viewer> to let the panel drive its
 * selection, centring and follow mode. Without a viewer reference the panel
 * only emits events (`lif-select`) and hides the follow buttons.
 *
 * Rows are protocol-agnostic: `FleetVehicle` is the display contract, and the
 * vda5050 module's `Vda5050Vehicle` satisfies it structurally.
 */

import { css, html, LitElement, nothing, unsafeCSS, type TemplateResult } from "lit";
import type { LifVehicle, LifViewer } from "./lif-viewer";
import { icons } from "./icons";
import { STATUS_COLORS } from "./status-colors";

export interface FleetVehicleError {
  errorType: string;
  errorLevel?: string;
  errorDescription?: string;
}

/** Superset of LifVehicle the panel can display; all extras optional. */
export interface FleetVehicle extends LifVehicle {
  /** Percent, 0–100. */
  batteryCharge?: number;
  charging?: boolean;
  driving?: boolean;
  paused?: boolean;
  operatingMode?: string;
  orderId?: string;
  lastNodeId?: string;
  errors?: FleetVehicleError[];
}

/** Rendered row cap — beyond it the footer says how many were hidden. */
const MAX_ROWS = 200;
const STATUS_RANK: Record<string, number> = { error: 0, warning: 1, offline: 2 };

export class LifFleetPanel extends LitElement {
  static properties = {
    vehicles: { attribute: false },
    selectedId: { type: String, attribute: "selected-id" },
    theme: { type: String, reflect: true },
    query: { state: true },
  };

  declare vehicles: FleetVehicle[];
  /** Highlighted row (controlled, like the viewer's selection). */
  declare selectedId: string | null;
  /** "light" (default) or "dark" — selected token sets, not an automatic flip. */
  declare theme: "light" | "dark";
  declare query: string;

  #viewer: LifViewer | null = null;
  #onFollowChange = (): void => {
    this.requestUpdate();
  };

  /** Viewer this panel drives (selection, centring, follow). */
  get viewer(): LifViewer | null {
    return this.#viewer;
  }

  set viewer(value: LifViewer | null) {
    if (value === this.#viewer) return;
    this.#viewer?.removeEventListener("lif-follow-change", this.#onFollowChange);
    this.#viewer = value ?? null;
    // A disconnected panel must not hold a live subscription on the viewer
    // (it would keep a discarded panel referenced); connectedCallback adds it.
    if (this.isConnected) {
      this.#viewer?.addEventListener("lif-follow-change", this.#onFollowChange);
    }
    this.requestUpdate();
  }

  constructor() {
    super();
    this.vehicles = [];
    this.selectedId = null;
    this.theme = "light";
    this.query = "";
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.#viewer?.addEventListener("lif-follow-change", this.#onFollowChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#viewer?.removeEventListener("lif-follow-change", this.#onFollowChange);
  }

  #rows(): FleetVehicle[] {
    const q = this.query.trim().toLowerCase();
    return this.vehicles
      .filter(
        (v) =>
          !q ||
          [v.vehicleId, v.label, v.orderId].some((s) => s?.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const ra = STATUS_RANK[a.status ?? ""] ?? 3;
        const rb = STATUS_RANK[b.status ?? ""] ?? 3;
        return ra !== rb ? ra - rb : a.vehicleId.localeCompare(b.vehicleId);
      });
  }

  #select(v: FleetVehicle): void {
    if (this.#viewer) {
      this.#viewer.selectedId = v.vehicleId;
      this.#viewer.selectedKind = "vehicle";
      // Centring is an explicit reframe and would end an active follow of
      // this same vehicle — skip it in that case.
      if (this.#viewer.followVehicleId !== v.vehicleId) this.#viewer.centerOn(v.x, v.y);
    }
    this.dispatchEvent(
      new CustomEvent("lif-select", {
        detail: { kind: "vehicle", id: v.vehicleId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #toggleFollow(v: FleetVehicle, ev: Event): void {
    ev.stopPropagation();
    if (!this.#viewer) return;
    const following = this.#viewer.followVehicleId === v.vehicleId;
    this.#viewer.followVehicleId = following ? null : v.vehicleId;
    if (!following) {
      // Starting a follow selects the vehicle — announce it exactly like a
      // row click so hosts mirroring selection stay in sync.
      this.#viewer.selectedId = v.vehicleId;
      this.#viewer.selectedKind = "vehicle";
      this.dispatchEvent(
        new CustomEvent("lif-select", {
          detail: { kind: "vehicle", id: v.vehicleId },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  #renderRow(v: FleetVehicle): TemplateResult {
    const status = v.status ?? "ok";
    const selected = this.selectedId === v.vehicleId;
    const following = this.#viewer?.followVehicleId === v.vehicleId;
    const firstError = v.errors?.find((e) => e.errorDescription) ?? v.errors?.[0];
    const sub = firstError
      ? (firstError.errorDescription ?? firstError.errorType)
      : (v.orderId ?? (v.charging ? "Charging" : v.driving ? "Driving" : ""));
    return html`<li class="row ${selected ? "selected" : ""}" part="row">
      <button class="main" data-vehicle-id=${v.vehicleId} @click=${() => this.#select(v)}>
        <span class="status ${status}" role="img" aria-label=${`status: ${status}`}
          >${status === "warning" || status === "error" ? "!" : ""}</span
        >
        <span class="who">
          <span class="label">${v.label ?? v.vehicleId}</span>
          ${sub
            ? html`<span class="sub ${firstError ? `sub-${status}` : ""}">${sub}</span>`
            : nothing}
        </span>
        ${v.batteryCharge !== undefined
          ? html`<span
              class="battery"
              title=${v.charging ? "Battery (charging)" : "Battery"}
              >${v.charging ? icons.bolt() : nothing}${Math.round(v.batteryCharge)}%</span
            >`
          : nothing}
      </button>
      ${this.#viewer
        ? html`<button
            class="follow ${following ? "on" : ""}"
            title=${following ? "Stop following" : "Follow on the map"}
            aria-pressed=${following ? "true" : "false"}
            @click=${(ev: Event) => this.#toggleFollow(v, ev)}
          >
            ${icons.target()}
          </button>`
        : nothing}
    </li>`;
  }

  protected render(): TemplateResult {
    const rows = this.#rows();
    const shown = rows.slice(0, MAX_ROWS);
    const total = this.vehicles.length;
    const errors = this.vehicles.filter((v) => v.status === "error").length;
    const warnings = this.vehicles.filter((v) => v.status === "warning").length;
    const offline = this.vehicles.filter((v) => v.status === "offline").length;
    return html`
      <header part="header">
        <span class="title">Fleet</span>
        <span class="counts">
          ${total} vehicle${total === 1 ? "" : "s"}
          ${errors ? html` · <span class="c-error">${errors} error${errors === 1 ? "" : "s"}</span>` : nothing}
          ${warnings
            ? html` · <span class="c-warning">${warnings} warning${warnings === 1 ? "" : "s"}</span>`
            : nothing}
          ${offline ? html` · <span class="c-offline">${offline} offline</span>` : nothing}
        </span>
      </header>
      <input
        part="search"
        type="search"
        placeholder="Search vehicles…"
        aria-label="Search vehicles"
        .value=${this.query}
        @input=${(ev: Event) => {
          this.query = (ev.target as HTMLInputElement).value;
        }}
      />
      <ul part="list" aria-label="Vehicles">
        ${shown.map((v) => this.#renderRow(v))}
      </ul>
      ${rows.length > shown.length
        ? html`<p class="more">…and ${rows.length - shown.length} more — refine the search</p>`
        : nothing}
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
      --_selection: var(--lif-selection-color, #4a3aa7);
      display: flex;
      flex-direction: column;
      min-height: 120px;
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
      --_selection: var(--lif-selection-color, #9085e9);
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px 6px;
    }
    .title {
      font-weight: 600;
    }
    .counts {
      color: var(--_ink-2);
      font-size: 12px;
      text-align: right;
    }
    /* Status counts stay in ink; the per-row icons carry the color. */
    .c-error,
    .c-warning {
      font-weight: 600;
    }
    input[type="search"] {
      margin: 0 12px 8px;
      padding: 5px 8px;
      border: 1px solid var(--_border);
      border-radius: 6px;
      background: var(--_overlay);
      color: inherit;
      font: inherit;
      font-size: 12px;
    }
    input[type="search"]:focus-visible {
      outline: 2px solid var(--_accent);
      outline-offset: 1px;
    }
    ul {
      flex: 1;
      overflow-y: auto;
      margin: 0;
      padding: 0 6px 6px;
      list-style: none;
    }
    .row {
      display: flex;
      align-items: stretch;
      border-radius: 6px;
    }
    .row.selected {
      background: var(--_overlay);
      box-shadow: inset 2px 0 0 var(--_selection);
    }
    .row:hover {
      background: var(--_overlay);
    }
    .row button {
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 6px;
    }
    .row button:focus-visible {
      outline: 2px solid var(--_accent);
      outline-offset: -2px;
      border-radius: 6px;
    }
    .main {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      text-align: left;
    }
    /* Fixed status palette (never themed); glyph + aria carry the meaning. */
    .status {
      flex: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
    }
    .status.ok {
      background: ${unsafeCSS(STATUS_COLORS.good)};
    }
    .status.warning {
      background: ${unsafeCSS(STATUS_COLORS.warning)};
      color: #1c1b19;
    }
    .status.error {
      background: ${unsafeCSS(STATUS_COLORS.error)};
      color: #ffffff;
    }
    .status.offline {
      background: var(--_muted);
      opacity: 0.55;
    }
    .who {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub {
      font-size: 11px;
      color: var(--_muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub.sub-error,
    .sub.sub-warning {
      color: var(--_ink-2);
      font-weight: 500;
    }
    .battery {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 2px;
      color: var(--_ink-2);
      font-variant-numeric: tabular-nums;
      font-size: 12px;
    }
    .battery svg {
      width: 12px;
      height: 12px;
    }
    .follow {
      flex: none;
      display: inline-flex;
      align-items: center;
      color: var(--_muted);
    }
    .follow:hover {
      color: var(--_ink);
    }
    .follow.on {
      color: var(--_accent);
    }
    .follow svg {
      width: 15px;
      height: 15px;
    }
    .more {
      margin: 0;
      padding: 6px 12px 10px;
      color: var(--_muted);
      font-size: 12px;
    }
  `;
}

customElements.define("lif-fleet-panel", LifFleetPanel);

declare global {
  interface HTMLElementTagNameMap {
    "lif-fleet-panel": LifFleetPanel;
  }
}
