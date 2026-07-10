/**
 * lif-web-components/vda5050 — optional pure helpers mapping VDA 5050 runtime
 * messages (the AGV ⇄ master-control protocol) onto the components' runtime
 * types. Contains no MQTT or transport code: subscribe with any
 * client and map each payload here.
 */

export * from "./types";
export * from "./map";
