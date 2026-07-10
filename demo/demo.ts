import "../src/index";
import "../src/mc";
import type { LifEditor, LifVehicle, LifViewer, Lif, VehicleProfile } from "../src/index";
import type { FleetVehicle, LifFleetPanel, LifWorkspace } from "../src/mc";
import warehouse from "../fixtures/warehouse.lif.json";

const editor = document.querySelector<LifEditor>("#editor")!;
const hmiViewer = document.querySelector<LifViewer>("#hmi-viewer")!;
const viewer = document.querySelector<LifViewer>("#viewer")!;
const fleet = document.querySelector<LifFleetPanel>("#fleet")!;
const workspace = document.querySelector<LifWorkspace>("#workspace")!;
const mergeNote = document.querySelector<HTMLElement>("#merge-note")!;
const mcEditor = document.querySelector<LifEditor>("#mc-editor")!;
fleet.viewer = viewer; // the panel drives selection, centring and follow

// Master-control review posture: no vehicle profile — the types
// manager and all-types property forms carry the experience; checks open so
// the LIF-A network analysis is immediately visible.
mcEditor.lif = structuredClone(warehouse) as unknown as Lif;
mcEditor.showDiagnostics = true;

// On-vehicle setup: the vehicle describes itself; the editor uses
// this for creation defaults, the single-type property form and the action palette.
const profile: VehicleProfile = {
  vehicleTypeId: "acme.tugger",
  defaults: { rotationAllowed: false, maxSpeed: 1.2 },
  limits: { maxSpeed: 1.8, maxRotationSpeed: 1.0, minHeight: 0.05, maxHeight: 2.0 },
  supportedActions: [
    { actionType: "pick", description: "Pick up a load", defaultRequirementType: "CONDITIONAL", defaultBlockingType: "HARD" },
    { actionType: "drop", description: "Drop the load", defaultRequirementType: "CONDITIONAL", defaultBlockingType: "HARD" },
    { actionType: "startCharging", scopes: ["NODE"], defaultRequirementType: "CONDITIONAL", defaultBlockingType: "HARD" },
    { actionType: "stopCharging", scopes: ["NODE"], defaultRequirementType: "CONDITIONAL", defaultBlockingType: "HARD" },
    { actionType: "beep", description: "Acoustic warning", defaultRequirementType: "OPTIONAL", defaultBlockingType: "NONE" },
  ],
};
editor.vehicleProfile = profile;

editor.lif = warehouse as unknown as Lif;
hmiViewer.lif = editor.lif;
viewer.lif = editor.lif;

editor.addEventListener("lif-change", (ev) => {
  const lif = (ev as CustomEvent<{ lif: Lif }>).detail.lif;
  hmiViewer.lif = lif;
  viewer.lif = lif;
});
hmiViewer.addEventListener("lif-select", (ev) => {
  hmiViewer.selectedId = (ev as CustomEvent<{ id: string | null }>).detail.id;
});

// Master-control workspace: the warehouse handover plus a small
// "Annex" fragment from a second integrator — its frame is offset (the hall
// really sits east of the aisle) and its dock id collides on purpose.
const annex: Lif = {
  metaInformation: {
    projectIdentification: "Annex hall",
    creator: "Integrator B",
    exportTimestamp: "2026-07-09T00:00:00Z",
    lifVersion: "1.0.0",
  },
  layouts: [
    {
      layoutId: "annex-floor",
      layoutVersion: "1",
      nodes: [
        {
          nodeId: "n-dock", // collides with the warehouse dock → prefixed on merge
          nodeName: "Annex dock",
          nodePosition: { x: 0, y: 8 },
          vehicleTypeNodeProperties: [{ vehicleTypeId: "acme.tugger" }],
        },
        {
          nodeId: "n-annex-mid",
          nodeName: "Annex mid",
          nodePosition: { x: 4, y: 8 },
          vehicleTypeNodeProperties: [{ vehicleTypeId: "acme.tugger" }],
        },
        {
          nodeId: "n-annex-buf",
          nodeName: "Annex buffer",
          nodePosition: { x: 4, y: 11 },
          vehicleTypeNodeProperties: [{ vehicleTypeId: "acme.tugger" }],
        },
      ],
      edges: [
        {
          edgeId: "e-annex-1",
          startNodeId: "n-dock",
          endNodeId: "n-annex-mid",
          vehicleTypeEdgeProperties: [{ vehicleTypeId: "acme.tugger", rotationAllowed: true }],
        },
        {
          edgeId: "e-annex-2",
          startNodeId: "n-annex-mid",
          endNodeId: "n-dock",
          vehicleTypeEdgeProperties: [{ vehicleTypeId: "acme.tugger", rotationAllowed: true }],
        },
        {
          edgeId: "e-annex-3",
          startNodeId: "n-annex-mid",
          endNodeId: "n-annex-buf",
          vehicleTypeEdgeProperties: [{ vehicleTypeId: "acme.tugger", rotationAllowed: true }],
        },
        {
          edgeId: "e-annex-4",
          startNodeId: "n-annex-buf",
          endNodeId: "n-annex-mid",
          vehicleTypeEdgeProperties: [{ vehicleTypeId: "acme.tugger", rotationAllowed: true }],
        },
      ],
      stations: [],
    },
  ],
};
workspace.sources = [
  { sourceId: "warehouse", label: "Warehouse (integrator A)", lif: structuredClone(warehouse) as unknown as Lif },
  { sourceId: "annex", label: "Annex (integrator B)", lif: annex },
];
workspace.addEventListener("lif-merge", (ev) => {
  const { lif, summary } = (ev as CustomEvent<{
    lif: Lif;
    summary: { sourceId: string; prefix: string | null; mergedIntoLayout: string | null }[];
  }>).detail;
  viewer.lif = lif; // hand the master layout to the fleet view above…
  mcEditor.lif = structuredClone(lif); // …and to the review editor below
  const notes = summary.map(
    (s) =>
      `${s.sourceId}${s.prefix ? ` (ids prefixed "${s.prefix}")` : ""}${
        s.mergedIntoLayout ? ` → ${s.mergedIntoLayout}` : ""
      }`,
  );
  const ground = lif.layouts.find((l) => l.layoutId === "ground");
  mergeNote.textContent =
    `merged ${notes.join(", ")} — ${ground?.nodes.length ?? "?"} nodes on "ground", ` +
    `provenance in x-mergedSources; loaded into the fleet view and the review editor`;
});

// Standalone viewers manage their own selection; keep the panel in sync.
viewer.addEventListener("lif-select", (ev) => {
  const detail = (ev as CustomEvent<{ id: string | null }>).detail;
  viewer.selectedId = detail.id;
  fleet.selectedId = detail.id;
});
fleet.addEventListener("lif-select", (ev) => {
  fleet.selectedId = (ev as CustomEvent<{ id: string | null }>).detail.id;
});

// Toy fleet: two AGVs shuttling along the ground-floor aisle. A real
// application would assign `viewer.vehicles` from its VDA 5050 state feed
// the same way.
const route = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 12, y: 0 },
  { x: 16, y: 0 },
  { x: 12, y: 0 },
  { x: 4, y: 0 },
];

function routePose(step: number): { x: number; y: number; theta: number } {
  const from = route[step % route.length]!;
  const to = route[(step + 1) % route.length]!;
  return { x: to.x, y: to.y, theta: Math.atan2(to.y - from.y, to.x - from.x) };
}

// On-vehicle live view (section 1): the vehicle itself, plus any neighbour it
// hears about within range — in its own read-only viewer, started on demand.
const hmiSimButton = document.querySelector<HTMLButtonElement>("#hmi-sim")!;
let hmiTimer: ReturnType<typeof setInterval> | null = null;
let hmiStep = 0;

function hmiTick(): void {
  hmiStep++;
  const self: LifVehicle = {
    vehicleId: "this-vehicle",
    label: "This vehicle",
    ...routePose(hmiStep),
    mapId: "map-ground",
    vehicleTypeId: "acme.tugger",
  };
  const neighbour: LifVehicle = {
    vehicleId: "agv-7",
    label: "AGV 7",
    ...routePose(hmiStep + 3),
    mapId: "map-ground",
  };
  const inRange = Math.hypot(neighbour.x - self.x, neighbour.y - self.y) <= 6;
  hmiViewer.vehicles = inRange ? [self, neighbour] : [self];
}

hmiSimButton.addEventListener("click", () => {
  if (hmiTimer !== null) {
    clearInterval(hmiTimer);
    hmiTimer = null;
    hmiViewer.vehicles = [];
    hmiSimButton.textContent = "▶ Simulate drive";
    return;
  }
  hmiTick();
  hmiTimer = setInterval(hmiTick, 900);
  hmiSimButton.textContent = "⏹ Stop simulation";
});
const simButton = document.querySelector<HTMLButtonElement>("#sim")!;
let simTimer: ReturnType<typeof setInterval> | null = null;
let simStep = 0;

function simTick(): void {
  simStep++;
  const vehicles = [0, 3].map((offset, i): FleetVehicle => {
    return {
      vehicleId: `agv-${i + 1}`,
      ...routePose(simStep + offset),
      mapId: "map-ground",
      driving: true,
      batteryCharge: i === 0 ? 82 : 47,
      // The second AGV carries a warning so the status pipeline is visible.
      ...(i === 1 && {
        status: "warning" as const,
        errors: [
          {
            errorType: "lidarContamination",
            errorLevel: "WARNING",
            errorDescription: "LiDAR window needs cleaning",
          },
        ],
      }),
    };
  });
  viewer.vehicles = vehicles;
  fleet.vehicles = vehicles;
}

simButton.addEventListener("click", () => {
  if (simTimer !== null) {
    clearInterval(simTimer);
    simTimer = null;
    viewer.vehicles = [];
    fleet.vehicles = [];
    viewer.routes = [];
    simButton.textContent = "▶ Simulate vehicles";
    return;
  }
  // The first AGV's current order: committed to the east aisle,
  // charging leg still in the planning horizon.
  viewer.routes = [
    {
      routeId: "order-42",
      vehicleId: "agv-1",
      stops: [
        { nodeId: "n-dock", actions: ["pick"] },
        { nodeId: "n-aisle-w" },
        { nodeId: "n-aisle-e", actions: ["drop"] },
        { nodeId: "n-charge", released: false, actions: ["startCharging"] },
      ],
      edgeIds: ["e-dock-west", "e-west-east", "e-east-charge"],
    },
  ];
  simTick();
  simTimer = setInterval(simTick, 900);
  simButton.textContent = "⏹ Stop simulation";
});

// Theme toggle: one switch drives the page and both components.
const themeButton = document.querySelector<HTMLButtonElement>("#theme")!;
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  editor.theme = theme;
  hmiViewer.theme = theme;
  viewer.theme = theme;
  fleet.theme = theme;
  workspace.theme = theme;
  mcEditor.theme = theme;
  themeButton.textContent = theme === "dark" ? "Light theme" : "Dark theme";
}
themeButton.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
);
applyTheme("dark");
