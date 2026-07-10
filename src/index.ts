/**
 * lif-web-components — MIT-licensed web components for viewing and editing
 * VDMA LIF (Layout Interchange Format 1.0.0) track layouts.
 *
 * Importing this module registers the <lif-viewer> and <lif-editor> custom
 * elements. The dependency-free core (parse/validate/serialize/geometry/
 * operations) is re-exported and also available standalone via "./lif".
 */

export * from "./lif";
export {
  LifViewer,
  type LifBackground,
  type LifSelectDetail,
  type LifNodePointerDetail,
  type LifRoute,
  type LifRouteStop,
  type LifVehicle,
  type MeasureMode,
  type RenderedVehicle,
  type VehicleStatus,
} from "./components/lif-viewer";
export {
  LifEditor,
  type SupportedAction,
  type VehicleProfile,
} from "./components/lif-editor";
