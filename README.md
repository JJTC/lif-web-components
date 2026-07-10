# LIF Web Components

Web components for **viewing and editing VDMA LIF** (Layout
Interchange Format 1.0.0) track layouts — the JSON format vehicle integrators
use to hand AGV track layouts to a (third-party) master control system,
complementary to VDA 5050.

- `<lif-viewer>` — renders a LIF layout as SVG: nodes (with orientation ticks),
  directed edges (including NURBS trajectories), stations with their
  interaction-node links, pan/zoom, layout (level) tabs, vehicle-type
  filtering, hover and selection — plus a metric grid with rulers,
  map controls (zoom/fit, fullscreen, and a display-filter popover:
  grid with nested rulers, nodes, edges, trajectories, stations, labels — in
  the editor the fullscreen button expands the whole editor via the viewer's
  `fullscreenTarget` property), a measure mode
  (polyline lengths and polygon areas with per-segment labels), per-layout
  background maps (e.g. from a vehicle's SLAM pipeline), and a live
  vehicle overlay for real-time fleet display — canvas-rendered with
  viewport culling and level-of-detail, smooth at 10,000 vehicles.
- `<lif-editor>` — full editing on top of the viewer, tuned for an on-vehicle
  HMI: a floating tool palette inside the map view (select,
  node/edge/station creation with chained placement and double-way
  edges, measuring, grid generation, undo/redo/delete), stations with marker
  positions,
  layout management with background-map calibration, element search,
  a properties panel with a raw-JSON escape hatch, live validation with
  precise diagnostics, a status bar, snapshot undo/redo, and import/export of
  `.lif.json` files. For the fleet side: a vehicle types
  manager (derived roster with document-wide rename/remove/complete and
  coverage counts), multi-type property forms on every node/edge, and
  per-type network analysis (coverage gaps, disconnected sub-networks,
  one-way traps) in the checks panel.
- `src/lif/` — the dependency-free core underneath: types, a lenient parser
  with diagnostics, a semantic validator, per-type network analysis and
  shortest-path routing, a lossless serializer, NURBS evaluation and pure
  editing operations. Usable headless (Bun, Node, browser).
- `<lif-fleet-panel>` (`lif-web-components/mc`) — the first
  master-control component: a fleet list with problems-first sorting, search,
  battery/order/error details, and click-to-follow on a paired viewer.
- `<lif-workspace>` (`lif-web-components/mc`) — the multi-LIF
  workspace: one document per vehicle integrator as stacked, tinted,
  view-synchronized layers; align each onto the base frame (Δx/Δy/θ with
  live preview), then merge — colliding ids auto-prefixed, aligned
  layouts united with the base level, provenance recorded in
  `metaInformation["x-mergedSources"]`.
- `src/vda5050/` — optional, dependency-free helpers for VDA 5050 feeds
  (the runtime protocol between AGVs and a master control): a typed subset of
  the 2.x messages plus pure mappers onto the components' runtime types. No
  MQTT/transport code — bring your own client.

## Usage

```html
<script type="module">
  import "lif-web-components"; // registers <lif-viewer> and <lif-editor>
</script>

<lif-editor id="editor" style="height: 70vh"></lif-editor>

<script type="module">
  import { parseLif } from "lif-web-components";

  const editor = document.querySelector("#editor");
  const text = await (await fetch("plant.lif.json")).text();
  editor.loadJson(text);                       // lenient import, returns diagnostics
  editor.addEventListener("lif-change", (ev) => {
    console.log("edited document", ev.detail.lif);
  });
  // editor.exportJson() → serialized LIF with a fresh exportTimestamp
</script>
```

Read-only viewing:

```html
<lif-viewer id="viewer" style="height: 50vh"></lif-viewer>
<script type="module">
  import { parseLif } from "lif-web-components";
  const viewer = document.querySelector("#viewer");
  viewer.lif = parseLif(text).lif;
  viewer.addEventListener("lif-select", (ev) => {
    viewer.selectedId = ev.detail.id;          // selection is controlled by you
  });
</script>
```

Live vehicles (real-time fleet display):

```ts
// LIF itself carries no runtime state; live poses come from your VDA 5050
// state feed (agvPosition uses the same coordinate convention). The viewer is
// transport-agnostic — assign `vehicles` on every update and it animates
// markers toward each new pose (linear tween over `vehicleTransitionMs`,
// default 800 ms; shortest-arc for theta).
mqttFeed.onState((state) => {
  viewer.vehicles = fleet.map((s) => ({
    vehicleId: s.serialNumber,
    x: s.agvPosition.x,
    y: s.agvPosition.y,
    theta: s.agvPosition.theta,
    mapId: s.agvPosition.mapId, // shows the vehicle on layouts using that map
  }));
});
```

Vehicles are hit-testable (`lif-select` fires with kind `"vehicle"`), respect
the vehicle-type filter via an optional `vehicleTypeId`, can be pinned to a
layout with `layoutId`, and never appear in exported LIF JSON. The demo page
has a "Simulate vehicles" button showing the overlay in motion.

Vehicles draw on a dedicated canvas layer (shadow part `vehicle-layer`)
above the SVG scene, with viewport culling and zoom-dependent level of detail
(full oriented markers with labels when close, dots at overview zoom) —
animation frames never touch the DOM, so fleets of 10,000 vehicles animate
at the display refresh rate.
`viewer.getRenderedVehicles()` returns what is currently drawn (id, screen
position, rotation, LOD, selection, status) for tooltips or custom overlays.

Each vehicle may carry a `status` (`"ok" | "warning" | "error" | "offline"`):
warning/error add a status badge to the marker (reserved status palette
with a glyph — color never carries meaning alone) and offline dims it. The
viewer can also follow a vehicle: set `followVehicleId` and the view
re-centres every animation frame (smooth through pose tweens); a manual pan,
`fitView()` or `centerOn()` ends following and emits `lif-follow-change`.

Fleet monitoring UI (master control):

```html
<lif-viewer id="viewer" style="flex: 1"></lif-viewer>
<lif-fleet-panel id="fleet" style="width: 280px"></lif-fleet-panel>
<script type="module">
  import "lif-web-components";
  import "lif-web-components/mc"; // registers <lif-fleet-panel>
  import { stateToVehicle } from "lif-web-components/vda5050";

  fleet.viewer = viewer; // panel drives selection, centring and follow
  mqttFeed.onState((states) => {
    const vehicles = states.map((s) => stateToVehicle(s)).filter((v) => v !== null);
    viewer.vehicles = vehicles;
    fleet.vehicles = vehicles; // battery, orders and errors ride along
  });
</script>
```

The panel sorts problems first (error → warning → offline), searches across
id/label/order, shows battery and the first error description per row, and
its crosshair button toggles follow mode on the paired viewer. Rows cap at
200 with an explicit "…and N more" footer — never a silent truncation.

Routes and orders — a second runtime overlay, `viewer.routes`:
committed (base) legs render solid, horizon legs dashed, stops with actions
get count badges, and legs referencing an edge follow its drawn geometry
including NURBS trajectories. Cross-layout orders show each layout's own
legs. `orderToRoute` converts a VDA 5050 order message directly:

```ts
import { orderToRoute } from "lif-web-components/vda5050";
import { shortestRoute } from "lif-web-components/lif";

mqttFeed.onOrder((order) => {
  viewer.routes = [orderToRoute(order)];
});

// Planning: can this type get there, and which way? (Dijkstra over the
// type's usable sub-network; costs = trajectory/straight-line metres.)
const route = shortestRoute(lif, "acme.tugger", "n-dock", "n-buf-b");
// → { nodeIds, edgeIds, length } or null when unreachable
if (route) {
  viewer.routes = [{ routeId: "preview", stops: route.nodeIds.map((nodeId) => ({ nodeId })), edgeIds: route.edgeIds }];
}
```

Combining integrator handovers:

```html
<lif-workspace id="ws" style="height: 70vh"></lif-workspace>
<script type="module">
  import "lif-web-components"; // the workspace stacks <lif-viewer> layers
  import "lif-web-components/mc"; // registers <lif-workspace> (and the fleet panel)

  ws.sources = [
    { sourceId: "hall-a", label: "Hall A (integrator A)", lif: lifA }, // first = base frame
    { sourceId: "hall-b", label: "Hall B (integrator B)", lif: lifB },
  ];
  ws.addEventListener("lif-merge", (ev) => {
    editor.lif = ev.detail.lif; // verify with validation + network analysis, then export
    console.log(ev.detail.summary); // e.g. [{ sourceId: "hall-b", prefix: "hall-b:", mergedIntoLayout: "ground" }]
  });
</script>
```

The pure ops behind it — `transformLif` (rigid-body; rotates positions,
trajectories and absolute orientations), `prefixLifIds`, `collectIdCollisions`
and `mergeLif` — live in the headless core for scripted pipelines.

Vehicle profile (on-vehicle mode) — the vehicle describes itself and
the editor turns that into creation defaults, a single-type property form with
limit warnings, and an action palette:

```ts
editor.vehicleProfile = {
  vehicleTypeId: "acme.tugger",                       // from the AGV factsheet
  defaults: { rotationAllowed: false, maxSpeed: 1.2 }, // applied to new edges
  limits: { maxSpeed: 1.8, maxHeight: 2.0 },           // form warns beyond these
  supportedActions: [
    { actionType: "pick", scopes: ["NODE"], defaultRequirementType: "CONDITIONAL", defaultBlockingType: "HARD" },
    { actionType: "startCharging", scopes: ["NODE"], defaultBlockingType: "HARD" },
    { actionType: "beep", defaultRequirementType: "OPTIONAL", defaultBlockingType: "NONE" },
  ],
};
```

The properties panel then offers a vehicle section on every node/edge:
enable/disable the vehicle's type, edit θ or the movement fields (rotation,
orientation, speeds, heights, re-entry), and attach actions — the
instructions a master control may send here (`pick`, `drop`, `startCharging`,
…) with requirement/blocking semantics and static parameters. Without a
profile the forms fall back to the document's vehicle type and free-text
action names. Every other vehicle type on the element gets the same full
form in a collapsible section — profile limits and the action
palette apply only to the profile's own type. With nothing selected, the
sidebar shows the Document panel and the types manager — per-type
coverage (`5/6 nodes · 7/8 edges`), inline rename across the document, a map
highlight of the type's coverage, "Complete" to extend a type to all
elements, and confirmed document-wide removal. Both sections have their own
toolbar toggles next to Checks, so any of the three can take the full
sidebar height (e.g. hide Document and Types to review a long checks list). `validateLif`'s spec checks
are complemented by `analyzeLif` (`LIF-A0xx`): per-type coverage gaps,
disconnected sub-networks and one-way traps ("type X can enter n-dock but
not leave") surface live in the checks panel.

VDA 5050 feeds — instead of hand-writing the mapping above, the `/vda5050`
module converts the protocol's messages directly (state and the high-rate
`visualization` pose topic → vehicles; the AGV factsheet → the editor's
vehicle profile):

```ts
import { stateToVehicle, factsheetToVehicleProfile } from "lif-web-components/vda5050";

mqttFeed.onState((states) => {
  // null = AGV not localized yet; extras (battery, errors, order, loads)
  // ride along on each vehicle for your own UI.
  viewer.vehicles = states.map((s) => stateToVehicle(s)).filter((v) => v !== null);
});
editor.vehicleProfile = factsheetToVehicleProfile(factsheet); // on-vehicle variant
```

The master-control side ships as composable additions in this same package:
the fleet panel and multi-LIF workspace (`lif-web-components/mc`, above), the
editor's vehicle types manager and network analysis, and the order/route
overlay — see the sections above.

Background maps (e.g. a ROS Cartographer occupancy grid rendered to PNG):

```ts
// Runtime-only (never exported into LIF). x/y = world position of the
// image's lower-left corner, like a ROS map origin; size = pixels × resolution.
viewer.backgrounds = {
  "ground": { href: mapPngUrl, x: -12.2, y: -7.4, width: 48.6, height: 22.1, opacity: 0.7 },
};
```

Headless core:

```ts
import { parseLif, validateLif, serializeLif, hasErrors } from "lif-web-components/lif";

const { lif, diagnostics } = parseLif(text);   // tolerates known real-world quirks
const findings = [...diagnostics, ...validateLif(lif)];
if (!hasErrors(findings)) console.log(serializeLif(lif));
```

### Coordinates and events

All public APIs speak LIF world coordinates: metres, y-up, angles in
radians with counter-clockwise positive (VDA 5050 conventions). The components
handle the SVG y-flip internally in exactly one place.

Component events (bubbling, composed): `lif-select`, `lif-canvas-click`,
`lif-layout-change`, `lif-view-change`, `lif-follow-change`, `lif-marquee`,
`lif-node-pointer` (viewer), `lif-change` (editor), `lif-merge` (workspace).

### Keyboard shortcuts

Press <kbd>?</kbd> in the editor (or the keyboard button in the status bar)
for the built-in overview. Highlights: <kbd>V</kbd>/<kbd>N</kbd>/<kbd>E</kbd>/<kbd>S</kbd>
select the tools, <kbd>M</kbd> measures, <kbd>D</kbd>/<kbd>C</kbd> toggle
2-way/chain creation, <kbd>G</kbd> the grid, <kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd>
zoom and fit, arrow keys nudge the selected node by 0.1 m (<kbd>Shift</kbd>: 1 m),
<kbd>Ctrl+Z</kbd>/<kbd>Ctrl+Shift+Z</kbd> undo/redo, <kbd>Ctrl+O</kbd>/<kbd>Ctrl+S</kbd>
import/export, <kbd>/</kbd> jumps to search, and <kbd>Esc</kbd> cancels,
closes, or deselects contextually. Bindings never fire while typing in a field.

<kbd>Shift</kbd>+drag draws a marquee: everything inside — on
the current layout — becomes a bulk selection with its own panel: enable or
remove a vehicle type on the selection, merge edge properties (max speed,
rotation) into the chosen type's entries, or delete the lot — each as a
single undo step. Facility-scale documents pan and zoom smoothly regardless
of size: during gestures the scene rides one compositor transform and
re-projects crisply at rest.

### Theming

Both components ship light and dark themes (validated palette in both
modes): `<lif-editor theme="dark">` — the editor propagates its theme to the
embedded viewer and has a toolbar toggle. Every color flows through CSS custom
properties, so brands can restyle without forking: surfaces
(`--lif-surface`, `--lif-surface-raised`, `--lif-surface-overlay`), ink
(`--lif-ink`, `--lif-ink-secondary`, `--lif-ink-muted`, `--lif-border`),
scene roles (`--lif-node-color`, `--lif-edge-color`, `--lif-station-color`,
`--lif-vehicle-color`, `--lif-selection-color`, `--lif-measure-color`,
`--lif-route-color`, `--lif-grid-color`, `--lif-accent`) plus
`--lif-sidebar-width` and `--lif-cursor`. Shadow parts: `canvas`, `scene` (the document content inside
the canvas — e.g. the workspace dims layers through it), `vehicle-layer`,
`tabs`, `toolbar`, `sidebar`, `resizer`, `status`.

The editor's sidebar is resizable: drag the divider (or focus it and use the
arrow keys); double-click resets to the default width
(`--lif-sidebar-width`, 280px unless overridden).

### Validation

`parseLif` accepts anything structurally recognizable and reports everything
else as diagnostics with severity, stable code, JSON path and message — it
also normalizes (with warnings) quirks the official guideline itself exhibits,
such as `stationHeight` serialized as a string, a draft-era `required` boolean
on actions, and missing `stations` arrays. `validateLif` covers the semantic
rules: file-wide ID uniqueness, edge/station referential integrity (including
legal cross-layout transition edges), vehicle-type property uniqueness,
knot-vector arithmetic, value ranges and more.

## The standard

The normative document is **"LIF – Layout Interchange Format", Version 1.0.0
(March 2024)**, published by VDMA Fachverband Fördertechnik und Intralogistik
(vdma.org). It is copyrighted and therefore **not** included in this
repository; obtain it from VDMA. This project re-expresses the format's
interface facts (field names, types, semantics) in its own code, docs and
fixtures.

## Development

Everything runs with [Bun](https://bun.sh). On Fedora
Atomic hosts, use the provided toolbox:

```sh
podman build -t lif-toolbox toolbox/
toolbox create lif-dev --image localhost/lif-toolbox
toolbox run -c lif-dev -- bun install
```

| Command | What it does |
|---|---|
| `bun run dev` | demo server at http://localhost:4173 (rebuilds on refresh, no file watcher) |
| `bun run dev:hmr` | Bun's HMR dev server for the demo — needs a free inotify instance (`fs.inotify.max_user_instances`), which desktop hosts sometimes exhaust |
| `bun test tests/core` | fast core tests (parser/validator/NURBS/operations) |
| `bun run test:browser` | component tests in **real Chromium** (no DOM mocks) |
| `bun run test:all` | both suites |
| `bun run test:dist` | smoke tests over the built bundles (needs `bun run build` first; part of `prepublishOnly`) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | ESM bundles (`dist/index.js` components, `dist/mc.js` master-control components — Lit external; `dist/lif.js` core and `dist/vda5050.js` mappers — dependency-free) plus `.d.ts` type declarations |

Browser tests launch the system Chromium from the toolbox image via
playwright-core and drive real pointer/keyboard input against a real
`Bun.serve()` server. Set `CHROMIUM_BIN` to point at a different
binary if needed.

## License

[MIT](LICENSE). Runtime dependency: Lit (BSD-3-Clause). This project is an
independent implementation and is not affiliated with or endorsed by VDMA
(publisher of LIF) or VDA (publisher of the VDA 5050 specification).
