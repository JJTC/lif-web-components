/**
 * lif-web-components/mc — master-control-side components, kept out
 * of the main entry so viewer-only and on-vehicle consumers don't grow their
 * bundles. Importing this module registers <lif-fleet-panel> and
 * <lif-workspace>. Import the main entry ("lif-web-components") alongside it:
 * these components pair with — and the workspace stacks — <lif-viewer>,
 * which only the main entry registers.
 */

export {
  LifFleetPanel,
  type FleetVehicle,
  type FleetVehicleError,
} from "../components/lif-fleet-panel";
export {
  LifWorkspace,
  type LayerMergeSummary,
  type WorkspaceSource,
} from "../components/lif-workspace";
